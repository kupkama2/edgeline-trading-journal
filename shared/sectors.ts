/**
 * Which group a coin trades with, kept by hand.
 *
 * The screener ranks coins; a strong coin in a strong group is a better
 * read than a strong coin alone, and a whole group turning is seen before
 * any one of its coins tops the table. There is no feed for this that does
 * not need a key and a rate limit, and the groups move slowly, so it is a
 * list: Hyperliquid's own coin names, upper-cased, one group each. A coin
 * not listed has no group and is left out of the sector table rather than
 * guessed at. Builder-book markets ("xyz:XYZ100") are all TradFi.
 */

export const SECTORS = ["Majors", "L1", "L2", "DeFi", "Meme", "AI", "Infra", "Exchange", "Gaming", "RWA", "Privacy", "Payments", "BTC eco", "Solana eco", "TradFi"] as const;
export type Sector = (typeof SECTORS)[number];

const LIST: Record<Sector, string> = {
  Majors: "ETH SOL BNB XRP",
  L1: "ADA AVAX DOT NEAR ATOM APT SUI SEI TON TRX ALGO HBAR ICP FTM S KAS INJ TIA EGLD FIL ETC BCH LTC XLM VET IOTA NEO KAIA BERA MON INIT MOVE HYPER SONIC ZETA CFX XTZ EOS FLOW MINA ROSE ONE CELO",
  L2: "ARB OP MATIC POL STRK ZK MNT IMX BLAST SCR MANTA METIS LINEA TAIKO ZRO MODE ZORA",
  DeFi: "UNI AAVE MKR SKY CRV COMP SNX LDO PENDLE ENA EIGEN ETHFI GMX DYDX CAKE SUSHI 1INCH BAL RUNE JUP RAY ORCA DRIFT JTO MORPHO USUAL ONDO FXS RSR LQTY COW AERO VVV SYRUP RESOLV KMNO HYPE LIT ASTER AVNT APEX",
  Meme: "DOGE SHIB PEPE WIF BONK FLOKI FARTCOIN POPCAT MEW BRETT MOG TURBO NEIRO PNUT GOAT MOODENG CHILLGUY SPX GIGA PENGU TRUMP MELANIA BOME MEME DEGEN MYRO DOG HMSTR NOT BABYDOGE LADYS PUMP USELESS ZEREBRO AI16Z BAN FWOG MICHI PONKE TOSHI ANIME VINE JELLYJELLY",
  AI: "TAO RENDER RNDR FET WLD AKT AR GRT IO VIRTUAL AIXBT GRASS ARC SWARMS KAITO PROMPT COOKIE ARKM NMR OLAS PHA ATH ZEREBRO AI",
  Infra: "LINK PYTH BAND API3 UMA ENS W ZETA STX QNT AXL HNT IOTX ALT DYM OMNI SAGA ETHW LAYER ZRO WAL IP SOPH",
  Exchange: "OKB CRO LEO KCS GT BGB MX WOO",
  Gaming: "AXS SAND MANA GALA ILV APE YGG PIXEL BIGTIME BEAM SUPER XAI PRIME NOT HMSTR CATI MAVIA ACE GMT",
  RWA: "ONDO POLYX OM CFG PLUME TRU RIO PAXG",
  Privacy: "XMR ZEC DASH ZEN SCRT",
  Payments: "XRP XLM LTC BCH XNO",
  "BTC eco": "ORDI SATS STX RUNE MERL BB CORE BABY",
  "Solana eco": "JUP RAY JTO PYTH DRIFT ORCA KMNO W TNSR ME",
  TradFi: "",
};

/** Hyperliquid quotes some coins by the thousand: kPEPE is PEPE. */
const plain = (coin: string) => coin.replace(/^k(?=[A-Z0-9])/, "").toUpperCase();

const BY_COIN = (() => {
  const out = new Map<string, Sector>();
  // The first group a coin is listed under is its group: the order above is from the narrowest claim to the widest.
  const order: Sector[] = ["Majors", "Meme", "AI", "DeFi", "L2", "Gaming", "RWA", "Privacy", "BTC eco", "Exchange", "Infra", "L1", "Payments", "Solana eco"];
  for (const s of order) for (const c of LIST[s].split(/\s+/).filter(Boolean)) if (!out.has(c)) out.set(c, s);
  return out;
})();

/** The coin's group, or null when it is not on the list. */
export function sectorOf(coin: string): Sector | null {
  if (coin.includes(":")) return "TradFi";
  return BY_COIN.get(plain(coin)) ?? null;
}
