import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Browser storage, per account rather than per browser.
 *
 * The bug this closes is not a preference getting muddled. Trade ids are
 * global, drafts were keyed by trade id alone, and the editor restores a draft
 * it finds — so on a shared browser, opening YOUR trade 42 could pull up
 * somebody else's unsaved edits, announce them as restored, and let you save
 * them onto a trade they have nothing to do with. Another person's trading
 * record, leaking into yours through a form with a save button.
 *
 * Node has no localStorage, so the tests bring their own. It is the same
 * interface the module actually calls, which is the part worth exercising:
 * what the keys come out as, and what the one-time migration moves.
 */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    _dump: () => Object.fromEntries(map),
  };
}

let mod: typeof import("../client/src/lib/scoped-storage");

beforeEach(async () => {
  (globalThis as any).localStorage = fakeStorage();
  // A fresh module per test: the scope is module state, and a test that
  // inherited the previous one would be testing nothing.
  vi.resetModules();
  mod = await import("../client/src/lib/scoped-storage");
});

describe("keys before anyone has signed in", () => {
  it("leaves them alone", () => {
    // The login gate does not render the app until the session resolves, so
    // this window is theoretical — but a key that silently became "undefined"
    // in it would be a bug nobody could see.
    expect(mod.scopedKey("edgeline.riskBudget")).toBe("edgeline.riskBudget");
  });
});

describe("keys once an account is known", () => {
  it("puts the account into the name", () => {
    mod.setStorageScope(7);
    expect(mod.scopedKey("edgeline.riskBudget")).toBe("edgeline.u7.riskBudget");
    expect(mod.scopedKey("edgeline.draft.trade.42")).toBe("edgeline.u7.draft.trade.42");
  });

  it("keeps two accounts' drafts for the same trade id apart", () => {
    // The whole point. Same id, same browser, two people.
    mod.setStorageScope(1);
    mod.store.set("edgeline.draft.trade.42", "alice's unsaved edits");

    mod.setStorageScope(2);
    expect(mod.store.get("edgeline.draft.trade.42")).toBeNull();
    mod.store.set("edgeline.draft.trade.42", "bob's unsaved edits");

    mod.setStorageScope(1);
    expect(mod.store.get("edgeline.draft.trade.42")).toBe("alice's unsaved edits");
  });

  it("survives storage that refuses to answer", () => {
    // Private windows, full quotas, blocked cookies. None of them is a reason
    // for the editor to fall over, and every caller treats a miss as "nothing
    // stored" anyway.
    (globalThis as any).localStorage = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
      removeItem() {
        throw new Error("denied");
      },
    };
    expect(() => mod.store.set("edgeline.riskBudget", "300")).not.toThrow();
    expect(mod.store.get("edgeline.riskBudget")).toBeNull();
    expect(() => mod.store.remove("edgeline.riskBudget")).not.toThrow();
  });
});

describe("what was already in the browser", () => {
  it("moves the pre-accounts keys into the first account that signs in", () => {
    // Whoever has been using the app all along keeps their filters, their
    // budget and their drafts. Losing them would be a poor reward for adding
    // sign-in.
    const ls = (globalThis as any).localStorage;
    ls.setItem("edgeline.riskBudget", "300");
    ls.setItem("edgeline.activeStyleIds", "[1,2]");
    ls.setItem("edgeline.draft.trade.9", "half a trade");

    mod.setStorageScope(1);

    expect(mod.store.get("edgeline.riskBudget")).toBe("300");
    expect(mod.store.get("edgeline.activeStyleIds")).toBe("[1,2]");
    expect(mod.store.get("edgeline.draft.trade.9")).toBe("half a trade");
    // The originals are gone, so the NEXT account to sign in on this browser
    // does not inherit them too.
    expect(ls.getItem("edgeline.riskBudget")).toBeNull();
    expect(ls.getItem("edgeline.draft.trade.9")).toBeNull();
  });

  it("runs once, so a second account inherits nothing", () => {
    const ls = (globalThis as any).localStorage;
    ls.setItem("edgeline.riskBudget", "300");

    mod.setStorageScope(1);
    mod.setStorageScope(2);

    expect(mod.store.get("edgeline.riskBudget")).toBeNull();
    mod.setStorageScope(1);
    expect(mod.store.get("edgeline.riskBudget")).toBe("300");
  });

  it("never overwrites what the account already has", () => {
    const ls = (globalThis as any).localStorage;
    ls.setItem("edgeline.riskBudget", "300");
    ls.setItem("edgeline.u1.riskBudget", "500");

    mod.setStorageScope(1);

    expect(mod.store.get("edgeline.riskBudget")).toBe("500");
  });
});
