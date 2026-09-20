/**
 * Whether this screen is allowed to say what anything was worth.
 *
 * A journal you can show someone is a different object from a journal you
 * keep. R, the verdicts, the equity SHAPE, the discipline — all of that is
 * the interesting part and none of it says how much money you have. The
 * account-currency figures say exactly that, on every row, and there are
 * about a hundred and thirty places they are printed.
 *
 * Which is why this is a switch the formatters read rather than a prop each
 * caller passes. A prop threaded through a hundred and thirty call sites is a
 * hundred and thirty chances to miss one, and missing one is the entire
 * failure: the point of the mode is that a screenshot can be posted without
 * being read for the one figure that got through. A choke point cannot be
 * forgotten, and anything new that formats money is covered the day it is
 * written.
 *
 * It is presentation and nothing else. No stored trade changes, no total is
 * recomputed, and turning it off shows the same numbers that were always
 * there — this module holds no data and never has.
 */

/**
 * Not an em-dash, deliberately.
 *
 * The journal uses "—" throughout to mean "nobody recorded this", and that
 * distinction is load-bearing: an unlogged stop and a stop of zero are
 * different facts and the page is careful to say which. A withheld figure is
 * a third thing, and giving it the missing-data glyph would quietly turn
 * every masked number into a gap in the record.
 */
export const WITHHELD = "•••";

let hidden = false;

/**
 * Turn the masking on or off. Called by the provider that owns the setting,
 * during its render, so that nothing underneath it can paint a figure before
 * the answer is in.
 */
export function hideAmounts(on: boolean): void {
  hidden = on;
}

/** Whether account-currency figures are being withheld right now. */
export function amountsHidden(): boolean {
  return hidden;
}

/**
 * The mask, or null to carry on and format normally.
 *
 * Written as a guard the formatters return early on, so the shape of every
 * one of them stays "is this hidden, then is this missing, then the number".
 */
export function maskAmount(): string | null {
  return hidden ? WITHHELD : null;
}

/**
 * A position size, withheld when it is denominated in the account's currency.
 *
 * "10,000 USD" says as much about the size of the account as the P&L does, so
 * a quote-denominated size is an amount like any other. Base units are not:
 * two contracts is a fact about the instrument, it does not scale with the
 * account, and hiding it would take the journal's own subject matter away.
 */
export function maskIfQuote(sizeUnit: string, shown: string): string {
  return sizeUnit === "quote" ? (maskAmount() ?? shown) : shown;
}
