import type { Express, Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { accounts, storageFor } from "./storage";
import type { SessionUser, User } from "@shared/schema";

/**
 * Sign in with Google.
 *
 * The authorization-code flow, written out rather than pulled from a library:
 * it is three HTTP calls, and the version you can read is the version you can
 * be sure about. The ID token is never parsed — after exchanging the code we
 * ask Google's userinfo endpoint who this is, over TLS, server to server. That
 * removes JWT verification (and a JWKS dependency) from the trusted path
 * entirely: the answer's authenticity comes from the channel it arrived on.
 *
 * WHO MAY SIGN IN. Only OWNER_EMAIL and anyone in ALLOWED_EMAILS. There is no
 * open registration, because "a low number of users" and "anyone with a Google
 * account" are very different products. With Google configured and no
 * OWNER_EMAIL set, nobody is let in and the reason is logged — a journal that
 * defaults to admitting the first stranger who finds the URL is not a journal.
 *
 * OWNERSHIP. Everything logged before sign-in existed has no owner. The
 * account matching OWNER_EMAIL claims it, once, when it is created. Nobody
 * else can: an unclaimed row matches no scoped query, so the failure mode of
 * getting this wrong is an empty journal, never someone else's.
 */
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const OWNER_EMAIL = process.env.OWNER_EMAIL?.trim().toLowerCase();
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);
/** Set when the app is not served from the URL the browser used (rare). */
const PUBLIC_URL = process.env.PUBLIC_URL?.replace(/\/$/, "");

export const authEnabled = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

declare module "express-session" {
  interface SessionData {
    userId?: number;
    /** CSRF token for the round trip to Google; one use, then cleared. */
    oauthState?: string;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireUser. Every storage call is scoped to it. */
      userId?: number;
      account?: SessionUser;
    }
  }
}

/** Node's built-in fetch ignores HTTPS_PROXY; the sandbox needs it honoured. */
let proxyDispatcher: ProxyAgent | undefined;
function dispatcher(): ProxyAgent | undefined {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxy) return undefined;
  if (!proxyDispatcher) proxyDispatcher = new ProxyAgent(proxy);
  return proxyDispatcher;
}

function mayEnter(email: string): boolean {
  const e = email.trim().toLowerCase();
  if (!e) return false;
  if (OWNER_EMAIL && e === OWNER_EMAIL) return true;
  return ALLOWED_EMAILS.includes(e);
}

export function toSessionUser(u: User): SessionUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    picture: u.picture,
    isOwner: u.isOwner,
  };
}

function redirectUri(req: Request): string {
  if (PUBLIC_URL) return `${PUBLIC_URL}/api/auth/google/callback`;
  // Render terminates TLS at its proxy, so the forwarded proto is the real one.
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
  return `${proto}://${req.get("host")}/api/auth/google/callback`;
}

/**
 * Find or create the account behind a Google identity, enforcing the
 * allowlist. Returns null when this person is not invited — the caller shows
 * the same message either way, so the endpoint never reveals which emails have
 * accounts.
 */
async function resolveAccount(profile: {
  sub: string;
  email: string;
  name?: string | null;
  picture?: string | null;
}): Promise<User | null> {
  const existing = await accounts.byGoogleSub(profile.sub);
  if (existing) {
    await accounts.touchLogin(existing.id);
    return existing;
  }
  if (!mayEnter(profile.email)) return null;

  // The owner claims the pre-sign-in history; everyone else starts empty.
  const isOwner = Boolean(OWNER_EMAIL && profile.email.toLowerCase() === OWNER_EMAIL);
  const alreadyClaimed = await accounts.owner();
  const user = await accounts.create({
    googleSub: profile.sub,
    email: profile.email,
    name: profile.name ?? null,
    picture: profile.picture ?? null,
    isOwner: isOwner && !alreadyClaimed,
  });
  if (isOwner && !alreadyClaimed) await accounts.claimOwnership(user.id);
  await accounts.touchLogin(user.id);
  return user;
}

export function setupAuth(app: Express) {
  const isProd = process.env.NODE_ENV === "production";
  if (isProd) app.set("trust proxy", 1);

  // Sessions live in Postgres, not memory: Render's free tier spins the service
  // down when idle, and an in-memory store would log you out on every wake.
  const PgStore = connectPgSimple(session);
  app.use(
    session({
      name: "edgeline.sid",
      secret: process.env.SESSION_SECRET || randomBytes(32).toString("hex"),
      resave: false,
      saveUninitialized: false,
      store: new PgStore({
        conString: process.env.DATABASE_URL,
        tableName: "user_sessions",
        createTableIfMissing: true,
      }),
      cookie: {
        httpOnly: true,
        sameSite: "lax", // must survive the redirect back from Google
        secure: isProd,
        maxAge: 30 * 24 * 60 * 60 * 1000,
      },
    }),
  );

  if (!authEnabled) {
    console.warn(
      "[auth] GOOGLE_CLIENT_ID/SECRET not set — running as a single local account. Never deploy like this.",
    );
    setupLocalAccount(app);
    return;
  }
  if (!OWNER_EMAIL && ALLOWED_EMAILS.length === 0) {
    console.error(
      "[auth] Google is configured but OWNER_EMAIL and ALLOWED_EMAILS are both empty — nobody can sign in. Set OWNER_EMAIL to the Google account that owns this journal.",
    );
  }

  app.get("/api/auth/google", (req: Request, res: Response) => {
    const state = randomBytes(24).toString("hex");
    req.session.oauthState = state;
    const url = new URL(AUTH_ENDPOINT);
    url.searchParams.set("client_id", GOOGLE_CLIENT_ID!);
    url.searchParams.set("redirect_uri", redirectUri(req));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    // No refresh token is wanted: we never call Google again on your behalf.
    url.searchParams.set("prompt", "select_account");
    res.redirect(url.toString());
  });

  app.get("/api/auth/google/callback", async (req: Request, res: Response) => {
    const fail = (why: string) => {
      console.warn(`[auth] sign-in rejected: ${why}`);
      res.redirect("/#/?auth=denied");
    };

    const expected = req.session.oauthState;
    const got = typeof req.query.state === "string" ? req.query.state : "";
    req.session.oauthState = undefined;
    // Constant-time, and length-guarded because timingSafeEqual throws on a
    // mismatch. A forged state is the whole attack this parameter exists for.
    if (!expected || expected.length !== got.length) return fail("bad state");
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(got))) {
      return fail("bad state");
    }

    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!code) return fail("no code");

    try {
      const tokenRes = await undiciFetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: GOOGLE_CLIENT_ID!,
          client_secret: GOOGLE_CLIENT_SECRET!,
          redirect_uri: redirectUri(req),
          grant_type: "authorization_code",
        }).toString(),
        dispatcher: dispatcher(),
      } as any);
      if (!tokenRes.ok) return fail(`token exchange ${tokenRes.status}`);
      const token = (await tokenRes.json()) as { access_token?: string };
      if (!token.access_token) return fail("no access token");

      const infoRes = await undiciFetch(USERINFO_ENDPOINT, {
        headers: { authorization: `Bearer ${token.access_token}` },
        dispatcher: dispatcher(),
      } as any);
      if (!infoRes.ok) return fail(`userinfo ${infoRes.status}`);
      const info = (await infoRes.json()) as {
        sub?: string;
        email?: string;
        email_verified?: boolean;
        name?: string;
        picture?: string;
      };
      if (!info.sub || !info.email) return fail("incomplete profile");
      // An unverified address can be anyone's, which would make the allowlist
      // a suggestion rather than a control.
      if (info.email_verified === false) return fail("email not verified");

      const user = await resolveAccount({
        sub: info.sub,
        email: info.email,
        name: info.name,
        picture: info.picture,
      });
      if (!user) return fail(`${info.email} is not on the allowlist`);

      // New session id on privilege change — a cookie handed out before
      // sign-in must not become an authenticated one.
      req.session.regenerate((err) => {
        if (err) return fail("session");
        req.session.userId = user.id;
        req.session.save(() => res.redirect("/"));
      });
    } catch (e) {
      fail(String(e));
    }
  });

  app.get("/api/session", async (req: Request, res: Response) => {
    const user = req.session?.userId ? await accounts.byId(req.session.userId) : undefined;
    res.json({ user: user ? toSessionUser(user) : null, provider: "google" });
  });

  app.post("/api/logout", (req: Request, res: Response) => {
    req.session.destroy(() => {
      res.clearCookie("edgeline.sid");
      res.json({ ok: true });
    });
  });

  app.use("/api", requireUser);
}

/** Attach the account, or refuse. Everything under /api runs behind this. */
async function requireUser(req: Request, res: Response, next: NextFunction) {
  const id = req.session?.userId;
  if (!id) return res.status(401).json({ message: "Not signed in" });
  const user = await accounts.byId(id);
  // The account was deleted out from under a live cookie.
  if (!user) return res.status(401).json({ message: "Not signed in" });
  req.userId = user.id;
  req.account = toSessionUser(user);
  next();
}

/**
 * Development without Google: one implicit local account, created on demand.
 *
 * `npm run dev` staying friction-free is the whole point — but the app now
 * needs an account id to scope anything to, so "no auth" cannot mean "no
 * user". This mints a single local account and gives it the pre-sign-in
 * history, which is exactly what a developer's own database contains.
 */
function setupLocalAccount(app: Express) {
  const LOCAL_SUB = "local-dev";
  let cached: User | undefined;

  async function localUser(): Promise<User> {
    if (cached) return cached;
    const found = await accounts.byGoogleSub(LOCAL_SUB);
    if (found) return (cached = found);
    const created = await accounts.create({
      googleSub: LOCAL_SUB,
      email: "dev@localhost",
      name: "Local dev",
      isOwner: !(await accounts.owner()),
    });
    if (created.isOwner) await accounts.claimOwnership(created.id);
    return (cached = created);
  }

  app.get("/api/session", async (_req: Request, res: Response) => {
    res.json({ user: toSessionUser(await localUser()), provider: "local" });
  });

  app.post("/api/logout", (_req: Request, res: Response) => res.json({ ok: true }));

  app.use("/api", async (req: Request, _res: Response, next: NextFunction) => {
    const user = await localUser();
    req.userId = user.id;
    req.account = toSessionUser(user);
    next();
  });
}

/** Kept for the call in index.ts; the local-account path handles the stub now. */
export function setupAuthStub(_app: Express) {}

export { storageFor };
