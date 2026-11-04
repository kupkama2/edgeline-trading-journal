/**
 * The page told when the record changes, so nobody refreshes by hand.
 *
 * Every write to a person's trades — the form, the tracker, the terminal,
 * the sync — says so here, and every tab that person has open hears it
 * over one long-lived response (server-sent events) and asks for the
 * trades again. Nothing is pushed but the fact of a change: the page reads
 * the data the way it always has. Several writes in a burst are one word.
 *
 * A tab that loses the connection reconnects on its own; the browser does
 * that for this kind of stream. A heartbeat keeps proxies from closing a
 * quiet one.
 */
import type { Response } from "express";

export type ChangeKind = "trades" | "settings";

const listeners = new Map<number, Set<Response>>();
const pending = new Map<string, NodeJS.Timeout>();
const COALESCE_MS = 400;
const HEARTBEAT_MS = 25_000;

/** One tab's stream, kept until it closes. */
export function subscribe(userId: number, res: Response): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  // no-transform: the compression layer must leave this alone, or events would sit in its buffer.
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(`retry: 3000\nevent: hello\ndata: {}\n\n`);
  let set = listeners.get(userId);
  if (!set) listeners.set(userId, (set = new Set()));
  set.add(res);
  const beat = setInterval(() => {
    try {
      res.write(": beat\n\n");
    } catch {
      /* closing */
    }
  }, HEARTBEAT_MS);
  beat.unref?.();
  const drop = () => {
    clearInterval(beat);
    set!.delete(res);
    if (set!.size === 0) listeners.delete(userId);
  };
  res.on("close", drop);
  res.on("error", drop);
}

/** The record changed for this person: every open tab is told, once per burst. */
export function notify(userId: number, kind: ChangeKind): void {
  if (!listeners.has(userId)) return;
  const key = `${userId}:${kind}`;
  if (pending.has(key)) return;
  const t = setTimeout(() => {
    pending.delete(key);
    const set = listeners.get(userId);
    if (!set) return;
    for (const res of Array.from(set)) {
      try {
        res.write(`event: ${kind}\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
      } catch {
        set.delete(res);
      }
    }
  }, COALESCE_MS);
  t.unref?.();
  pending.set(key, t);
}

/** How many tabs are listening, for tests and the status line. */
export function listening(userId: number): number {
  return listeners.get(userId)?.size ?? 0;
}
