import { beforeEach, describe, expect, it } from "vitest";
import {
  agoLabel,
  clearDraft,
  draftDiffers,
  draftFromTrade,
  readDraft,
  stashDraft,
  type TradeDraft,
} from "../client/src/lib/trade-draft";
import { trade } from "./helpers";

/** localStorage, as much of it as this module uses. */
function stubStorage() {
  const map = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    get length() {
      return map.size;
    },
  };
  return map;
}

const t = trade({ id: 7, symbol: "BTC", entryPrice: 100, initialStop: 90, exitPrice: 118 });

describe("the trade as a draft", () => {
  it("round-trips through the editor's shape unchanged", () => {
    // The property the whole feature rests on: loading a trade and comparing
    // it against itself must find nothing. If these two ever disagree about
    // how one field is formatted, every trade ever opened comes back wearing
    // a "restored unsaved edits" banner it never earned.
    expect(draftDiffers(draftFromTrade(t), draftFromTrade(t))).toBe(false);
  });

  it("shows the contract you typed, not the rollup it collapsed to", () => {
    const micro = trade({ id: 8, symbol: "BTC", contract: "MBTZ6" });
    expect(draftFromTrade(micro).f.symbol).toBe("MBTZ6");
  });

  it("leaves an absent number blank rather than writing the word null", () => {
    const pending = trade({ id: 9, status: "pending", initialStop: null, initialTarget: null });
    expect(draftFromTrade(pending).f.initialStop).toBe("");
    expect(draftFromTrade(pending).f.initialTarget).toBe("");
  });
});

describe("spotting a real edit", () => {
  const base = draftFromTrade(t);
  const changed = (over: Partial<TradeDraft>): TradeDraft => ({ ...base, ...over });

  it("sees a changed text field", () => {
    expect(draftDiffers(changed({ f: { ...base.f, notes: "was a fib retest" } }), base)).toBe(true);
  });

  it("treats a missing field and an empty one as the same", () => {
    // The editor only populates a key once something touches it. A form that
    // never rendered the fees input has no `fees` key at all, and calling that
    // an edit would stash a draft for every trade merely opened.
    const withoutKey = { ...base.f };
    delete withoutKey.fees;
    expect(draftDiffers(changed({ f: withoutKey }), changed({ f: { ...base.f, fees: "" } }))).toBe(
      false,
    );
  });

  it("sees every non-text axis too", () => {
    expect(draftDiffers(changed({ direction: "short" }), base)).toBe(true);
    expect(draftDiffers(changed({ lifecycle: "open" }), base)).toBe(true);
    expect(draftDiffers(changed({ styleId: 3 }), base)).toBe(true);
    expect(draftDiffers(changed({ sizeUnit: "quote" }), base)).toBe(true);
    expect(draftDiffers(changed({ source: "Severin" }), base)).toBe(true);
    expect(draftDiffers(changed({ exitReason: "stop" }), base)).toBe(true);
    expect(draftDiffers(changed({ nmo: "target_first" }), base)).toBe(true);
    expect(draftDiffers(changed({ selectedTags: [1] }), base)).toBe(true);
    expect(draftDiffers(changed({ highlights: ["Perfect Entry"] }), base)).toBe(true);
    expect(draftDiffers(changed({ extraTps: ["130"] }), base)).toBe(true);
    expect(
      draftDiffers(changed({ grades: { entry: "a", stop: null, exit: null } }), base),
    ).toBe(true);
  });

  it("counts a reordered list as a change", () => {
    // Scale-out levels are ordered — 130 then 140 is a different plan from
    // 140 then 130 — so set-equality would silently drop a real edit.
    const a = changed({ extraTps: ["130", "140"] });
    const b = changed({ extraTps: ["140", "130"] });
    expect(draftDiffers(a, b)).toBe(true);
  });
});

describe("stashing", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = stubStorage();
  });

  const base = draftFromTrade(t);

  it("keeps a draft that says something", () => {
    stashDraft(7, { ...base, f: { ...base.f, notes: "half back at 118" } }, base);
    expect(readDraft(7)?.draft.f.notes).toBe("half back at 118");
    expect(readDraft(7)?.savedAt).toBeTruthy();
  });

  it("stores nothing for a trade merely opened and closed again", () => {
    stashDraft(7, base, base);
    expect(store.size).toBe(0);
    expect(readDraft(7)).toBeNull();
  });

  it("drops the draft when the edit is undone by hand", () => {
    // Typing something and deleting it must leave the trade as clean as never
    // having opened it — otherwise the banner appears over an empty change.
    stashDraft(7, { ...base, f: { ...base.f, notes: "typo" } }, base);
    expect(store.size).toBe(1);
    stashDraft(7, base, base);
    expect(store.size).toBe(0);
  });

  it("keeps drafts of different trades apart", () => {
    stashDraft(7, { ...base, f: { ...base.f, notes: "seven" } }, base);
    stashDraft(8, { ...base, f: { ...base.f, notes: "eight" } }, base);
    expect(readDraft(7)?.draft.f.notes).toBe("seven");
    expect(readDraft(8)?.draft.f.notes).toBe("eight");
    clearDraft(7);
    expect(readDraft(7)).toBeNull();
    expect(readDraft(8)?.draft.f.notes).toBe("eight");
  });

  it("treats junk as no draft rather than half-restoring one", () => {
    store.set("edgeline.draft.trade.7", "{not json");
    expect(readDraft(7)).toBeNull();
    store.set("edgeline.draft.trade.7", JSON.stringify({ draft: { f: "nope" } }));
    expect(readDraft(7)).toBeNull();
    store.set("edgeline.draft.trade.7", JSON.stringify({ nothing: true }));
    expect(readDraft(7)).toBeNull();
  });

  it("survives a storage that refuses to write", () => {
    // Private mode, a full quota, a browser set to block site data. Losing the
    // draft is the old behaviour; taking the editor down with it is worse.
    (globalThis as any).localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => stashDraft(7, base, base)).not.toThrow();
    expect(() => clearDraft(7)).not.toThrow();
    expect(readDraft(7)).toBeNull();
  });
});

describe("how long ago it was typed", () => {
  const now = new Date("2026-08-24T12:00:00Z").getTime();
  const ago = (ms: number) => agoLabel(new Date(now - ms).toISOString(), now);

  it("reads in the units a person would use", () => {
    expect(ago(10 * 1000)).toBe("just now");
    expect(ago(7 * 60000)).toBe("7 min ago");
    expect(ago(3 * 3600e3)).toBe("3 hours ago");
    expect(ago(3600e3)).toBe("1 hour ago");
    expect(ago(2 * 86400e3)).toBe("2 days ago");
    expect(ago(86400e3)).toBe("1 day ago");
  });

  it("says something rather than NaN for a broken timestamp", () => {
    expect(agoLabel("not a date", now)).toBe("earlier");
  });
});
