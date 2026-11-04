import { describe, expect, it } from "vitest";
import { cleanNumberText, parseLooseNumber } from "../shared/loose-number";

/** A number as it was copied, read as the number that was meant. */
describe("a copied number", () => {
  it("reads a Binance price, a European one, a Swiss one, and one with a currency", () => {
    expect(parseLooseNumber("79,582.3")).toBe(79582.3);
    expect(parseLooseNumber("79.582,3")).toBe(79582.3);
    expect(parseLooseNumber("79'582.3")).toBe(79582.3);
    expect(parseLooseNumber("79 582.3")).toBe(79582.3);
    expect(parseLooseNumber("$79,582.30")).toBe(79582.3);
    expect(parseLooseNumber("0.5 USDT")).toBe(0.5);
    expect(parseLooseNumber("1,234,567.89")).toBe(1234567.89);
    expect(parseLooseNumber("1.234.567,89")).toBe(1234567.89);
  });

  it("takes a lone comma as thousands when it groups three digits, as a decimal otherwise", () => {
    expect(parseLooseNumber("79,582")).toBe(79582);
    expect(parseLooseNumber("1,234")).toBe(1234);
    expect(parseLooseNumber("0,5")).toBe(0.5);
    expect(parseLooseNumber("1,25")).toBe(1.25);
    expect(parseLooseNumber("0,582")).toBe(0.582);
    expect(parseLooseNumber("3,1416")).toBe(3.1416);
  });

  it("leaves a plain number alone, keeps the sign, and refuses what is not a number", () => {
    expect(cleanNumberText("79582.3")).toBe("79582.3");
    expect(cleanNumberText("-1.5")).toBe("-1.5");
    expect(cleanNumberText("(1.5)")).toBe("-1.5");
    expect(cleanNumberText("+2")).toBe("2");
    expect(cleanNumberText(".5")).toBe(".5");
    expect(cleanNumberText("")).toBe("");
    expect(cleanNumberText("abc")).toBe("");
    expect(cleanNumberText("1.2.3.4")).toBe("1234");
    expect(parseLooseNumber("12%")).toBe(12);
  });
});
