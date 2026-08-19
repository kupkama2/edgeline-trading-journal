import { describe, expect, it } from "vitest";

/**
 * The allowlist, as data.
 *
 * Two properties matter more than the CRUD. One person cannot end up invited
 * twice under two spellings, because "remove" would then only remove half of
 * them and the person would still be able to sign in. And an invite that was
 * never accepted has to be removable — otherwise a typo is permanent.
 */
const DB = process.env.DATABASE_URL;
if (process.env.CI && !DB) {
  throw new Error("DATABASE_URL is required in CI — the invite tests must run");
}

const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const addr = (who: string) => `${who}-${stamp}@x.test`;

describe.skipIf(!DB)("the invite list", () => {
  it("stores one row however the address was capitalised", async () => {
    const { initSchema, invitations } = await import("../server/storage");
    await initSchema();
    const e = addr("case");

    await invitations.add(e.toUpperCase(), null);
    await invitations.add(`  ${e}  `, null);
    await invitations.add(e, null);

    const rows = (await invitations.list()).filter((i) => i.email.includes(stamp));
    expect(rows).toHaveLength(1);
    // Stored lowercased, so the UNIQUE index is what enforces this rather
    // than every caller remembering to normalise.
    expect(rows[0].email).toBe(e.toLowerCase());
  });

  it("recognises an invited address whatever case it is asked about", async () => {
    const { initSchema, invitations } = await import("../server/storage");
    await initSchema();
    const e = addr("ask");
    await invitations.add(e, null);

    expect(await invitations.has(e)).toBe(true);
    expect(await invitations.has(e.toUpperCase())).toBe(true);
    expect(await invitations.has(`  ${e} `)).toBe(true);
    expect(await invitations.has(addr("never"))).toBe(false);
  });

  it("ignores blanks rather than storing an invite nobody can use", async () => {
    const { initSchema, invitations } = await import("../server/storage");
    await initSchema();
    expect(await invitations.add("   ", null)).toBeUndefined();
    expect(await invitations.has("")).toBe(false);
    expect(await invitations.has("   ")).toBe(false);
  });

  it("removes by any spelling", async () => {
    const { initSchema, invitations } = await import("../server/storage");
    await initSchema();
    const e = addr("gone");
    await invitations.add(e, null);
    expect(await invitations.has(e)).toBe(true);

    await invitations.remove(e.toUpperCase());
    expect(await invitations.has(e)).toBe(false);
  });

  it("is idempotent — inviting twice is not an error", async () => {
    const { initSchema, invitations } = await import("../server/storage");
    await initSchema();
    const e = addr("twice");
    const first = await invitations.add(e, null);
    const second = await invitations.add(e, null);
    expect(second?.id).toBe(first?.id);
  });

  it("lists accounts separately from invites", async () => {
    // The panel distinguishes "invited" from "actually signed in", and that
    // only works if the two lists are separate reads.
    const { initSchema, invitations, accounts } = await import("../server/storage");
    await initSchema();
    const joined = addr("joined");
    const user = await accounts.create({ googleSub: `inv-${stamp}`, email: joined });
    await invitations.add(addr("waiting"), user.id);

    const members = await invitations.members();
    expect(members.some((m) => m.email === joined)).toBe(true);
    const list = await invitations.list();
    expect(list.some((i) => i.email === joined)).toBe(false);
  });
});
