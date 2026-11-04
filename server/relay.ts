/**
 * The relay: the trader's own machine asking Binance on the server's behalf.
 *
 * Binance answers by address, and the server's address is the problem —
 * a US host gets a 451, a host whose outbound IP it shares with strangers
 * gets rate-banned for their sins. The trader's own connection is refused
 * nothing. So a small program (public/relay/edgeline-relay.mjs) runs where
 * the trader is, holds the key, and keeps one outbound WebSocket open to
 * here. Every signed call the server would have made to Binance for that
 * account is sent down that socket instead and answered from the relay's
 * address, and the venue's user-data stream is opened by the relay and its
 * events forwarded. Nothing above this module knows the difference: the
 * tracker, the terminal and the sync see a Binance that answers.
 *
 * Wire format, one JSON object per message:
 *   relay → server   {t:"hello", env, canTrade, keyHint}
 *   server → relay   {t:"req", id, method, base, path, params}
 *   relay → server   {t:"res", id, status, body}            body: the venue's text
 *   relay → server   {t:"event", msg}                       a user-data stream event
 *   either           {t:"ping"} / {t:"pong"}
 */
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { accountByRelayToken, setRelayFacts } from "./storage";
import { notify } from "./events";

const TIMEOUT_MS = 25_000;

interface Relay {
  ws: WebSocket;
  userId: number;
  account: string;
  accountId: number;
  env: "live" | "testnet";
  canTrade: boolean;
  keyHint: string;
  connectedAt: number;
  lastSeenAt: number;
  pending: Map<number, { resolve: (r: { status: number; body: string }) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
}

const relays = new Map<string, Relay>();
const keyOf = (userId: number, account: string) => `${userId}:${account}`;
let nextId = 1;
let onEvent: ((userId: number, account: string, msg: unknown) => void) | null = null;

/** The terminal registers what to do with a user-data event the relay forwards. */
export function setRelayEventHandler(fn: (userId: number, account: string, msg: unknown) => void): void {
  onEvent = fn;
}

export function relayConnected(userId: number, account: string): boolean {
  const r = relays.get(keyOf(userId, account));
  return !!r && r.ws.readyState === r.ws.OPEN;
}

export function relayStatus(userId: number, account: string): { connected: boolean; lastSeenAt: string | null; env: string | null; canTrade: boolean | null } {
  const r = relays.get(keyOf(userId, account));
  if (!r) return { connected: false, lastSeenAt: null, env: null, canTrade: null };
  return { connected: r.ws.readyState === r.ws.OPEN, lastSeenAt: new Date(r.lastSeenAt).toISOString(), env: r.env, canTrade: r.canTrade };
}

export class RelayUnavailable extends Error {
  constructor(account: string) {
    super(`${account}'s relay is not connected. Start it on your machine (Settings → the account → Relay).`);
  }
}

/** One signed call, made by the relay from where it is. Resolves with the venue's status and body text. */
export function relayCall(
  userId: number,
  account: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  base: string,
  path: string,
  params: Record<string, string | number | undefined>,
): Promise<{ status: number; body: string }> {
  const r = relays.get(keyOf(userId, account));
  if (!r || r.ws.readyState !== r.ws.OPEN) return Promise.reject(new RelayUnavailable(account));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      r.pending.delete(id);
      reject(new Error(`${account}'s relay did not answer in ${TIMEOUT_MS / 1000}s (${method} ${path}).`));
    }, TIMEOUT_MS);
    timer.unref?.();
    r.pending.set(id, { resolve, reject, timer });
    const clean: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(params)) if (v !== undefined) clean[k] = v;
    r.ws.send(JSON.stringify({ t: "req", id, method, base, path, params: clean }));
  });
}

function dropRelay(key: string, why: string): void {
  const r = relays.get(key);
  if (!r) return;
  relays.delete(key);
  for (const [, p] of Array.from(r.pending.entries())) {
    clearTimeout(p.timer);
    p.reject(new Error(`${r.account}'s relay went away (${why}).`));
  }
  r.pending.clear();
}

/** The socket endpoint, on the app's own server: wss://<site>/api/relay/ws?token=… */
export function attachRelay(httpServer: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/api/relay/ws") return;
    const token = url.searchParams.get("token") ?? "";
    void accountByRelayToken(token).then(
      (acct) => {
        if (!acct) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          const key = keyOf(acct.userId, acct.name);
          // One relay per account: a second one replaces the first.
          const was = relays.get(key);
          if (was) {
            dropRelay(key, "replaced");
            try {
              was.ws.close(4000, "replaced by a newer relay");
            } catch {
              /* already gone */
            }
          }
          const relay: Relay = {
            ws,
            userId: acct.userId,
            account: acct.name,
            accountId: acct.id,
            env: acct.binanceEnv === "testnet" ? "testnet" : "live",
            canTrade: acct.binanceTrade,
            keyHint: acct.binanceKey ?? "",
            connectedAt: Date.now(),
            lastSeenAt: Date.now(),
            pending: new Map(),
          };
          relays.set(key, relay);
          console.log(`[relay] ${acct.name}: connected`);
          notify(acct.userId, "settings");
          ws.on("message", (data) => {
            relay.lastSeenAt = Date.now();
            let m: any;
            try {
              m = JSON.parse(String(data));
            } catch {
              return;
            }
            if (m?.t === "res") {
              const p = relay.pending.get(Number(m.id));
              if (!p) return;
              relay.pending.delete(Number(m.id));
              clearTimeout(p.timer);
              p.resolve({ status: Number(m.status) || 0, body: typeof m.body === "string" ? m.body : JSON.stringify(m.body ?? null) });
            } else if (m?.t === "event") {
              onEvent?.(relay.userId, relay.account, m.msg);
            } else if (m?.t === "hello") {
              relay.env = m.env === "testnet" ? "testnet" : "live";
              relay.canTrade = !!m.canTrade;
              relay.keyHint = typeof m.keyHint === "string" ? m.keyHint.slice(-8) : "";
              void setRelayFacts(relay.accountId, { binanceEnv: relay.env, binanceTrade: relay.canTrade, binanceKeyHint: relay.keyHint })
                .then(() => notify(relay.userId, "settings"))
                .catch(() => {});
            } else if (m?.t === "ping") {
              ws.send(JSON.stringify({ t: "pong" }));
            }
          });
          ws.on("close", () => {
            if (relays.get(key) === relay) {
              dropRelay(key, "closed");
              console.log(`[relay] ${acct.name}: disconnected`);
              notify(acct.userId, "settings");
            }
          });
          ws.on("error", () => {
            /* close follows */
          });
        });
      },
      () => {
        socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
        socket.destroy();
      },
    );
  });
}

/** For tests and shutdown. */
export function closeRelays(): void {
  for (const key of Array.from(relays.keys())) {
    const r = relays.get(key)!;
    dropRelay(key, "server closing");
    try {
      r.ws.close();
    } catch {
      /* gone */
    }
  }
}
