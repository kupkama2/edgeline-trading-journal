/**
 * The venue's own word, the moment it happens: Binance's user data stream.
 *
 * Polling reads a fill back within seconds; a stop that must go on the
 * instant a limit fills cannot wait seconds. So each trading account keeps a
 * WebSocket open to the venue's user stream, and an order event — a fill, a
 * cancel, a bracket firing — runs the read-back at once. The poll stays as
 * the net under it: a stream that is down for a minute loses nothing but
 * speed.
 *
 * As Binance's SDK and ccxt have it: POST /fapi/v1/listenKey (API key
 * header, unsigned) returns a key good for sixty minutes, PUT renews it,
 * and the stream is wss://<host>/private/ws?listenKey=<key>. The events are
 * ORDER_TRADE_UPDATE for plain orders and ALGO_UPDATE for conditional ones;
 * listenKeyExpired means fetch a new key and reconnect.
 */
import WebSocket from "ws";
import { fetch as undiciFetch } from "undici";
import { futuresBase, type BinanceEnv, type Creds } from "./binance-account";
import { egressFor } from "./egress";

const WS_LIVE = (process.env.BINANCE_FUTURES_WS || "wss://fstream.binance.com").replace(/\/+$/, "");
const WS_TESTNET = (process.env.BINANCE_TESTNET_FUTURES_WS || "wss://fstream.binancefuture.com").replace(/\/+$/, "");

export const streamBase = (env: BinanceEnv) => (env === "testnet" ? WS_TESTNET : WS_LIVE);
export const streamUrl = (env: BinanceEnv, listenKey: string) => `${streamBase(env)}/private/ws?listenKey=${encodeURIComponent(listenKey)}`;

/** Renewed well inside the venue's sixty minutes; ccxt uses twenty. */
const KEEPALIVE_MS = 20 * 60_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/** An order event worth a read-back: something filled, fired, or went away. */
export function worthAReadBack(msg: unknown): boolean {
  const m = msg as any;
  const e = m?.e ?? m?.data?.e;
  const o = m?.o ?? m?.data?.o;
  if (e === "ORDER_TRADE_UPDATE") {
    return o?.x === "TRADE" || ["FILLED", "PARTIALLY_FILLED", "CANCELED", "EXPIRED"].includes(String(o?.X ?? ""));
  }
  if (e === "ALGO_UPDATE") {
    return ["TRIGGERED", "FINISHED", "CANCELED", "EXPIRED", "REJECTED"].includes(String(o?.X ?? ""));
  }
  return false;
}

/** The listen key: an unsigned call, the API key alone names the account. */
async function listenKey(creds: Creds, env: BinanceEnv, method: "POST" | "PUT"): Promise<string | null> {
  const base = futuresBase(env);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await undiciFetch(`${base}/fapi/v1/listenKey`, {
      method,
      headers: { "X-MBX-APIKEY": creds.key, accept: "application/json" },
      signal: ctl.signal,
      dispatcher: egressFor(base),
    } as any);
    if (!res.ok) throw new Error(`${new URL(base).hostname} → HTTP ${res.status} on ${method} /fapi/v1/listenKey`);
    const j: any = await res.json().catch(() => ({}));
    return typeof j?.listenKey === "string" ? j.listenKey : null;
  } finally {
    clearTimeout(timer);
  }
}

export interface StreamHandle {
  /** Whether a socket is open right now. */
  readonly connected: boolean;
  close(): void;
}

/**
 * One account's stream, kept open: a fresh key, a socket, a renewal timer,
 * and a reconnect with backoff whenever any of it goes. `onEvent` is called
 * with every order event the venue sends; the caller decides what it means.
 */
export function openUserStream(opts: {
  creds: Creds;
  env: BinanceEnv;
  label: string;
  onEvent: (msg: unknown) => void;
  log?: (line: string) => void;
}): StreamHandle {
  const log = opts.log ?? ((line: string) => console.log(`[terminal stream ${opts.label}] ${line}`));
  let ws: WebSocket | null = null;
  let key: string | null = null;
  let closed = false;
  let backoff = BACKOFF_MIN_MS;
  let keepalive: NodeJS.Timeout | null = null;
  let retry: NodeJS.Timeout | null = null;

  const stopTimers = () => {
    if (keepalive) clearInterval(keepalive);
    if (retry) clearTimeout(retry);
    keepalive = null;
    retry = null;
  };

  const scheduleReconnect = (why: string) => {
    if (closed) return;
    stopTimers();
    log(`${why}; reconnecting in ${Math.round(backoff / 1000)}s`);
    retry = setTimeout(() => void connect(), backoff);
    retry.unref?.();
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  };

  const connect = async () => {
    if (closed) return;
    try {
      key = await listenKey(opts.creds, opts.env, "POST");
      if (!key) throw new Error("the venue returned no listenKey");
    } catch (err: any) {
      return scheduleReconnect(`no listen key: ${String(err?.message ?? err).slice(0, 200)}`);
    }
    const socket = new WebSocket(streamUrl(opts.env, key));
    ws = socket;
    socket.on("open", () => {
      backoff = BACKOFF_MIN_MS;
      log("connected");
      keepalive = setInterval(() => {
        void listenKey(opts.creds, opts.env, "PUT").catch((err: any) => log(`keepalive failed: ${String(err?.message ?? err).slice(0, 200)}`));
      }, KEEPALIVE_MS);
      keepalive.unref?.();
    });
    socket.on("message", (data) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      const e = (msg as any)?.e ?? (msg as any)?.data?.e;
      if (e === "listenKeyExpired") {
        socket.close();
        return;
      }
      try {
        opts.onEvent(msg);
      } catch (err: any) {
        log(`handler failed: ${String(err?.message ?? err).slice(0, 200)}`);
      }
    });
    socket.on("error", (err) => log(`socket error: ${String((err as any)?.message ?? err).slice(0, 200)}`));
    socket.on("close", (code) => {
      if (ws === socket) ws = null;
      scheduleReconnect(`socket closed (${code})`);
    });
  };

  void connect();

  return {
    get connected() {
      return ws?.readyState === WebSocket.OPEN;
    },
    close() {
      closed = true;
      stopTimers();
      ws?.close();
      ws = null;
    },
  };
}
