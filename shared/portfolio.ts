/**
 * The portfolio: what the owner holds, where, and how it has done.
 *
 * Three kinds of address are followed, all read-only and without a key:
 *
 *   hyperliquid  a Hyperliquid account — its perp positions
 *                (clearinghouseState), its spot balances
 *                (spotClearinghouseState, which carries the cost of each
 *                balance as `entryNtl`), and every vault it has money in
 *                (userVaultEquities, then vaultDetails with the user for
 *                its own share: equity, P&L, all-time P&L, days in)
 *   evm          an EVM wallet — native coin and token balances with USD
 *                prices from Blockscout, on Ethereum, Base, Arbitrum,
 *                Optimism and Polygon
 *   solana       a Solana wallet — SOL and SPL token balances from the
 *                public RPC, priced by DefiLlama
 *
 * P&L is what the source can say for certain: a vault's own P&L, a perp's
 * unrealised P&L, a Hyperliquid spot balance against what it cost. A
 * wallet token's cost is not on chain in any form a read can trust (a
 * transfer in is not a purchase), so it is the owner's to enter, and its
 * P&L appears once it is. The value of everything over time comes from
 * the snapshots the server keeps.
 *
 * Everything here is pure; the reads are in server/portfolio.ts.
 */

export type AddressKind = "hyperliquid" | "evm" | "solana";

export interface PortfolioAddress {
  id: number;
  kind: AddressKind;
  address: string;
  label: string | null;
}

export type PositionSource = "hl-perp" | "hl-spot" | "evm" | "solana";

export interface Position {
  /** Stable across reads, so a cost entered for it sticks: kind, address, chain and asset. */
  key: string;
  source: PositionSource;
  /** "Hyperliquid", "Ethereum", "Base", … */
  chain: string;
  /** The address it is held at, and its label. */
  address: string;
  label: string | null;
  asset: string;
  /** Signed for a perp: negative is short. */
  amount: number;
  price: number | null;
  /** Value in USD: for a perp, the notional; for a balance, amount × price. */
  value: number | null;
  /** What it cost in USD: Hyperliquid spot from the venue, a wallet token from the owner. */
  cost: number | null;
  /** Where the cost came from. */
  costFrom: "venue" | "owner" | null;
  pnl: number | null;
  pnlPct: number | null;
  /** "owner" when the P&L is the figure the owner typed in, over whatever the source said. */
  pnlFrom?: "owner";
  /** Perp only. */
  entryPx?: number | null;
  liquidationPx?: number | null;
  leverage?: number | null;
  /** Perp only: the margin it ties up, which is what it adds to the account's equity rather than its notional. */
  margin?: number | null;
}

export interface VaultHolding {
  key: string;
  vaultAddress: string;
  name: string;
  /** The Hyperliquid account holding it. */
  address: string;
  label: string | null;
  equity: number;
  /** The holder's P&L in the vault since entry, and all-time across entries, as the venue states them. */
  pnl: number | null;
  /** "owner" when the P&L is the figure the owner typed in, over the venue's. */
  pnlFrom?: "owner";
  allTimePnl: number | null;
  daysFollowing: number | null;
  enteredAt: number | null;
  lockedUntil: number | null;
  /** The vault's own annualised return, as the venue states it. */
  apr: number | null;
  /** The vault's account value over the last month, for a sparkline: [ms, usd]. */
  history: [number, number][];
}

export interface PortfolioRead {
  at: string;
  addresses: PortfolioAddress[];
  positions: Position[];
  vaults: VaultHolding[];
  /** Per address, the cash a Hyperliquid account holds as margin (withdrawable plus margin in use). */
  accounts: { address: string; label: string | null; accountValue: number | null; withdrawable: number | null }[];
  totals: PortfolioTotals;
  /** What could not be read, per address or chain, in words. */
  /** Keys of the positions and vaults the owner hid; they are left out of the totals. */
  hidden: string[];
  /** A source that could not be read; `stale` when an earlier answer stands in for it. */
  errors: { address: string; where: string; message: string; stale?: boolean }[];
}

export interface PortfolioTotals {
  /** Everything at its value: vault equity, Hyperliquid account value (which includes perp P&L and spot is separate), wallet balances. */
  value: number;
  /** The sum of every P&L the sources state: vault P&L, perp unrealised, priced costs. */
  pnl: number;
  /** How much of `value` has a known cost, so the P&L can be read against it. */
  valueWithCost: number;
  byKind: { vaults: number; hlAccounts: number; hlSpot: number; wallets: number };
}

/* ------------------------------- Hyperliquid ------------------------------- */

const num = (v: unknown): number | null => {
  const x = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(x) ? x : null;
};

/** `userVaultEquities`: `[{ vaultAddress, equity, lockedUntilTimestamp? }]`. */
export function parseVaultEquities(json: unknown): { vaultAddress: string; equity: number; lockedUntil: number | null }[] {
  if (!Array.isArray(json)) return [];
  return json
    .map((r: any) => ({ vaultAddress: String(r?.vaultAddress ?? "").toLowerCase(), equity: num(r?.equity) ?? 0, lockedUntil: num(r?.lockedUntilTimestamp) }))
    .filter((r) => /^0x[0-9a-f]{40}$/.test(r.vaultAddress));
}

/**
 * `vaultDetails` with a user: `{ name, vaultAddress, apr, portfolio: [[period, { accountValueHistory: [[ms, "v"]], pnlHistory }]],
 * followerState: { vaultEquity, pnl, allTimePnl, daysFollowing, vaultEntryTime, lockupUntil } }`.
 */
export function parseVaultDetails(json: unknown): {
  name: string;
  apr: number | null;
  equity: number | null;
  pnl: number | null;
  allTimePnl: number | null;
  daysFollowing: number | null;
  enteredAt: number | null;
  lockedUntil: number | null;
  history: [number, number][];
} | null {
  const j = json as any;
  if (!j || typeof j !== "object") return null;
  const f = j.followerState ?? null;
  const periods: any[] = Array.isArray(j.portfolio) ? j.portfolio : [];
  const month = periods.find((p) => Array.isArray(p) && p[0] === "month")?.[1] ?? periods.find((p) => Array.isArray(p) && p[0] === "allTime")?.[1];
  const history: [number, number][] = Array.isArray(month?.accountValueHistory)
    ? month.accountValueHistory.map((x: any) => [num(x?.[0]), num(x?.[1])] as const).filter((x: any) => x[0] != null && x[1] != null)
    : [];
  return {
    name: typeof j.name === "string" && j.name.trim() ? j.name.trim() : String(j.vaultAddress ?? "vault"),
    apr: num(j.apr),
    equity: num(f?.vaultEquity),
    pnl: num(f?.pnl),
    allTimePnl: num(f?.allTimePnl),
    daysFollowing: num(f?.daysFollowing),
    enteredAt: num(f?.vaultEntryTime),
    lockedUntil: num(f?.lockupUntil),
    history,
  };
}

/** `spotClearinghouseState`: `{ balances: [{ coin, token, total, hold, entryNtl }] }`, empty balances left out. */
export function parseSpotBalances(json: unknown): { coin: string; total: number; entryNtl: number | null }[] {
  const rows = (json as any)?.balances;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r: any) => ({ coin: String(r?.coin ?? ""), total: num(r?.total) ?? 0, entryNtl: num(r?.entryNtl) }))
    .filter((r) => r.coin && Math.abs(r.total) > 1e-12);
}

/** The account's value and withdrawable cash from `clearinghouseState`. */
export function parseAccountValue(json: unknown): { accountValue: number | null; withdrawable: number | null } {
  const j = json as any;
  return { accountValue: num(j?.marginSummary?.accountValue), withdrawable: num(j?.withdrawable) };
}

/**
 * Spot prices from `spotMetaAndAssetCtxs`: `[{ tokens: [{ name, index }], universe: [{ name, tokens: [base, quote], index }] },
 * [{ coin, markPx, midPx }]]`. A token is priced by its pair against USDC (token 0); USDC itself is 1.
 */
export function spotPrices(json: unknown): Map<string, number> {
  const out = new Map<string, number>([["USDC", 1]]);
  if (!Array.isArray(json) || json.length < 2) return out;
  const meta = json[0] as any;
  const ctxs = (Array.isArray(json[1]) ? json[1] : []) as any[];
  const tokens: any[] = Array.isArray(meta?.tokens) ? meta.tokens : [];
  const nameOf = new Map(tokens.map((t) => [Number(t?.index), String(t?.name ?? "")]));
  const pairs: any[] = Array.isArray(meta?.universe) ? meta.universe : [];
  pairs.forEach((p, i) => {
    const [base, quote] = Array.isArray(p?.tokens) ? p.tokens : [];
    if (Number(quote) !== 0) return;
    const name = nameOf.get(Number(base));
    const ctx = ctxs[i] ?? ctxs.find((c) => c?.coin === p?.name);
    const px = num(ctx?.midPx) ?? num(ctx?.markPx);
    if (name && px != null && px > 0 && !out.has(name)) out.set(name, px);
  });
  return out;
}

/* ------------------------------- EVM (Blockscout) ------------------------------- */

export const EVM_CHAINS: { id: string; name: string; host: string; native: string }[] = [
  { id: "eth", name: "Ethereum", host: "https://eth.blockscout.com", native: "ETH" },
  { id: "base", name: "Base", host: "https://base.blockscout.com", native: "ETH" },
  { id: "arbitrum", name: "Arbitrum", host: "https://arbitrum.blockscout.com", native: "ETH" },
  { id: "optimism", name: "Optimism", host: "https://optimism.blockscout.com", native: "ETH" },
  { id: "polygon", name: "Polygon", host: "https://polygon.blockscout.com", native: "POL" },
];

/** `/api/v2/addresses/{a}`: `{ coin_balance, exchange_rate }` — the native coin in wei and its USD price. */
export function parseEvmNative(json: unknown): { amount: number; price: number | null } {
  const j = json as any;
  const wei = j?.coin_balance != null ? Number(j.coin_balance) : 0;
  return { amount: Number.isFinite(wei) ? wei / 1e18 : 0, price: num(j?.exchange_rate) };
}

/**
 * `/api/v2/addresses/{a}/token-balances`: `[{ token: { address_hash|address, symbol, name, decimals, exchange_rate, type }, value }]`.
 * Only ERC-20s. A token with no price is kept but marked, so the page can hide airdropped junk by default.
 */
export function parseEvmTokens(json: unknown): { contract: string; symbol: string; amount: number; price: number | null }[] {
  if (!Array.isArray(json)) return [];
  const out: { contract: string; symbol: string; amount: number; price: number | null }[] = [];
  for (const r of json as any[]) {
    const t = r?.token ?? {};
    if (t.type && t.type !== "ERC-20") continue;
    const decimals = Number(t.decimals ?? 18);
    const raw = Number(r?.value ?? 0);
    if (!Number.isFinite(raw) || raw <= 0 || !Number.isFinite(decimals)) continue;
    out.push({
      contract: String(t.address_hash ?? t.address ?? "").toLowerCase(),
      symbol: String(t.symbol ?? t.name ?? "?").slice(0, 16),
      amount: raw / 10 ** decimals,
      price: num(t.exchange_rate),
    });
  }
  return out;
}

/* ------------------------------- Solana ------------------------------- */

/** `getBalance`: `{ result: { value: lamports } }`. */
export function parseSolBalance(json: unknown): number {
  const v = Number((json as any)?.result?.value ?? 0);
  return Number.isFinite(v) ? v / 1e9 : 0;
}

/** `getTokenAccountsByOwner` (jsonParsed): every SPL balance above zero, by mint. */
export function parseSplBalances(json: unknown): { mint: string; amount: number }[] {
  const rows = (json as any)?.result?.value;
  if (!Array.isArray(rows)) return [];
  const byMint = new Map<string, number>();
  for (const r of rows) {
    const info = r?.account?.data?.parsed?.info;
    const mint = String(info?.mint ?? "");
    const amount = Number(info?.tokenAmount?.uiAmount ?? info?.tokenAmount?.uiAmountString ?? 0);
    if (!mint || !(amount > 0)) continue;
    byMint.set(mint, (byMint.get(mint) ?? 0) + amount);
  }
  return Array.from(byMint, ([mint, amount]) => ({ mint, amount }));
}

/** DefiLlama `/prices/current/{ids}`: `{ coins: { "solana:<mint>": { price, symbol } } }`. */
export function parseLlamaPrices(json: unknown): Map<string, { price: number; symbol: string | null }> {
  const coins = (json as any)?.coins ?? {};
  const out = new Map<string, { price: number; symbol: string | null }>();
  for (const [id, c] of Object.entries<any>(coins)) {
    const p = num(c?.price);
    if (p != null) out.set(id, { price: p, symbol: typeof c?.symbol === "string" ? c.symbol : null });
  }
  return out;
}

/* ------------------------------- the arithmetic ------------------------------- */

/** P&L against a cost, and as a share of it. */
export function withCost(p: Position, cost: number | null, from: Position["costFrom"]): Position {
  if (cost == null || p.value == null) return { ...p, cost, costFrom: cost == null ? null : from };
  const pnl = p.value - cost;
  return { ...p, cost, costFrom: from, pnl, pnlPct: cost !== 0 ? pnl / Math.abs(cost) : null };
}

/**
 * The totals. A Hyperliquid account's value already includes its perps'
 * unrealised P&L (it is margin plus P&L), so perps add their P&L but not
 * their notional; spot balances on Hyperliquid are separate from it and
 * add their value.
 */
export function totalsOf(read: Pick<PortfolioRead, "positions" | "vaults" | "accounts">): PortfolioTotals {
  const vaults = read.vaults.reduce((s, v) => s + v.equity, 0);
  const hlAccounts = read.accounts.reduce((s, a) => s + (a.accountValue ?? 0), 0);
  const hlSpot = read.positions.filter((p) => p.source === "hl-spot").reduce((s, p) => s + (p.value ?? 0), 0);
  const wallets = read.positions.filter((p) => p.source === "evm" || p.source === "solana").reduce((s, p) => s + (p.value ?? 0), 0);
  const pnl =
    read.vaults.reduce((s, v) => s + (v.pnl ?? 0), 0) +
    read.positions.filter((p) => p.source === "hl-perp").reduce((s, p) => s + (p.pnl ?? 0), 0) +
    read.positions.filter((p) => p.source !== "hl-perp" && p.pnl != null).reduce((s, p) => s + p.pnl!, 0);
  const valueWithCost =
    read.vaults.filter((v) => v.pnl != null).reduce((s, v) => s + v.equity, 0) +
    read.positions.filter((p) => p.source !== "hl-perp" && (p.cost != null || p.pnlFrom === "owner")).reduce((s, p) => s + (p.value ?? 0), 0);
  return { value: vaults + hlAccounts + hlSpot + wallets, pnl, valueWithCost, byKind: { vaults, hlAccounts, hlSpot, wallets } };
}

/** Whether an address looks like what its kind needs. */
export function validAddress(kind: AddressKind, address: string): boolean {
  if (kind === "solana") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

/**
 * The owner's own P&L for a holding or a vault, over the source's. A
 * holding's percentage is read against what it must have cost (value less
 * P&L); a perp is never rewritten, its P&L is the venue's live figure.
 */
export function withOwnPnl<T extends { pnl: number | null; pnlFrom?: "owner" }>(row: T, pnl: number, value: number | null): T {
  const cost = value != null ? value - pnl : null;
  return { ...row, pnl, pnlFrom: "owner", ...("pnlPct" in row ? { pnlPct: cost != null && cost !== 0 ? pnl / Math.abs(cost) : null } : {}) };
}

/** Under this, a holding is dust: shown only on request, still counted in the totals. */
export const DUST_USD = 5;

/** A spot or wallet holding worth under DUST_USD, or with no price at all (airdropped junk, mostly). Perps and vaults are never dust. */
export const isDust = (p: Pick<Position, "source" | "value">): boolean => p.source !== "hl-perp" && (p.value == null || Math.abs(p.value) < DUST_USD);

export const positionKey = (kind: AddressKind, address: string, chain: string, asset: string) => `${kind}:${address.toLowerCase()}:${chain}:${asset}`;
