#!/usr/bin/env node
/**
 * Edgeline relay — your own machine asking Binance for your journal.
 *
 * Binance answers by address. A journal hosted on a shared server gets
 * refused or rate-banned for what the server's neighbours do; your own
 * connection is refused nothing. So this program runs where you are, holds
 * your Binance API key, and keeps one outbound connection open to your
 * journal. Every call the journal would have made to Binance for this
 * account is sent here and made from your address, and your account's
 * live stream of fills and orders is opened here and forwarded. The key
 * never leaves this machine.
 *
 * Needs Node 22 or newer (fetch and WebSocket are built in). No packages.
 *
 *   EDGELINE_URL=https://your-journal.onrender.com \
 *   EDGELINE_RELAY_TOKEN=<from Settings> \
 *   BINANCE_KEY=<api key> BINANCE_SECRET=<secret> \
 *   node edgeline-relay.mjs
 *
 * Optional: BINANCE_ENV=testnet for a futures testnet key.
 * Leave it running — a terminal window, a screen/tmux session, a service.
 */
import { createHmac } from "node:crypto";

const URL_ = (process.env.EDGELINE_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.EDGELINE_RELAY_TOKEN || "";
const KEY = process.env.BINANCE_KEY || "";
const SECRET = process.env.BINANCE_SECRET || "";
const ENV = process.env.BINANCE_ENV === "testnet" ? "testnet" : "live";
// The hosts, overridable so the relay can be run against a stub.
const FUTURES = (process.env.BINANCE_FUTURES_BASE || (ENV === "testnet" ? "https://testnet.binancefuture.com" : "https://fapi.binance.com")).replace(/\/+$/, "");
const SAPI = (process.env.BINANCE_SAPI_BASE || "https://api.binance.com").replace(/\/+$/, "");
const STREAM = (process.env.BINANCE_FUTURES_WS || (ENV === "testnet" ? "wss://fstream.binancefuture.com" : "wss://fstream.binance.com")).replace(/\/+$/, "");

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const die = (m) => {
  console.error(m);
  process.exit(1);
};
if (!URL_ || !TOKEN || !KEY || !SECRET) die("Set EDGELINE_URL, EDGELINE_RELAY_TOKEN, BINANCE_KEY and BINANCE_SECRET.");
if (typeof WebSocket === "undefined" || typeof fetch === "undefined") die("Node 22 or newer is needed (it has fetch and WebSocket built in).");

/* ------------------------------ Binance, signed ------------------------------ */

const encode = (params) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");

/** One signed request. GET/DELETE carry the query; POST/PUT carry it in the body, as the venue reads it. */
async function signed(method, base, path, params = {}) {
  const q = `${encode(params)}${Object.keys(params).length ? "&" : ""}recvWindow=10000&timestamp=${Date.now()}`;
  const sig = createHmac("sha256", SECRET).update(q).digest("hex");
  const full = `${q}&signature=${sig}`;
  const inBody = method === "POST" || method === "PUT";
  const url = inBody ? `${base}${path}` : `${base}${path}?${full}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await fetch(url, {
      method,
      headers: { "X-MBX-APIKEY": KEY, accept: "application/json", ...(inBody ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      body: inBody ? full : undefined,
      signal: ctl.signal,
    });
    return { status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A plain market-data read: no key, no signature, GET only, and only the
 * futures data paths — so the server cannot ask this relay for anything
 * but public numbers this way.
 */
async function publicGet(path, params = {}) {
  if (!/^\/(fapi\/v1\/(klines|premiumIndex|fundingInfo|openInterest|ticker\/24hr|exchangeInfo)|futures\/data\/(takerlongshortRatio|globalLongShortAccountRatio|topLongShortPositionRatio|topLongShortAccountRatio|openInterestHist))$/.test(path)) {
    return { status: 400, body: JSON.stringify({ code: -1, msg: `not a public path: ${path}` }) };
  }
  const q = encode(params);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await fetch(`${FUTURES}${path}${q ? `?${q}` : ""}`, { headers: { accept: "application/json" }, signal: ctl.signal });
    return { status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function unsignedWithKey(method, base, path) {
  const res = await fetch(`${base}${path}`, { method, headers: { "X-MBX-APIKEY": KEY, accept: "application/json" } });
  return { status: res.status, body: await res.text() };
}

/** What the key may do, asked of the venue — so the journal knows whether this account may trade. */
async function describeKey() {
  if (ENV === "testnet") {
    const r = await signed("GET", FUTURES, "/fapi/v2/balance");
    if (r.status !== 200) die(`The testnet did not accept this key: HTTP ${r.status} ${r.body.slice(0, 200)}`);
    return { canTrade: true, reading: true };
  }
  const r = await signed("GET", SAPI, "/sapi/v1/account/apiRestrictions");
  if (r.status !== 200) die(`Binance did not accept this key: HTTP ${r.status} ${r.body.slice(0, 200)}`);
  const j = JSON.parse(r.body);
  if (j.enableWithdrawals) die("This key can withdraw. Make one that cannot.");
  return { canTrade: !!j.enableFutures && !!(j.enableSpotAndMarginTrading || j.enableFutures), reading: !!j.enableReading, futuresTrade: !!j.enableFutures };
}

/* ------------------------------ the user stream ------------------------------ */

let streamWs = null;
let streamKey = null;
let keepalive = null;
let sendToJournal = () => {};

async function openStream() {
  const r = await unsignedWithKey("POST", FUTURES, "/fapi/v1/listenKey");
  if (r.status !== 200) throw new Error(`no listen key: HTTP ${r.status} ${r.body.slice(0, 120)}`);
  streamKey = JSON.parse(r.body).listenKey;
  const ws = new WebSocket(`${STREAM}/ws/${streamKey}`);
  streamWs = ws;
  ws.onopen = () => {
    log("Binance stream open");
    keepalive = setInterval(() => unsignedWithKey("PUT", FUTURES, "/fapi/v1/listenKey").catch(() => {}), 20 * 60_000);
  };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (msg?.e === "listenKeyExpired") return ws.close();
    describeEvent(msg);
    sendToJournal({ t: "event", msg });
  };
  ws.onclose = () => {
    if (keepalive) clearInterval(keepalive);
    keepalive = null;
    streamWs = null;
    setTimeout(() => openStream().catch((e) => log("stream:", e.message)), 5_000);
  };
  ws.onerror = () => {};
}

/** One line per thing the venue says happened, so the window shows the account moving. */
function describeEvent(msg) {
  const e = msg?.e;
  if (e === "ORDER_TRADE_UPDATE" && msg.o) {
    const o = msg.o;
    const what = o.x === "TRADE" ? `${o.X === "FILLED" ? "filled" : "partly filled"} ${o.l ?? o.z} @ ${o.L ?? o.ap}` : String(o.X ?? o.x).toLowerCase();
    log(`order ${o.s} ${o.S} ${o.ps ?? ""} ${o.o ?? ""}${o.sp && Number(o.sp) > 0 ? ` stop ${o.sp}` : ""}: ${what}`);
  } else if (e === "ALGO_UPDATE" && msg.o) {
    const o = msg.o;
    log(`conditional ${o.s} ${o.S ?? ""} ${o.o ?? o.ot ?? ""}${o.tp ?? o.sp ? ` @ ${o.tp ?? o.sp}` : ""}: ${String(o.X ?? "").toLowerCase()}`);
  } else if (e === "ACCOUNT_UPDATE" && msg.a?.P?.length) {
    for (const pos of msg.a.P) log(`position ${pos.s} ${pos.ps ?? ""}: ${pos.pa} @ ${pos.ep}`);
  }
}

let served = 0;
let publicServed = 0;
setInterval(() => {
  log(`alive · ${served} requests answered for the journal in the last 10 minutes${publicServed ? ` (${publicServed} of them market data for the screener)` : ""}`);
  served = 0;
  publicServed = 0;
}, 10 * 60_000).unref?.();

/* ------------------------------ the journal ------------------------------ */

let backoff = 1_000;
async function connect(facts) {
  const ws = new WebSocket(`${URL_.replace(/^http/, "ws")}/api/relay/ws?token=${encodeURIComponent(TOKEN)}`);
  sendToJournal = (m) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(m));
  };
  ws.onopen = () => {
    backoff = 1_000;
    log(`connected to ${URL_}`);
    ws.send(JSON.stringify({ t: "hello", env: ENV, canTrade: facts.canTrade, keyHint: KEY.slice(-8), features: ["public"] }));
  };
  ws.onmessage = async (ev) => {
    let m;
    try {
      m = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (m?.t === "req") {
      try {
        // The venue's own hosts are asked as named; anything else — a stub the server was pointed at — becomes this relay's futures host.
        const base = /binance(future)?\.com$/.test(new URL(m.base).hostname) ? m.base : FUTURES;
        const r = m.public ? await publicGet(m.path, m.params ?? {}) : m.path === "/fapi/v1/listenKey" ? await unsignedWithKey(m.method, base, m.path) : await signed(m.method, base, m.path, m.params ?? {});
        if (m.public) publicServed += 1;
        served += 1;
        if (r.status !== 200) log(`${m.method} ${m.path} → HTTP ${r.status} ${r.body.slice(0, 120)}`);
        ws.send(JSON.stringify({ t: "res", id: m.id, status: r.status, body: r.body }));
      } catch (e) {
        ws.send(JSON.stringify({ t: "res", id: m.id, status: 0, body: JSON.stringify({ code: -1, msg: String(e?.message ?? e) }) }));
      }
    } else if (m?.t === "pong") {
      /* alive */
    }
  };
  ws.onclose = (ev) => {
    log(`journal connection closed (${ev.code}); reconnecting in ${backoff / 1000}s`);
    setTimeout(() => connect(facts), backoff);
    backoff = Math.min(backoff * 2, 30_000);
  };
  ws.onerror = () => {};
  const ping = setInterval(() => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ t: "ping" }));
    else clearInterval(ping);
  }, 25_000);
}

/* ------------------------------ a port, if a host wants one ------------------------------ */

// Hosts that run "web services" (Koyeb, Render, Railway…) insist on something listening. Nothing
// is served; it answers "relay up" so the host keeps it alive. Set PORT and it listens.
if (process.env.PORT) {
  const { createServer } = await import("node:http");
  createServer((_req, res) => {
    res.setHeader("content-type", "text/plain");
    res.end(`edgeline relay up; journal ${sendToJournal ? "linked" : "not linked"}\n`);
  }).listen(Number(process.env.PORT), () => log(`health check on port ${process.env.PORT}`));
}

const facts = await describeKey();
log(`key …${KEY.slice(-4)} on ${ENV}: ${facts.canTrade ? "may trade" : "read-only"}`);
await connect(facts);
openStream().catch((e) => log("stream:", e.message));
