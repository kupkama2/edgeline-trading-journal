import { describe, expect, it } from "vitest";
import { allowsEmail, authConfigError } from "../server/auth";

/**
 * The deploy-time guard.
 *
 * Without sign-in configured the server falls back to one implicit local
 * account — correct for `npm run dev`, and two separate disasters in
 * production: every /api route open, and the placeholder account claiming the
 * pre-sign-in history, which would strand the real owner's trades under a
 * login nobody can use.
 *
 * So production refuses to boot instead. Render keeps the last healthy deploy
 * running, which means a misconfigured release leaves the existing gated
 * version serving rather than replacing it with an open one.
 */
const prod = (over: Record<string, string> = {}) =>
  ({ NODE_ENV: "production", ...over }) as unknown as NodeJS.ProcessEnv;

describe("production refuses to run without sign-in", () => {
  it("allows development to run with nothing configured", () => {
    expect(authConfigError({} as NodeJS.ProcessEnv)).toBeNull();
    expect(authConfigError({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("refuses production with no Google credentials", () => {
    expect(authConfigError(prod())).toMatch(/GOOGLE_CLIENT_ID/);
  });

  it("refuses production with only half the credentials", () => {
    expect(authConfigError(prod({ GOOGLE_CLIENT_ID: "x" }))).toMatch(/GOOGLE_CLIENT_SECRET/);
    expect(authConfigError(prod({ GOOGLE_CLIENT_SECRET: "y" }))).toMatch(/GOOGLE_CLIENT_ID/);
  });

  it("refuses production when nobody is allowed in", () => {
    // Credentials without an allowlist is a door with no keys cut: the app
    // would run, refuse every sign-in, and look broken rather than misconfigured.
    const err = authConfigError(prod({ GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "y" }));
    expect(err).toMatch(/OWNER_EMAIL/);
  });

  it("treats whitespace as unset", () => {
    expect(
      authConfigError(prod({ GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "y", OWNER_EMAIL: "   " })),
    ).toMatch(/OWNER_EMAIL/);
  });

  it("boots when it is properly configured", () => {
    expect(
      authConfigError(
        prod({ GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "y", OWNER_EMAIL: "me@example.com" }),
      ),
    ).toBeNull();
  });

  it("accepts an allowlist without a named owner", () => {
    // Valid for a deployment that has already been claimed: the owner exists
    // in the database, and the running config only needs to say who may enter.
    expect(
      authConfigError(
        prod({ GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "y", ALLOWED_EMAILS: "a@b.test" }),
      ),
    ).toBeNull();
  });
});

/**
 * Who the door opens for.
 *
 * The three sources are not equal and the order is the whole point. The owner
 * is allowed by a value that lives outside the database, so no amount of
 * clicking inside the app — theirs or anyone's — can lock them out of their
 * own history. Everything else is revocable, which is what makes a Remove
 * button honest.
 */
describe("who may sign in", () => {
  const OWNER = "me@example.com";

  it("lets the owner in with nothing else configured", () => {
    expect(allowsEmail(OWNER, { ownerEmail: OWNER })).toBe(true);
  });

  it("lets the owner in even when the invite list says otherwise", () => {
    // The property that matters: nothing revocable can revoke the owner.
    expect(allowsEmail(OWNER, { ownerEmail: OWNER, envList: [], invited: false })).toBe(true);
  });

  it("still honours the environment variable", () => {
    // Kept as a bootstrap so an empty database is never a locked door.
    expect(allowsEmail("friend@x.com", { ownerEmail: OWNER, envList: ["friend@x.com"] })).toBe(
      true,
    );
  });

  it("lets an invited address in", () => {
    expect(allowsEmail("friend@x.com", { ownerEmail: OWNER, invited: true })).toBe(true);
  });

  it("keeps a stranger out", () => {
    expect(allowsEmail("stranger@x.com", { ownerEmail: OWNER, envList: ["friend@x.com"] })).toBe(
      false,
    );
  });

  it("shuts the door again when an invite is withdrawn", () => {
    // Revocation is the reason this function exists rather than a one-time
    // check at account creation, which is what it used to be.
    expect(allowsEmail("friend@x.com", { ownerEmail: OWNER, invited: false })).toBe(false);
  });

  it("ignores case and padding on every source", () => {
    expect(allowsEmail("  ME@Example.com ", { ownerEmail: OWNER })).toBe(true);
    expect(allowsEmail("Friend@X.com", { envList: ["  friend@x.com  "] })).toBe(true);
  });

  it("never admits a blank address", () => {
    // An account with no email must not match an empty owner or env entry.
    expect(allowsEmail("", { ownerEmail: "", envList: [""], invited: false })).toBe(false);
    expect(allowsEmail("   ", { ownerEmail: OWNER })).toBe(false);
  });
});
