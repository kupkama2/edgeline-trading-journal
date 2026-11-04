/**
 * A number as somebody copied it, read as the number they meant.
 *
 * A price copied from Binance comes as "79,582.3"; from a European screen as
 * "79.582,3"; from a Swiss one as "79'582.3"; with a currency, a space, a
 * unit — "$79,582.30", "79 582.3", "0.5 USDT". A native number field takes
 * none of these as typed: a browser reading "," as its decimal mark drops
 * the "." and keeps 79.5823, which is a price for a different coin. So the
 * pasted text is read here first, and the field gets a plain "79582.3".
 *
 * The one real ambiguity is a single comma with three digits after it:
 * "79,582" is seventy-nine thousand to a Binance user and 79.582 to a
 * European typing by hand. Thousands wins — a price copied from a venue
 * is the common case for a comma, and a hand-typed European decimal
 * usually has a different number of digits ("0,5", "1,25").
 */
export function parseLooseNumber(raw: string | null | undefined): number | null {
  const cleaned = cleanNumberText(raw);
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** The text a number field can take: digits, one ".", a leading "-". "" when there is no number in it. */
export function cleanNumberText(raw: string | null | undefined): string {
  if (raw == null) return "";
  let s = String(raw).trim();
  if (!s) return "";
  // Currency and unit noise, on either side; a percent sign; invisible spaces.
  s = s.replace(/[   ]/g, " ").replace(/[$€£¥₿%]/g, "").replace(/\b(USDT|USDC|USD|EUR|BUSD|FDUSD|PERP)\b/gi, "").trim();
  const negative = /^[-−–]/.test(s) || /^\(.*\)$/.test(s);
  s = s.replace(/^[-−–+]\s*/, "").replace(/^\((.*)\)$/, "$1").trim();
  // Grouping marks that are never decimals: spaces, apostrophes, underscores.
  s = s.replace(/[\s'’_]/g, "");
  if (!/^[\d.,]+$/.test(s)) return "";
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  let out: string;
  if (lastComma >= 0 && lastDot >= 0) {
    // Both: whichever comes last is the decimal mark, the other groups thousands.
    out = lastDot > lastComma ? s.replace(/,/g, "") : s.replace(/\./g, "").replace(",", ".");
  } else if (lastComma >= 0) {
    const parts = s.split(",");
    const groups = parts.length > 2 || (parts.length === 2 && parts[1].length === 3 && parts[0] !== "0" && parts[0] !== "");
    out = groups ? parts.join("") : parts.join(".");
  } else if (lastDot >= 0) {
    const parts = s.split(".");
    // "79.582.300": dots that group. One dot is a decimal mark, as ever.
    out = parts.length > 2 ? parts.join("") : s;
  } else {
    out = s;
  }
  if (!/^\d*\.?\d*$/.test(out) || out === "." || out === "") return "";
  return (negative ? "-" : "") + out;
}
