import { describe, expect, it } from "vitest";
import { itemise } from "../client/src/components/xp";

/**
 * The line under an XP toast. Four trades earning the same +5 is one fact,
 * not four lines of identical text — which is what the toast showed, because
 * a cap of four lines was being spent entirely on copies of the first event.
 */
describe("itemising XP events", () => {
  it("folds repeats into one line with a count", () => {
    expect(
      itemise([
        { label: "Entered with stop and target", points: 5 },
        { label: "Entered with stop and target", points: 5 },
        { label: "Entered with stop and target", points: 5 },
        { label: "Closed with a named exit", points: 10 },
      ]),
    ).toBe("Entered with stop and target +5 ×3 · Closed with a named exit +10");
  });

  it("leaves a single event alone", () => {
    expect(itemise([{ label: "Reviewed the day in writing", points: 15 }])).toBe(
      "Reviewed the day in writing +15",
    );
  });

  it("still caps at four distinct lines", () => {
    const many = ["a", "b", "c", "d", "e"].map((label) => ({ label, points: 1 }));
    expect(itemise(many).split(" · ")).toHaveLength(4);
  });

  it("is empty for nothing", () => {
    expect(itemise([])).toBe("");
  });
});
