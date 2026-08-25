/**
 * Browser storage, per account rather than per browser.
 *
 * Everything this app keeps client-side was written when there was one person
 * per database: view filters, a risk budget, the last account typed, and —
 * the one that matters — unsaved trade drafts, keyed by trade id.
 *
 * Trade ids are global. So on a shared browser, signing in as someone else and
 * opening YOUR trade 42 would find THEIR draft for trade 42, restore it into
 * the editor with a banner saying so, and let you save it onto a trade it has
 * nothing to do with. That is somebody else's trading record leaking into
 * yours through a form with a save button.
 *
 * So every key carries the account id. The scope is set by the login gate,
 * which does not render the app until the session has resolved — so by the
 * time anything below reads a key, the account is known.
 *
 * Two deliberate exceptions, both device preferences rather than records:
 * the theme, which belongs to the screen you are looking at, and the
 * navigation crumbs in lib/jump, which are written and consumed within one
 * click of each other and never outlive it.
 */

/** Null until the gate sets it — reads before that are anonymous by design. */
let account: number | null = null;

/**
 * Keys written before accounts existed, moved into the first account that
 * signs in after the upgrade. Losing them would silently reset the filters and
 * budget of the person who has been using the app all along, which is a poor
 * reward for adding sign-in.
 */
const LEGACY_FIXED = [
  "edgeline.activeStyleIds",
  "edgeline.activeAccounts",
  "edgeline.activeSources",
  "edgeline.activeStyleId",
  "edgeline.activeAccount",
  "edgeline.riskBudget",
  "edgeline.lastAccount",
  "edgeline.outcomes.lastCheck",
  "edgeline.coachDismissed",
  "edgeline.xp.seen",
];
const LEGACY_PREFIXES = ["edgeline.draft.trade."];

const MIGRATED = "edgeline.scoped";

export function setStorageScope(id: number) {
  if (account === id) return;
  account = id;
  migrateOnce(id);
}

/** The scoped name for a bare key. Unscoped until an account is known. */
export function scopedKey(base: string): string {
  return account == null ? base : base.replace(/^edgeline\./, `edgeline.u${account}.`);
}

/*
 * Reads and writes that cannot throw.
 *
 * Storage is full, or disabled, or the page is in a private window — none of
 * which is a reason for the editor to fall over. Every caller here treats a
 * miss the same as "nothing stored", so failing quietly is the honest
 * behaviour rather than a swallowed error.
 */
export const store = {
  get(base: string): string | null {
    try {
      return localStorage.getItem(scopedKey(base));
    } catch {
      return null;
    }
  },
  set(base: string, value: string) {
    try {
      localStorage.setItem(scopedKey(base), value);
    } catch {
      /* full or blocked; the app keeps working without the convenience */
    }
  },
  remove(base: string) {
    try {
      localStorage.removeItem(scopedKey(base));
    } catch {
      /* nothing to undo */
    }
  },
};

/**
 * Move the pre-accounts keys into this account, once.
 *
 * Only where the account has nothing of its own under that name, so a second
 * person signing in later cannot have their settings overwritten by the
 * leftovers of whoever used the browser first. The originals are removed:
 * leaving them would hand the same leftovers to the next account too.
 */
function migrateOnce(id: number) {
  try {
    if (localStorage.getItem(MIGRATED)) return;
    localStorage.setItem(MIGRATED, String(id));

    const move = (from: string) => {
      const value = localStorage.getItem(from);
      if (value == null) return;
      const to = from.replace(/^edgeline\./, `edgeline.u${id}.`);
      if (localStorage.getItem(to) == null) localStorage.setItem(to, value);
      localStorage.removeItem(from);
    };

    for (const k of LEGACY_FIXED) move(k);
    // Drafts are keyed by trade id, so they have to be found rather than named.
    const dynamic: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && LEGACY_PREFIXES.some((p) => k.startsWith(p))) dynamic.push(k);
    }
    for (const k of dynamic) move(k);
  } catch {
    /* a browser that will not let us read storage has nothing to migrate */
  }
}
