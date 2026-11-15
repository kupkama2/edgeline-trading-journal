/**
 * The Astekz portfolio, as its public page publishes it.
 *
 * The page draws a widget whose own source lists what is held: a ticker, a
 * quantity, what it cost, and where its price comes from (CoinGecko, or a
 * fixed dollar for cash). The widget prices that list in the visitor's
 * browser. This does the same sum from the same list: value, each
 * holding's weight, the share in cash, progress toward the goal, and P&L
 * against what was paid.
 *
 * The list is JavaScript, not JSON, and it is read as text: it is never
 * run. Because the page gives quantities, what changed between two days is
 * read off the quantities themselves — a price moving does not count as a
 * trade.
 */

export interface AstekzSource {
  kind: string;
  id?: string;
  exchange?: string;
  coinId?: string;
  base?: string;
  target?: string;
  usd?: number;
}

export interface AstekzHoldingConfig {
  ticker: string;
  name: string;
  qty: number;
  costUsd: number;
  cash: boolean;
  sources: AstekzSource[];
}

export interface AstekzConfig {
  goalUsd: number;
  startUsd: number | null;
  holdings: AstekzHoldingConfig[];
}

export interface AstekzHolding {
  ticker: string;
  name: string;
  qty: number;
  costUsd: number;
  cash: boolean;
  priceUsd: number;
  /** Where the price came from: "CoinGecko", an exchange through it, "Fixed cash", or the page's own typed figure. */
  priceFrom: string;
  valueUsd: number;
  /** Share of the whole portfolio, in percent. */
  weight: number;
  pnlUsd: number;
  pnlPct: number | null;
}

export interface AstekzSnapshot {
  at: string;
  goalUsd: number;
  totalUsd: number;
  costUsd: number;
  cashUsd: number;
  /** Share held in cash, in percent. */
  cashPct: number;
  /** Total as a share of the goal, in percent. */
  progressPct: number;
  /** Total against what was paid, in percent. */
  pnlPct: number | null;
  holdings: AstekzHolding[];
}

export class AstekzUnreadable extends Error {}

/** A JavaScript literal turned into JSON without running it: strings set aside, comments dropped, keys quoted, trailing commas removed. */
function literalToJson(js: string): string {
  const strings: string[] = [];
  let out = "";
  for (let i = 0; i < js.length; ) {
    const c = js[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      let s = "";
      while (j < js.length && js[j] !== c) {
        if (js[j] === "\\" && j + 1 < js.length) {
          s += js[j + 1];
          j += 2;
        } else s += js[j++];
      }
      strings.push(s);
      out += `\u0000${strings.length - 1}\u0000`;
      i = j + 1;
    } else if (c === "/" && js[i + 1] === "/") {
      while (i < js.length && js[i] !== "\n") i++;
    } else if (c === "/" && js[i + 1] === "*") {
      const end = js.indexOf("*/", i + 2);
      i = end < 0 ? js.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  out = out
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/,(\s*[}\]])/g, "$1")
    .replace(/(\d)_(?=\d)/g, "$1");
  return out.replace(/\u0000(\d+)\u0000/g, (_m, n) => JSON.stringify(strings[Number(n)]));
}

/** The text of `const NAME = [ … ]` from the opening bracket to the one that closes it, skipping brackets inside strings. */
function arrayAfter(src: string, name: string): string | null {
  const m = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*\\[`).exec(src);
  if (!m) return null;
  const start = m.index + m[0].length - 1;
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "/" && src[i + 1] === "/") while (i < src.length && src[i] !== "\n") i++;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

const numberAfter = (src: string, name: string): number | null => {
  const m = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*([0-9][0-9_.]*)`).exec(src);
  const n = m ? Number(m[1].replace(/_/g, "")) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** What the widget's page says is held. Throws AstekzUnreadable when the page no longer carries the list in a form this can read. */
export function parseAstekzWidget(html: string): AstekzConfig {
  const block = arrayAfter(html, "HOLDINGS");
  if (!block) throw new AstekzUnreadable("The page no longer carries its list of holdings where it used to.");
  let raw: unknown;
  try {
    raw = JSON.parse(literalToJson(block));
  } catch {
    throw new AstekzUnreadable("The page's list of holdings is written in a way this cannot read.");
  }
  if (!Array.isArray(raw) || raw.length === 0) throw new AstekzUnreadable("The page's list of holdings is empty.");
  const holdings: AstekzHoldingConfig[] = [];
  for (const h of raw as any[]) {
    const qty = Number(h?.qty);
    const ticker = typeof h?.ticker === "string" ? h.ticker.trim().slice(0, 24) : "";
    if (!ticker || !Number.isFinite(qty) || qty < 0) throw new AstekzUnreadable("A holding on the page has no ticker or no quantity.");
    const sources: AstekzSource[] = (Array.isArray(h.sources) ? h.sources : [])
      .filter((s: any) => s && typeof s.kind === "string")
      .map((s: any) => ({ kind: String(s.kind), ...(typeof s.id === "string" ? { id: s.id } : {}), ...(typeof s.exchange === "string" ? { exchange: s.exchange } : {}), ...(typeof s.coinId === "string" ? { coinId: s.coinId } : {}), ...(typeof s.base === "string" ? { base: s.base } : {}), ...(typeof s.target === "string" ? { target: s.target } : {}), ...(Number.isFinite(Number(s.usd)) && Number(s.usd) > 0 ? { usd: Number(s.usd) } : {}) }));
    const cash = h.cash === true || sources.some((s) => s.kind === "cash");
    const cost = Number(h.costUsd);
    holdings.push({ ticker, name: typeof h.name === "string" ? h.name.trim().slice(0, 60) : ticker, qty, costUsd: Number.isFinite(cost) && cost >= 0 ? cost : 0, cash, sources });
  }
  return { goalUsd: numberAfter(html, "GOAL_USD") ?? 1_000_000, startUsd: numberAfter(html, "START_USD"), holdings };
}

/** The CoinGecko coin ids the list needs a price for. */
export function astekzCoinIds(config: AstekzConfig): string[] {
  const ids = new Set<string>();
  for (const h of config.holdings) for (const s of h.sources) if ((s.kind === "coingecko" && s.id) || (s.kind === "coingecko-exchange" && s.coinId)) ids.add((s.id ?? s.coinId)!);
  return Array.from(ids).filter((id) => /^[a-z0-9-]{1,60}$/.test(id));
}

/** The name a price from one exchange's last trade is filed under. */
export const exchangeKey = (s: AstekzSource) => `x:${s.exchange}:${s.coinId}:${s.base}:${s.target}`;

/** The exchange pairs the list prefers a last trade from. */
export function astekzExchangePairs(config: AstekzConfig): AstekzSource[] {
  const seen = new Map<string, AstekzSource>();
  for (const h of config.holdings) for (const s of h.sources) if (s.kind === "coingecko-exchange" && s.exchange && s.coinId && s.base && s.target && /^[a-z0-9_-]{1,40}$/.test(s.exchange) && /^[a-z0-9-]{1,60}$/.test(s.coinId)) seen.set(exchangeKey(s), s);
  return Array.from(seen.values());
}

/** One exchange's tickers for a coin, as the last price of the wanted pair; null when it is missing or marked stale. */
export function parseExchangeLast(raw: unknown, s: AstekzSource): number | null {
  const t = ((raw as any)?.tickers ?? []).find((x: any) => x?.base === s.base && x?.target === s.target && !x?.is_stale && !x?.is_anomaly);
  const v = Number(t?.last);
  return v > 0 ? v : null;
}

/** CoinGecko's simple-price answer, as prices by coin id. */
export function parseSimplePrices(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (raw && typeof raw === "object") for (const [id, v] of Object.entries(raw as Record<string, any>)) if (Number(v?.usd) > 0) out.set(id, Number(v.usd));
  return out;
}

/**
 * The list priced. Each holding takes the first of its sources that has a
 * price: cash is a dollar, an exchange pair its last trade, a CoinGecko id
 * its simple price, and the page's own typed figure the last resort. Throws when a holding has none, so a
 * day is never stored with a hole in it.
 */
export function valueAstekz(config: AstekzConfig, prices: Map<string, number>, at: string): AstekzSnapshot {
  const rows = config.holdings.map((h) => {
    let priceUsd: number | null = null;
    let priceFrom = "";
    for (const s of h.sources) {
      if (s.kind === "cash") [priceUsd, priceFrom] = [1, "Fixed cash"];
      else if (s.kind === "coingecko" && s.id && prices.has(s.id)) [priceUsd, priceFrom] = [prices.get(s.id)!, "CoinGecko"];
      else if (s.kind === "coingecko-exchange" && prices.has(exchangeKey(s))) [priceUsd, priceFrom] = [prices.get(exchangeKey(s))!, `${s.exchange} via CoinGecko`];
      else if (s.kind === "manual" && s.usd) [priceUsd, priceFrom] = [s.usd, "The page's own typed price"];
      if (priceUsd != null) break;
    }
    if (priceUsd == null && h.cash) [priceUsd, priceFrom] = [1, "Fixed cash"];
    if (priceUsd == null) throw new AstekzUnreadable(`No price could be found for ${h.ticker}.`);
    const valueUsd = priceUsd * h.qty;
    return { ticker: h.ticker, name: h.name, qty: h.qty, costUsd: h.costUsd, cash: h.cash, priceUsd, priceFrom, valueUsd, weight: 0, pnlUsd: valueUsd - h.costUsd, pnlPct: h.costUsd > 0 ? (valueUsd / h.costUsd - 1) * 100 : null };
  });
  const totalUsd = rows.reduce((s, r) => s + r.valueUsd, 0);
  const costUsd = rows.reduce((s, r) => s + r.costUsd, 0);
  const cashUsd = rows.filter((r) => r.cash).reduce((s, r) => s + r.valueUsd, 0);
  for (const r of rows) r.weight = totalUsd > 0 ? (r.valueUsd / totalUsd) * 100 : 0;
  // What was put in is the starting capital when the page states it: money moved to cash after a sale is not new money.
  const basis = config.startUsd ?? costUsd;
  return {
    at,
    goalUsd: config.goalUsd,
    totalUsd,
    costUsd: basis,
    cashUsd,
    cashPct: totalUsd > 0 ? (cashUsd / totalUsd) * 100 : 0,
    progressPct: (totalUsd / config.goalUsd) * 100,
    pnlPct: basis > 0 ? (totalUsd / basis - 1) * 100 : null,
    holdings: rows.sort((a, b) => Number(a.cash) - Number(b.cash) || b.valueUsd - a.valueUsd),
  };
}

export interface AstekzChange {
  /** The day the change was first seen, and the day it is measured from. */
  date: string;
  since: string;
  bought: { ticker: string; name: string; qty: number; valueUsd: number }[];
  sold: { ticker: string; name: string; qty: number; valueUsd: number }[];
  resized: { ticker: string; name: string; from: number; to: number; pct: number }[];
  /** How much cash moved, in dollars; zero when it did not. */
  cashDelta: number;
}

/** A quantity has to move by more than this share to be a resize: the page rounds what it shows. */
const RESIZE_MIN = 0.001;

/** What was bought, sold or resized between two days, by quantity. Null when nothing was. */
export function diffAstekz(prev: { day: string; snap: AstekzSnapshot }, next: { day: string; snap: AstekzSnapshot }): AstekzChange | null {
  const P = new Map(prev.snap.holdings.filter((h) => !h.cash).map((h) => [h.ticker, h]));
  const N = new Map(next.snap.holdings.filter((h) => !h.cash).map((h) => [h.ticker, h]));
  const c: AstekzChange = { date: next.day, since: prev.day, bought: [], sold: [], resized: [], cashDelta: 0 };
  N.forEach((h, k) => {
    const q = P.get(k);
    if (!q) c.bought.push({ ticker: h.ticker, name: h.name, qty: h.qty, valueUsd: h.valueUsd });
    else if (q.qty > 0 && Math.abs(h.qty - q.qty) / q.qty > RESIZE_MIN) c.resized.push({ ticker: h.ticker, name: h.name, from: q.qty, to: h.qty, pct: (h.qty / q.qty - 1) * 100 });
  });
  P.forEach((q, k) => {
    if (!N.has(k)) c.sold.push({ ticker: q.ticker, name: q.name, qty: q.qty, valueUsd: q.valueUsd });
  });
  const cash = (s: AstekzSnapshot) => s.holdings.filter((h) => h.cash).reduce((t, h) => t + h.qty, 0);
  const delta = cash(next.snap) - cash(prev.snap);
  c.cashDelta = Math.abs(delta) >= 0.01 ? delta : 0;
  return c.bought.length || c.sold.length || c.resized.length || c.cashDelta ? c : null;
}

/** The change log from a run of days, newest first. */
export function astekzChanges(days: { day: string; snap: AstekzSnapshot }[]): AstekzChange[] {
  const out: AstekzChange[] = [];
  for (let i = 1; i < days.length; i++) {
    const c = diffAstekz(days[i - 1], days[i]);
    if (c) out.push(c);
  }
  return out.reverse();
}
