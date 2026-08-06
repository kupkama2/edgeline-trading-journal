import type { Express, Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { timingSafeEqual, randomBytes } from "node:crypto";

/**
 * Single-password gate.
 *
 * This is a single-user journal, so there are no accounts — one shared password
 * (APP_PASSWORD) exchanged for a session cookie. Every /api route is behind it,
 * mutations included, because the whole database is one person's trading record.
 *
 * When APP_PASSWORD is unset the gate is disabled entirely and the app behaves
 * as it always has locally. That is deliberate — it keeps `npm run dev` friction
 * free — but it means the variable is REQUIRED in any deployed environment.
 */
const APP_PASSWORD = process.env.APP_PASSWORD;

export const authEnabled = Boolean(APP_PASSWORD);

/** Constant-time compare so a wrong password can't be found by timing. */
function passwordMatches(candidate: string): boolean {
  if (!APP_PASSWORD) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(APP_PASSWORD);
  // timingSafeEqual throws on length mismatch, so gate on it first — the length
  // of the real password is not itself a useful secret.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

declare module "express-session" {
  interface SessionData {
    authed?: boolean;
  }
}

export function setupAuth(app: Express) {
  if (!authEnabled) {
    console.warn(
      "[auth] APP_PASSWORD is not set — the API is UNPROTECTED. Never deploy like this.",
    );
    return;
  }

  // Sessions live in Postgres, not memory: Render's free tier spins the service
  // down when idle, and an in-memory store would log you out on every wake.
  const PgStore = connectPgSimple(session);
  const isProd = process.env.NODE_ENV === "production";

  // Render terminates TLS at its proxy, so secure cookies need this.
  if (isProd) app.set("trust proxy", 1);

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
        sameSite: "lax",
        secure: isProd,
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days — it's a personal journal
      },
    }),
  );

  /**
   * One shared password is the entire security model, so unlimited guessing has
   * to be off the table. Fixed window per IP — crude, but this is a single-user
   * app and anything more elaborate is theatre.
   */
  const ATTEMPT_LIMIT = 10;
  const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
  const attempts = new Map<string, { count: number; resetAt: number }>();

  function tooManyAttempts(ip: string): boolean {
    const now = Date.now();
    const entry = attempts.get(ip);
    if (!entry || now > entry.resetAt) {
      attempts.set(ip, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
      return false;
    }
    entry.count += 1;
    return entry.count > ATTEMPT_LIMIT;
  }

  app.post("/api/login", (req: Request, res: Response) => {
    const ip = req.ip ?? "unknown";
    if (tooManyAttempts(ip)) {
      return res.status(429).json({ message: "Too many attempts. Try again later." });
    }

    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!passwordMatches(password)) {
      return res.status(401).json({ message: "Wrong password" });
    }

    attempts.delete(ip);
    req.session.authed = true;
    res.json({ ok: true });
  });

  app.post("/api/logout", (req: Request, res: Response) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  app.get("/api/session", (req: Request, res: Response) => {
    res.json({ authed: req.session?.authed === true });
  });

  // Everything else under /api requires the cookie.
  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    if (req.session?.authed === true) return next();
    res.status(401).json({ message: "Not authenticated" });
  });
}

/** Unauthenticated stub so the client can render the login screen either way. */
export function setupAuthStub(app: Express) {
  if (authEnabled) return;
  app.get("/api/session", (_req, res) => res.json({ authed: true }));
}
