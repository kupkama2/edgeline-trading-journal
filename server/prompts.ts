/**
 * Every instruction the app sends to a vision or language model, in one place.
 *
 * These are product surface, not plumbing: most of the bugs this project has
 * shipped were sentences in these strings (a normalisation rule that destroyed
 * the micro/e-mini distinction, a table shape the model was never told about).
 * Keeping them out of routes.ts means a prompt edit is reviewable as what it
 * is, and the transport code stays boring.
 */
export const SETUP_PROMPT = `You are reading a screenshot to fill in a new trade's setup. The screenshot will be EITHER of two things — figure out which one it is first.

(A) A TradingView-style chart with a plotted long/short position tool.
- The entry price, stop-loss price, and take-profit price are almost always printed as exact numeric labels on the RIGHT-HAND price axis (the right edge of the chart), each sitting next to its own coloured horizontal line. Read those right-axis numeric labels directly for entryPrice/initialStop/initialTarget — they are far more reliable than estimating off gridlines.
- Direction from colour/position: if the blue entry marker/line has its shaded zone extending UPWARD from the entry price (blue is up), the trade is a LONG. If the blue marker/zone extends DOWNWARD from entry (blue is down), the trade is a SHORT. Cross-check with the standard convention where the profit zone is green and the loss zone is red/pink — green above entry confirms long, green below entry confirms short.
- Also look for the ticker/symbol label and any position size / quantity readout on the chart.

(C) A TradingView chart showing LIVE BROKER ORDER LINES — not a drawn position tool. This looks different from (A): each line is the broker's own working order, drawn edge to edge with a small badge on it, and usually an "×" button to cancel it. There are no shaded profit/loss zones.
- The ENTRY is the line whose badge names an order type in words: "Sell Limit", "Buy Limit", "Sell Stop", "Buy Stop", "Sell Market", "Buy Market". Its wording gives the direction outright — "Sell …" is a SHORT, "Buy …" is a LONG. Do not infer direction from colour here.
- The other two lines are its bracket, and each badge shows a PROJECTED PROFIT OR LOSS in currency, like "+204.50 USD" or "−54.00 USD". The sign is the reliable discriminator: the line whose amount is POSITIVE is the take profit (initialTarget), the line whose amount is NEGATIVE is the stop (initialStop). Use the sign, not the position on screen and not the colour — for a short the target sits BELOW the entry and the stop ABOVE, which is the reverse of a long, and the right-axis badges are often coloured by proximity to price rather than by role. A green axis badge does NOT mean take profit.
- Read each of the three prices from the number on the RIGHT-HAND price axis at that line's height.
- The leading number in a badge (e.g. the "1" in "1 | −54.00 USD") is the QUANTITY in contracts, not a price. Use it for size.
- These are RESTING orders, so the trade has not happened yet: isClosed is false, and exitPrice/exitTime/exitReason stay null. A separate highlighted band on the axis is just the live market price — never an entry, a stop or a target.
- If no ticker is printed anywhere on the image, set symbol to null rather than guessing from the price level.

(B) A broker order log / order history table with columns such as Symbol, Side, Type, Qty, Remaining Qty, Filled Qty, Limit Price, Stop Price, Take Profit, Stop Loss, Avg Fill Price, Status, Update Time, Order ID, Expiry.
- Find the order that OPENED the position: the row with Status "Filled" whose Type is a plain entry type ("Limit", "Market", "Stop") — NOT a "Stop Loss" or "Take Profit" type row. If several symbols/trades appear, use the entry order that is chronologically most recent (latest Update Time) unless context makes another one clearly intended.
- direction: "long" if that entry order's Side is "Buy", "short" if "Sell".
- entryPrice: that entry order's Avg Fill Price (fall back to its Limit Price, then Stop Price, if Avg Fill Price is blank).
- size: that entry order's Filled Qty (fall back to Qty).
- entryTime: that entry order's Update Time.
- initialStop: the Stop Price (or Stop Loss column) of the "Stop Loss" type row tied to the same symbol/entry — use it even if that row's Status is "Filled" (it still reflects the ORIGINAL planned stop) or "Cancelled".
- initialTarget: the Limit Price (or Take Profit column) of the "Take Profit" type row tied to the same symbol/entry — use it even if its Status is "Cancelled" (a cancelled take-profit still tells you the original target).

CLOSED-TRADE DETECTION (applies to both A and B): decide whether the screenshot shows a trade that is ALREADY FINISHED, i.e. an exit is visible — not just a plan.
- In a broker order log (B), the position is CLOSED whenever a closing fill is visible. Concretely: if the "Stop Loss" row OR the "Take Profit" row tied to the entry has Status "Filled", the trade is closed — that filled protective order IS the exit. A second plain entry-type row on the same symbol with the OPPOSITE Side, Filled for the same quantity, also closes it. Note the double duty here: a Filled "Stop Loss" row supplies BOTH initialStop (the planned stop level) AND the exit (isClosed true, exitPrice = its Avg Fill Price, falling back to Stop Price / Limit Price; exitTime = its Update Time). Rows with Status "Cancelled" or "Working" do NOT close the trade.
- On a chart (A), the position is closed when BOTH an entry marker AND an exit/close marker are drawn (e.g. a completed position tool showing where the trade was closed, a "closed" P&L readout, or an explicit exit label/arrow at a later bar). A plain position tool showing only entry + stop + target with no exit marker is NOT closed.
- If it is closed, also set exitReason to the best fit. Report only what the image shows, never a judgement about whether the exit was well timed: "target" (closed at/near the take-profit), "stop" (closed at/near the stop loss), "breakeven" (closed at/near entry), "trailed" (closed at a trailed stop between entry and target), "discretion" (closed at some other price, in profit or in loss, with the original stop and target both untouched), or "other" if you cannot tell.
- If NOTHING in the image shows an exit, set isClosed to false and leave exitPrice, exitTime and exitReason null. Never invent an exit.

Symbol: report the ticker EXACTLY as printed on the screenshot — "MNQU6", not "NQ". Do not roll a micro up to its full-size sibling and do not strip the month/year contract code. The application does that rollup itself, and it needs the contract as written to tell a micro apart from an e-mini: they are the same instrument for grouping but differ tenfold in dollars per point.

ALSO REPORT whether this image is an orders TABLE listing SEVERAL DIFFERENT trades, rather than a chart or a single position. Set looksLikeOrdersTable true only when the table holds MORE THAN ONE distinct order — that is, more than one entry price.

Count orders, not rows. A single bracketed order occupies three rows in a working-orders table: the parent (Status "Working", Type "Limit") plus its Take Profit and Stop Loss children (Status "Inactive", opposite Side, same Qty and Symbol). That is ONE trade, so looksLikeOrdersTable is FALSE and you should report it as the single order it is — the parent's Limit Price is entryPrice, its Take Profit column (or the Take Profit child's price) is initialTarget, its Stop Loss column (or the Stop Loss child's price) is initialStop, and the parent's Side gives the direction.

Respond with STRICT JSON only, no prose, no markdown fences:
{"symbol": string|null, "direction": "long"|"short"|null, "entryPrice": number|null, "initialStop": number|null, "initialTarget": number|null, "entryTime": string|null, "size": number|null, "isClosed": boolean, "exitPrice": number|null, "exitTime": string|null, "exitReason": "target"|"stop"|"trailed"|"breakeven"|"discretion"|"other"|null, "looksLikeOrdersTable": boolean}

Rules:
- Output ONLY the JSON object. Do not wrap it in markdown code fences, do not add explanations, citations or any prose before or after it.
- entryTime and exitTime must be ISO 8601 strings if a date/time is legible, otherwise null.
- Use null for anything that is not clearly legible or not applicable. Never guess wildly.
- Numbers must be plain JSON numbers (no currency symbols, no thousands separators, no commas).`;

/**
 * Reads an orders table screenshot as MANY resting orders, not one position.
 *
 * SETUP_PROMPT deliberately hunts for the single order that opened a position;
 * this is the opposite job — a venue's open-orders list, every row of which is
 * a trade that could still open. Kept as a separate prompt because merging the
 * two would make both worse: "find the one that matters" and "return all of
 * them" pull in opposite directions.
 */
/**
 * The venue, where the trader has said which one.
 *
 * The prompt below describes three quite different table shapes and has to
 * work out which it is looking at. Being told removes that guess — and the
 * guess is where it goes wrong, because a Binance row and a broker DOM row
 * carry the same fields under different names.
 */
export function ordersPrompt(ctx: { venue?: string } = {}) {
  const hint =
    ctx.venue === "binance"
      ? "\n\nThe trader has said this is a BINANCE screen, so expect shape (A) or (C) and read sizes as quote notional unless the column plainly says otherwise."
      : ctx.venue === "tradingview"
        ? "\n\nThe trader has said this is a TRADINGVIEW or futures-broker screen, so expect shape (B): contracts rather than notional, and bracket children beneath their parent."
        : "";
  return ORDERS_PROMPT + hint;
}

export const ORDERS_PROMPT = `You are reading a screenshot from a trading venue showing resting/open orders that have not been filled yet. Extract EVERY order you can read.

Common shapes:
(A) Crypto exchange (Binance and similar): columns like Time, Symbol, Type, Side, Price, Amount, Filled, Reduce Only. Side reads "Open Long"/"Open Short" or "Buy"/"Sell". Amount is usually quote notional such as "37,177.47 USDT". This view typically has NO stop loss or take profit — leave them null, do not invent them.
(B) Futures broker / DOM (TradingView and most DOMs): columns like Symbol, Side, Type, Qty, Remaining Qty, Filled Qty, Limit Price, Stop Price, Take Profit, Stop Loss, Avg Fill Price, Status, Update Time. Qty is contracts. Take Profit maps to initialTarget and Stop Loss to initialStop.

  CRITICAL — one bracketed order occupies THREE rows in this view, and it is ONE order, not three. The parent row has Type "Limit" (or "Stop", "Market") and Status "Working". Directly beneath it sit its two children: Type "Take Profit" and Type "Stop Loss", each with Status "Inactive", the OPPOSITE Side to the parent, and the same Qty and Symbol. Return ONLY the parent. Read the children's prices into the parent's initialTarget and initialStop if the parent's own Take Profit / Stop Loss columns are blank; if those columns are already filled, the children are duplicates and add nothing. Never emit a row whose Type is "Take Profit" or "Stop Loss" as an order of its own — its Limit Price is an exit level, and returning it invents a trade that does not exist.
(C) A bracket / OTOCO / "Take Profit Stop Loss" confirmation dialog for ONE order. It lists legs rather than columns: Order A is the entry (its Price is entryPrice, its Side gives the direction, its Amount is the size), Order B is the take profit and Order C is the stop loss. Both B and C label their level "Stop Price" — tell them apart by which order block they sit in, NOT by the number. Return exactly ONE order for a dialog like this, carrying entryPrice, initialTarget from B and initialStop from C. These dialogs usually do not name the instrument: if no ticker is visible, set symbol to null rather than guessing one — a wrong ticker attaches the levels to the wrong trade.

For every order:
- direction: "long" for Buy / Open Long, "short" for Sell / Open Short.
- entryPrice: the limit/entry price for that order (Price, or Limit Price).
- size: the position size as printed.
- sizeUnit: "quote" when the size is a currency amount (e.g. "4,655.18 USDT" — a USD/USDT notional), "base" when it is a contract or coin count (e.g. Qty 2).
- initialStop / initialTarget: only if the screenshot actually shows them; otherwise null.
- entryTime: the row's timestamp as ISO 8601 if legible, otherwise null.
- symbol: the ticker as printed, minus any "Perp" badge.

Rules:
- Return every DISTINCT order. Two rows on the same symbol at different entry prices are two separate orders and both must be returned. But a parent and its own Take Profit / Stop Loss children are one order — count orders, not rows.
- Ignore header rows, totals, and any row that is clearly a filled/closed position rather than a resting order.
- STOP if the instruments are dated futures contracts (MNQU6, MBTQ6, ESZ5 — letters, a month letter, a year digit) AND the rows show filled quantities. That is a futures broker's execution log, not resting orders. Return {"orders": []}.
- STOP if the table is an EXECUTION LOG rather than a list of resting orders — a "Filled Qty" column with non-zero values, "Remaining Qty" reading 0, an "Avg Fill Price" column with prices in it, or a tab reading "Filled". Those rows are history: they cannot open anything, and returning them as orders invents positions the trader already closed. Return {"orders": []} and nothing else.
- entryPrice is the identity of an order: it is what lets a shape (C) dialog be matched to the row it brackets, so read it exactly, to every decimal shown.
- Output ONLY this JSON object, no prose and no markdown fences:
{"orders": [{"symbol": string|null, "direction": "long"|"short"|null, "size": number|null, "sizeUnit": "base"|"quote"|null, "entryPrice": number|null, "initialStop": number|null, "initialTarget": number|null, "entryTime": string|null}]}
- Numbers must be plain JSON numbers: no currency symbols, no thousands separators.
- If you cannot read a field, use null rather than guessing.
- If the image shows no resting orders at all, return {"orders": []}.`;

/**
 * Reads a week of written reflections against the week's numbers.
 *
 * The value here is the cross-reference, not the summary: the trader already
 * knows what they wrote and can already see the stats. What neither shows on its
 * own is whether the story in the notes matches the record — hence the explicit
 * instruction to report where they disagree, and the ban on inventing a pattern
 * from a single trade.
 */
export const WEEKLY_INSIGHTS_PROMPT = `You are reviewing one week of a trader's journal. You get two things: their own written reflections on individual trades, and the computed statistics for the same week.

The reflections are where they wrote what they would have done differently, or what the "perfect version" of the trade looked like. Those are self-diagnoses. The statistics are the record. Your job is to find what is TRUE ACROSS the week — not to summarise trade by trade, which they can already read.

The writing comes in two forms and both count as reflections for every rule below: per-trade notes (in "reflections", each tied to one trade's outcome) and end-of-day reviews (in "dayNotes", free-form, written about the whole session). A theme may draw its evidence from either or both. Day notes often contain what the per-trade notes omit — state of mind, what they skipped, plans for tomorrow — and a plan written on Monday that the rest of the week's data shows was not followed is exactly the kind of contradiction to report.

Produce four things:

1. themes — recurring ideas that appear in MULTIPLE reflections. A theme needs at least two trades behind it; one trade is an anecdote, not a pattern. For each, give the theme in the trader's own vocabulary where possible, how many trades it appeared in, and up to two short verbatim fragments as evidence. If nothing recurs, return an empty list rather than padding it.

2. focus — the single most correctable pattern to work on next week, and one sentence on why that one. Prefer a pattern that is both frequent AND expensive over one that is merely annoying. Exactly one.

3. oneChange — one concrete, checkable action for next week. It must be something they could verify they did or did not do ("wait for a 5m close beyond the level before entering"), not an attitude ("be more patient").

4. contradictions — places the reflections and the numbers DISAGREE. This is the most valuable output. Examples: notes repeatedly blame exiting too early while the capture ratio is high; notes describe good discipline while the same demon fired five times; notes never mention size while the losses cluster in the largest positions. If there is no genuine disagreement, return an empty list — do not manufacture one.

Rules:
- Ground every claim in the data you were given. Never infer trades, prices, or events that are not present.
- A negative totalDeltaR means their management LOST money versus leaving the trade alone; positive means it gained.
- Each reflection may carry exitGrade (the trader's own verdict on the exit) and exitTiming (what the measured price path says: "early" = the move ran on after they left, "late" = it peaked while they were in and they closed below it, "clean" = neither cost was meaningful). When the two disagree, that IS a contradiction — report it.
- Do not moralise, and do not give generic trading advice. Say only what this week's evidence supports.
- Write in second person, plainly, no preamble.
- Output ONLY this JSON object, no prose and no markdown fences:
{"themes": [{"theme": string, "occurrences": number, "evidence": [string]}], "focus": {"name": string, "why": string}, "oneChange": string, "contradictions": [string]}

Here is the week:
{{BUNDLE}}`;

export function outcomePrompt(ctx: {
  symbol?: string;
  direction?: string;
  entryPrice?: number;
  initialStop?: number;
  initialTarget?: number;
}) {
  return `You are reading a TradingView-style chart screenshot taken AFTER a trade closed. It shows the full price path following the entry.

When prices are printed as exact numeric labels on the RIGHT-HAND price axis (the right edge of the chart) next to their coloured lines, read those labels directly for the clearest, most exact values — they are more reliable than estimating off gridlines or candle wicks.

The trade's ORIGINAL plan was:
- symbol: ${ctx.symbol ?? "unknown"}
- direction: ${ctx.direction ?? "unknown"}
- entry price: ${ctx.entryPrice ?? "unknown"}
- original stop loss: ${ctx.initialStop ?? "unknown"}
- original target: ${ctx.initialTarget ?? "unknown"}

Determine, from the visible price path. mae and mfe cover ONLY the stretch
between entry and exit — anything after the exit belongs to postExitPeak, never
to mfe. Mixing them inverts the trade's story.
1. mae — the worst price reached against the position WHILE IT WAS OPEN (lowest low for a long, highest high for a short, between entry and exit).
2. mfe — the best price reached in favour of the position WHILE IT WAS OPEN (highest high for a long, lowest low for a short, between entry and exit).
3. postExitPeak — AFTER the exit, the best price reached in the position's favour before price traded beyond the original stop level. null if the exit or the aftermath is not visible.
4. postExitAdverse — AFTER the exit, the worst price reached AGAINST the position (lowest low for a long, highest high for a short), over the same visible aftermath. This is the mirror of postExitPeak and is what says an exit was RIGHT: on a stop-out it is how much further it fell after taking the trader out. null if the aftermath is not visible.
5. noManagementOutcome — if the ORIGINAL stop and target levels above had been left untouched, which level would price have crossed FIRST? "target_first", "stop_first", or "undetermined" if the visible path never reaches either level or it is not legible.

Respond with STRICT JSON only, no prose, no markdown fences:
{"mae": number|null, "mfe": number|null, "postExitPeak": number|null, "postExitAdverse": number|null, "noManagementOutcome": "target_first"|"stop_first"|"undetermined"|null}

Numbers must be plain JSON numbers. Use null when a value is not legible.`;
}

export const RATIONALE_PROMPT = `You are a trading journal assistant. A trader jotted a quick, shorthand comment explaining WHY they took a trade — they typed fast and did not bother with full sentences or proper labeling.

Common shorthand you should recognize and expand: VAH / VAL / POC (volume profile Value Area High / Low / Point of Control), fib retracement levels written as bare numbers like "786", ".786", "618" (meaning the 78.6% / 61.8% Fibonacci retracement), "retest", "reject"/"rejection", OB (order block), FVG (fair value gap), liquidity sweep/grab, breakout, breakdown, EMA/VWAP bounce or reject, trendline break, supply/demand zone, higher-high/higher-low (HH/HL) or lower-high/lower-low (LH/LL) structure, news/FOMC, open range, gap fill.

Turn the comment into a short list of clean, standardized setup tags (Title Case, 2-5 words each) that capture the trader's stated reasoning — do not invent reasoning that isn't implied by the comment, and do not add generic tags like "Trade" or "Setup". If the comment contains no recognizable setup language, return an empty list rather than guessing.

Comment: "{{TEXT}}"

Respond with STRICT JSON only, no prose, no markdown fences:
{"tags": string[]}`;


/**
 * A broker's closed-position card — the summary strip an exchange shows for a
 * position that has finished, not a chart.
 *
 * Different question from outcomePrompt entirely. That one reads a price path
 * off a chart and infers what would have happened; this reads printed numbers
 * off a receipt. The values are stated, so the instruction is to transcribe
 * rather than estimate, and to return null instead of the nearest plausible
 * figure when a field is not on the card.
 */
export function closeCardPrompt(ctx: {
  symbol?: string;
  direction?: string;
  entryPrice?: number;
}) {
  return `You are reading a screenshot from a crypto exchange (Binance Futures, Bybit, OKX or similar) that records HOW A TRADE ENDED. It is printed labels and numbers — a card, a table row, or an order with its fills — not a chart. Transcribe what is printed. Do not estimate, and do not infer anything that is not written.

It will be ONE of these three layouts. Work out which, then read it.

A. A CLOSED POSITION CARD. Big labels: "Realized PNL", "ROI", "Entry Price", "Avg. Close Price", "Closed Vol", with the direction as "Cross Short" or "Isolated Long" and opened/closed timestamps side by side.

B. A TRADE HISTORY ROW. A single line under column headers such as: Time | Market | Direction | Price | Size | Trade Value | Fee | Closed PNL. The headers may be in a SECOND image, or missing entirely — in that case infer the columns from their shape: a timestamp, a ticker, a direction, then numbers, with currency suffixes on the money columns. "Close Long" means the POSITION was long; "Close Short" means it was short.

C. AN ORDER WITH ITS FILLS. A summary line (symbol, type, direction, "Average", "Executed", "Amount", "Status: Filled"), often with "Total PNL" and "Total Fee" beneath it, and then a table of individual fills: Time | Trading Price | Executed | Fee | Role | PNL | Total. Read the summary AND every fill row you can see. The summary is OFTEN CROPPED OUT, leaving only the fill table under its headers: SEVERAL rows sharing one timestamp, or a Role column reading "Taker"/"Maker", is layout C with no summary — never layout B. B is ONE row. When the summary is missing, leave exitPrice, size and realizedPnl null unless you can add them up from the rows themselves, and fill in every fill row.

For context, the trade being closed in the journal is:
- symbol: ${ctx.symbol ?? "unknown"}
- direction: ${ctx.direction ?? "unknown"}
- entry price: ${ctx.entryPrice ?? "unknown"}
If the screenshot is plainly a different instrument, still report what it says — the mismatch is handled elsewhere.

Read these fields:
1. symbol — the contract as printed, e.g. "BTCUSDT" or "ZROUSDT".
2. direction — the side of the POSITION, "long" or "short". "Close Long" and "Sell" both close a long; "Close Short" and "Buy" close a short. Colour alone is not evidence.
3. exitPrice — the average price the position came OFF at: "Avg. Close Price" (A), "Price" (B), "Average" (C). Never the entry price.
4. entryPrice — only where the screenshot prints one. Layouts B and C usually do not; use null.
5. exitTime — when it closed, as "YYYY-MM-DDTHH:mm:ss" exactly as printed, with NO timezone conversion. Dates are usually MM/DD/YYYY. A duration like "Lasting 10h 34m" is not a timestamp.
6. entryTime — the opened timestamp where there is one, same format, else null.
7. size — the quantity closed: "Closed Vol" (A), "Size" (B), "Executed"/"Amount" (C). The number only. "Max OI" is NOT this.
8. realizedPnl — the realised profit or loss for the close, signed: "Realized PNL", "Closed PNL", "Total PNL". If no total is printed but every fill row has a PNL, add those up.
9. pnlCurrency — the unit PnL is printed in: USDT, USDC, BNFCR. From the label, not assumed.
10. roiPercent — signed, plain number, where printed; else null.
11. leverage — a number, so "150x" is 150; else null.
12. fee — the TOTAL fee for this close, positive: "Fee" (B) or "Total Fee" (C). If only per-fill fees are shown, add them up.
13. feeCurrency — the unit the fee is printed in.
14. isClosed — true if it shows the position or order as closed/filled, false if still open.
15. fills — layout C only (summary or not), and only for rows you can actually read. One object per fill row: {"time": "YYYY-MM-DDTHH:mm:ss", "price": number, "size": number, "fee": number|null, "pnl": number|null}. Use the row's own time even when every row shares it. Empty array for layouts A and B.

Respond with STRICT JSON only, no prose, no markdown fences:
{"symbol": string|null, "direction": "long"|"short"|null, "exitPrice": number|null, "entryPrice": number|null, "exitTime": string|null, "entryTime": string|null, "size": number|null, "realizedPnl": number|null, "pnlCurrency": string|null, "roiPercent": number|null, "leverage": number|null, "fee": number|null, "feeCurrency": string|null, "isClosed": boolean|null, "fills": [{"time": string|null, "price": number|null, "size": number|null, "fee": number|null, "pnl": number|null}]}

Every field must be present. Use null for anything not legible or not printed, and [] for fills where there is no fill table.`;
}

/**
 * A filled-order log — the "Filled" tab of a futures broker's order window.
 *
 * Deliberately dumb: it transcribes rows and does not try to work out which
 * rows belong to which trade. That is a question about the running position
 * rather than about any row, it is arithmetic, and `tradesFromFills` does it
 * where it can be tested. A model asked to do both tends to answer the second
 * question by guessing, and a guessed trade boundary is invisible afterwards.
 */
export const FILL_LOG_PROMPT = `You are reading a screenshot of a trading account's FILLED ORDERS — an execution log. Every row is one order that actually filled. Transcribe every row you can read. Do not work out which rows belong to which trade, do not pair entries with exits, and do not skip a row because you think it is an exit: return them all, in the order they appear, and the pairing is done elsewhere.

Typical columns (Tradovate, NinjaTrader, TradingView, Rithmic and similar):
Symbol | Side | Type | Qty | Remaining Qty | Filled Qty | Limit Price | Stop Price | Take Profit | Stop Loss | Avg Fill Price | Update Time | Order ID | Expiry

For every filled row read:
1. symbol — the contract as printed, e.g. "MNQU6", "MBTQ6", "ESZ5". Keep the month and year code.
2. side — "buy" or "sell", from the Side column. Not from the colour.
3. kind — the Type column verbatim: "Limit", "Stop", "Stop Loss", "Market", "Take Profit", "Trailing Stop".
4. qty — the FILLED quantity. Use "Filled Qty" where there is one; fall back to "Qty" only when there is not. Never "Remaining Qty".
5. price — the price it actually filled at: "Avg Fill Price". Only if that column is missing or blank, fall back to Limit Price, then Stop Price.
6. time — "Update Time" (or "Fill Time" / "Time"), as "YYYY-MM-DDTHH:mm:ss" exactly as printed, with NO timezone conversion. Keep the seconds.
7. stopPrice — the Stop Price column where the row has one, else null. This is the trigger level, not the fill.

Rules:
- ONLY rows that filled. If the screenshot shows a status column, skip anything reading Cancelled, Rejected, Working, Inactive, Expired or Pending — an order that never filled did not happen, and including it makes the position count wrong for every row after it.
- A row with Filled Qty 0 did not fill. Skip it.
- Row order is whatever the table is sorted by and often is NOT time order. Return the rows as printed; the times decide the sequence later.
- Do not merge rows. Two fills on the same symbol at the same second are two rows.
- Numbers must be plain JSON numbers: no thousands separators, no currency symbols.
- If a field is not legible, use null rather than guessing. A guessed quantity turns every later row into a different trade.

FIRST, decide what you are looking at, and say so in isExecutionLog. This is the only judgement asked of you and it decides which screen the trader gets, so make it on evidence rather than impression:

  isExecutionLog is TRUE when the rows record orders that ALREADY FILLED. The tells, any one of which settles it: a "Filled Qty" column with non-zero values; a "Remaining Qty" column reading 0; an "Avg Fill Price" column with prices in it; a selected tab or status reading "Filled", "Executed" or "Completed"; an Order ID column beside a fill time; an "Expiry" column reading "Day".

  isExecutionLog is FALSE for RESTING orders — ones that have not filled and could still open a position. The tells: Filled Qty 0, Remaining Qty equal to Qty, a status of "Working", "Open", "Pending" or "Inactive", a Binance "Open Orders" tab, or a Take Profit / Stop Loss confirmation dialog for an order not yet placed.

  A table showing BOTH is an execution log: report true, and return only the rows that filled.

  The instrument names are evidence too. Dated futures contracts — two to four letters followed by a month letter and a year digit, such as MNQU6, MBTQ6, ESZ5, NQH6 — come from a futures broker (Tradovate, NinjaTrader, TradingView, Rithmic), never from Binance. A table of those with an Order ID column and filled quantities is an execution log, whatever else you think of it. Binance instruments look like BTCUSDT or ETHUSDC and often carry a "Perp" badge.

Output ONLY this JSON object, no prose and no markdown fences:
{"isExecutionLog": boolean, "fills": [{"symbol": string|null, "side": "buy"|"sell"|null, "kind": string|null, "qty": number|null, "price": number|null, "time": string|null, "stopPrice": number|null}]}

If the image is not an execution log, return {"isExecutionLog": false, "fills": []}.`;
