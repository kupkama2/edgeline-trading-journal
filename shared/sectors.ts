/**
 * Which group a coin trades with, kept by hand.
 *
 * The screener ranks coins; a strong coin in a strong group is a better
 * read than a strong coin alone, and a whole group turning is seen before
 * any one of its coins tops the table. There is no feed for this that does
 * not need a key and a rate limit, and the groups move slowly, so it is a
 * list: Hyperliquid's own coin names, upper-cased, one group each. A coin
 * not listed has no group and is left out of the sector table rather than
 * guessed at. A builder-book market ("xyz:XYZ100") takes its asset class as
 * its group: an index, a commodity, a stock, a company not yet listed.
 */

export const SECTORS = ["Majors", "L1", "L2", "DeFi", "Meme", "AI", "Infra", "Exchange", "Gaming", "RWA", "Privacy", "Payments", "BTC eco", "Solana eco"] as const;
export type Sector = (typeof SECTORS)[number];

/**
 * What kind of thing a market is. Everything on the venue's own book is
 * crypto. A builder book lists whatever its builder chose, and its markets
 * are told apart by name: the indices, commodities and currencies are a
 * short list that changes slowly; companies that have not listed yet are
 * named; a crypto ticker quoted on a builder book is still crypto; and the
 * rest are stocks. A name this gets wrong shows under Equities until it is
 * added here — it is still read and ranked, only filed in the wrong drawer.
 */
export const ASSET_CLASSES = ["crypto", "equity", "index", "commodity", "fx", "pre-ipo"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];
export const ASSET_CLASS_LABEL: Record<AssetClass, string> = { crypto: "Crypto", equity: "Equities", index: "Indices", commodity: "Commodities", fx: "FX", "pre-ipo": "Pre-IPO" };

const INDEX = /^(XYZ100|US100|NAS100|NDX|NQ|US500|SPX500|SPX|SP500|ES|US30|DJI|DOW|YM|US2000|RUT|RTY|DAX|GER40|DE40|UK100|FTSE|JP225|NIKKEI|N225|HK50|HSI|EU50|STOXX50|FRA40|CAC40|AUS200|CHINA50|A50|KOSPI|KR200|IN50|NIFTY|VIX|DXY|USDX|MAG7|SEMIS|SEMI|SOX|EWJ|EWY|EEM|QQQ|SPY|IWM|DIA|TLT|ARKK|SMH|XLE|XLF|XLK|GLDMINERS|GDX|URA|BOTZ|ROBO)$/;
const COMMODITY = /^(GOLD|XAU|XAUUSD|GLD|SILVER|XAG|XAGUSD|SLV|PLATINUM|XPT|PALLADIUM|XPD|COPPER|HG|XCU|ALUMINUM|ALUMINIUM|NICKEL|ZINC|LITHIUM|URANIUM|IRON|IRONORE|STEEL|OIL|WTI|WTIOIL|USOIL|CL|BRENT|BRENTOIL|UKOIL|NATGAS|NG|GAS|GASOLINE|RBOB|HEATOIL|COAL|CORN|WHEAT|SOYBEAN|SOY|SUGAR|COFFEE|COCOA|COTTON|RICE|OATS|LUMBER|CATTLE|HOGS|OJ|PALMOIL|RUBBER|CARBON)$/;
const FX = /^(EUR|EURUSD|GBP|GBPUSD|JPY|USDJPY|CHF|USDCHF|AUD|AUDUSD|NZD|NZDUSD|CAD|USDCAD|CNH|USDCNH|CNY|MXN|USDMXN|BRL|USDBRL|TRY|USDTRY|ZAR|USDZAR|INR|USDINR|KRW|USDKRW|SGD|USDSGD|HKD|SEK|NOK|PLN|CZK|HUF|ILS|EURGBP|EURJPY|GBPJPY|EURCHF)$/;
const PRE_IPO = /^(ANTHROPIC|OPENAI|SPACEX|XAI|STRIPE|DATABRICKS|ANDURIL|SCALE|SCALEAI|PERPLEXITY|FIGURE|FIGUREAI|NEURALINK|STARLINK|CANVA|REVOLUT|KRAKEN|POLYMARKET|KALSHI|RAMP|DISCORD|EPIC|EPICGAMES|SHEIN|BYTEDANCE|TIKTOK|CEREBRAS|MISTRAL|SSI|WAYMO|ANYSPHERE|CURSOR|COGNITION|HARVEY|GLEAN|RIPPLING|DEEL|PLAID|CHIME|KLARNA|VERCEL|REPLIT|LOVABLE|PHANTOM|METAMASK|CONSENSYS|TETHER|PUMPFUN|OPENSEA|LEDGER|ZAMA|RAMPLABS|SIERRA|ELEVENLABS|SUNO|RUNWAY|PIKA|GROQ|LAMBDA|COREWEAVE|CRUSOE|TOGETHER|FIREWORKS|THINKINGMACHINES|PHYSICALINTELLIGENCE|SKILD|APPTRONIK|SHIELDAI|SARONIC|HELION|COMMONWEALTH|BOOM|RELATIVITY|VARDA|IMPULSE|ZIPLINE)$/;

const CRYPTO_ON_BOOKS = /^(BTC|ETH|SOL|XRP|BNB|DOGE|HYPE|SUI|ADA|AVAX|LINK|PEPE|KPEPE|FARTCOIN|PUMP|ENA|AAVE|UNI|LTC|BCH|TON|TRX|NEAR|APT|ARB|OP|TAO|WLD|ZEC|XMR|BONK|KBONK|WIF|TRUMP)$/;

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

/** A builder-book market's own name, without its book and without the quote some builders append ("GOLD-USD", "TSLAUSD"). */
const bare = (coin: string) =>
  coin
    .slice(coin.indexOf(":") + 1)
    .toUpperCase()
    .replace(/[-_/]?(USD[TCEH]?|PERP)$/, "") || coin.slice(coin.indexOf(":") + 1).toUpperCase();

export function assetClassOf(coin: string): AssetClass {
  if (!coin.includes(":")) return "crypto";
  const full = coin.slice(coin.indexOf(":") + 1).toUpperCase();
  const name = bare(coin);
  for (const n of [full, name]) {
    if (PRE_IPO.test(n)) return "pre-ipo";
    if (INDEX.test(n)) return "index";
    if (COMMODITY.test(n)) return "commodity";
    if (FX.test(n)) return "fx";
  }
  // Only the large coins: a short ticker on a stock book ("S", "W", "ONE") is far more likely the stock than its crypto namesake.
  if (CRYPTO_ON_BOOKS.test(name)) return "crypto";
  return "equity";
}

/** The coin's group: a crypto coin's sector from the list (null when it is not on it), any other market's asset class. */
export function sectorOf(coin: string): string | null {
  const cls = assetClassOf(coin);
  if (cls !== "crypto") return ASSET_CLASS_LABEL[cls];
  return BY_COIN.get(plain(coin.includes(":") ? bare(coin) : coin)) ?? null;
}
