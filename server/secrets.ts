/**
 * Secrets at rest.
 *
 * An exchange API key is the one thing this journal stores that is worth
 * stealing, and it has to be stored: a sync that asks for the key every time
 * is a sync nobody runs. So it is sealed before it touches the database and
 * opened only in the moment a request to the venue is signed. A database
 * dump, a misdirected backup or a query from the wrong account yields
 * ciphertext.
 *
 * AES-256-GCM, with a per-secret random nonce and the key derived from
 * SESSION_SECRET. That is the secret the deployment already has to protect,
 * and deriving from it rather than adding a second one means there is one
 * thing to rotate and one thing to lose. Lose it and every stored key is
 * gone — which is the right failure, since a key that survived its
 * encryption key was never encrypted.
 *
 * The format is self-describing ("v1." + nonce + tag + body, base64url) so a
 * later version can tell an old sealed value from a new one and re-seal it.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const VERSION = "v1";
const NONCE = 12;
const TAG = 16;

let cached: Buffer | null = null;

/**
 * The key, derived once per process.
 *
 * Without SESSION_SECRET there is nothing to derive from. A fixed fallback
 * would make every local database decryptable by anyone with the source, so
 * instead the dev server gets a key that is random PER PROCESS: sealing works,
 * the next restart cannot open what the last one wrote, and a developer who
 * wants a key to survive a restart sets SESSION_SECRET like production does.
 */
function key(): Buffer {
  if (cached) return cached;
  const secret = process.env.SESSION_SECRET;
  const ikm = secret ? Buffer.from(secret, "utf8") : randomBytes(32);
  if (!secret) {
    console.warn("[secrets] SESSION_SECRET is not set — sealed values will not survive a restart.");
  }
  cached = Buffer.from(hkdfSync("sha256", ikm, "edgeline", "account-secrets", 32));
  return cached;
}

export function seal(plain: string): string {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv("aes-256-gcm", key(), nonce);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${Buffer.concat([nonce, tag, body]).toString("base64url")}`;
}

/** Null rather than a throw for anything that is not ours or will not open. */
export function open(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  const dot = sealed.indexOf(".");
  if (dot < 0 || sealed.slice(0, dot) !== VERSION) return null;
  try {
    const raw = Buffer.from(sealed.slice(dot + 1), "base64url");
    if (raw.length < NONCE + TAG) return null;
    const nonce = raw.subarray(0, NONCE);
    const tag = raw.subarray(NONCE, NONCE + TAG);
    const body = raw.subarray(NONCE + TAG);
    const decipher = createDecipheriv("aes-256-gcm", key(), nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** For tests: forget the derived key so a changed SESSION_SECRET takes effect. */
export function _resetKeyForTests(): void {
  cached = null;
}
