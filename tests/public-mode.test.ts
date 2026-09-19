import { afterEach, describe, expect, it } from "vitest";
import { fmtAmount, fmtFees, fmtMoney, fmtR } from "../shared/metrics";
import { amountsHidden, hideAmounts, maskIfQuote, WITHHELD } from "../shared/redact";
import { describeScalp } from "../shared/scalp";

/**
 * A journal you can show someone.
 *
 * The rule has one direction: R, the verdicts and the shape of the record
 * stay, and everything denominated in the account's own currency goes. It is
 * enforced at the formatters rather than at the call sites because there are
 * about a hundred and thirty call sites and missing one is the whole failure —
 * the point of the mode is that a screenshot can be posted without being read
 * for the figure that got through.
 */
afterEach(() => hideAmounts(false));

describe("with the amounts withheld", () => {
  it("masks every account-currency formatter", () => {
    hideAmounts(true);
    expect(fmtMoney(1234)).toBe(WITHHELD);
    expect(fmtMoney(-1234)).toBe(WITHHELD);
    expect(fmtAmount(1234)).toBe(WITHHELD);
    expect(fmtAmount(1234, 0)).toBe(WITHHELD);
    expect(fmtFees(12.5)).toBe(WITHHELD);
  });

  it("leaves R alone, because R is the point", () => {
    hideAmounts(true);
    // R divides the position size out, so it says how well the trade went
    // without saying how much was on it. Everything worth showing is here.
    expect(fmtR(2.4)).toBe("+2.40R");
    expect(fmtR(-1)).toBe("-1.00R");
  });

  it("hides whether a figure was ever recorded", () => {
    /*
     * Masked BEFORE the missing check, not after. If an unrecorded fee came
     * back as an em-dash while a recorded one came back as dots, the mask
     * would quietly report which trades have numbers on them — and on a page
     * of mostly-blank fees that is a readable signal about the book.
     */
    hideAmounts(true);
    expect(fmtMoney(null)).toBe(WITHHELD);
    expect(fmtFees(undefined)).toBe(WITHHELD);
    expect(fmtAmount(NaN)).toBe(WITHHELD);
  });

  it("never renders a currency symbol", () => {
    hideAmounts(true);
    for (const s of [fmtMoney(9), fmtAmount(9), fmtFees(9), WITHHELD]) {
      expect(s).not.toContain("$");
    }
  });

  it("is not an em-dash, so a withheld figure is not read as a gap", () => {
    // The journal uses "—" for "nobody recorded this" and guards that meaning
    // carefully; a withheld number is a third thing and has to look like one.
    expect(WITHHELD).not.toBe("—");
  });

  it("takes a size denominated in the account's currency, and keeps contracts", () => {
    hideAmounts(true);
    expect(maskIfQuote("quote", "10,000")).toBe(WITHHELD);
    // Two contracts is a fact about the instrument and does not scale with
    // the account — hiding it would take the journal's subject matter away.
    expect(maskIfQuote("base", "2")).toBe("2");
  });
});

describe("with it off, which is how it ships", () => {
  it("formats exactly as it always did", () => {
    expect(amountsHidden()).toBe(false);
    expect(fmtMoney(1234)).toBe("+$1,234");
    expect(fmtMoney(-12.5)).toBe("-$12.50");
    expect(fmtAmount(1234)).toBe("$1,234");
    expect(fmtFees(12.5)).toBe("$12.50");
    expect(fmtMoney(null)).toBe("—");
    expect(maskIfQuote("quote", "10,000")).toBe("10,000");
  });

  it("goes back to the same numbers when it is turned off", () => {
    // Nothing is stored, nothing is recomputed: it is a decision about what
    // to print, and the printing is all that changes.
    const before = fmtMoney(4321);
    hideAmounts(true);
    expect(fmtMoney(4321)).toBe(WITHHELD);
    hideAmounts(false);
    expect(fmtMoney(4321)).toBe(before);
  });
});

describe("the text the journal generates for itself", () => {
  it("withholds the money in a scalp line too", () => {
    /*
     * describeScalp builds the line a scalp is read back as, and it goes
     * through the formatters like everything else — so the mode reaches text
     * that is assembled rather than laid out, which is exactly the kind of
     * place a per-call-site rule forgets.
     */
    const s: any = { symbol: "BTC", direction: "long", netPnl: 310, riskAmount: 100 };
    expect(describeScalp(s)).toContain("$310");
    hideAmounts(true);
    const masked = describeScalp(s);
    expect(masked).toContain(WITHHELD);
    expect(masked).not.toContain("$");
  });
});

/**
 * The guard that keeps it true tomorrow.
 *
 * Public mode works because every account-currency figure goes through one of
 * three formatters. That is not a property of the code so much as a habit,
 * and a habit needs something to notice when it lapses — the failure mode is
 * silent by construction: a new card interpolates a dollar sign directly, the
 * mode still looks like it works everywhere you happen to check, and the one
 * figure that got through is on the screenshot.
 *
 * So the source is read. Anything writing a currency symbol straight into a
 * template has to be named here, with a reason, and the reasons are the same
 * two every time: it is the formatter itself, or it is a contract's point
 * value, which is a published fact about an instrument and scales with
 * nobody's account.
 */
describe("nothing prints money behind the formatters' back", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");

  const ALLOWED = new Map<string, string>([
    ["shared/metrics.ts", "the formatters themselves — where the mask is applied"],
    [
      "client/src/components/symbol-picker.tsx",
      "a contract's point value: $20/pt is the exchange's spec, not your size",
    ],
    ["client/src/pages/trade-view.tsx", "the same point value, on the trade's own header"],
  ]);

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(name)) out.push(full);
    }
    return out;
  }

  it("has no unaccounted currency symbol in a template literal", () => {
    const offenders: string[] = [];
    for (const file of [...walk("client/src"), ...walk("shared")]) {
      const rel = file.replace(/\\/g, "/");
      if (ALLOWED.has(rel)) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          // A literal "$" immediately before an interpolation is a figure
          // being built by hand; "${x}" alone is ordinary and fine.
          if (line.includes("$${")) offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 90)}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the allowlist honest", () => {
    // An entry that no longer matches anything is an entry that stops being
    // read, and the next one added inherits its authority.
    for (const [rel, why] of ALLOWED) {
      expect(why.length, rel).toBeGreaterThan(10);
      expect(readFileSync(rel, "utf8"), rel).toContain("$${");
    }
  });
});
