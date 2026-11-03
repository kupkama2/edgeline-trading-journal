/**
 * Binance's rate ban, honoured.
 *
 * Binance limits by IP. Past the limit it answers 429; keep asking and it
 * answers 418 with -1003, "IP banned until <ms>", for minutes to days — and
 * every request made DURING the ban extends it. On a host whose outbound IP
 * is shared with other tenants (Render, Heroku and the like), the ban can be
 * somebody else's doing, and the only thing this server controls is whether
 * it makes it longer.
 *
 * So a 429 or a 418 from a host is remembered, with the end the venue named
 * (or a minute, when it named none), and until then nothing is sent to that
 * host: the request fails at once, with the end time in the message, and the
 * watch, the tracker and the chart all wait instead of digging deeper.
 */

const bans = new Map<string, { until: number; why: string }>();

/** When a 429 names no end: a minute is Binance's own window. */
const DEFAULT_MS = 60_000;

export class BinanceBanned extends Error {
  constructor(
    readonly host: string,
    readonly until: number,
  ) {
    super(`${host} is rate-limiting this server's IP until ${new Date(until).toISOString().slice(11, 16)} UTC (Binance -1003); not asked again until then, so the ban does not grow.`);
  }
}

/** The end a ban message names: "banned until 1793755739273". */
export function banEndIn(said: string | null | undefined): number | null {
  const m = /banned until (\d{12,14})/i.exec(said ?? "");
  return m ? Number(m[1]) : null;
}

/** A 429 or a 418 seen from a host, with whatever it said. */
export function noteRateLimit(host: string, status: number, said: string | null | undefined, retryAfterSeconds?: number | null): void {
  if (status !== 429 && status !== 418) return;
  const named = banEndIn(said);
  const until = named ?? Date.now() + (retryAfterSeconds && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : DEFAULT_MS);
  const held = bans.get(host);
  if (!held || until > held.until) bans.set(host, { until, why: said ?? `HTTP ${status}` });
}

/** The ban on a host still running, or null. */
export function rateBan(host: string): { until: number; why: string } | null {
  const b = bans.get(host);
  if (!b) return null;
  if (Date.now() >= b.until) {
    bans.delete(host);
    return null;
  }
  return b;
}

/** Throws before a request leaves, while the host's ban runs. */
export function assertNotBanned(host: string): void {
  const b = rateBan(host);
  if (b) throw new BinanceBanned(host, b.until);
}

/** Every ban running now, for the status endpoint. */
export function rateBans(): { host: string; until: string; why: string }[] {
  const out: { host: string; until: string; why: string }[] = [];
  for (const host of Array.from(bans.keys())) {
    const b = rateBan(host);
    if (b) out.push({ host, until: new Date(b.until).toISOString(), why: b.why });
  }
  return out;
}

/** For tests and the status endpoint's ?refresh=1. */
export function forgetRateBans(): void {
  bans.clear();
}
