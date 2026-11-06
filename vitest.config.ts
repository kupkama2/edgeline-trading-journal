import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Separate from vite.config on purpose: that file's root is client/ (it builds
 * the SPA), while the tests live at the repo root and exercise shared/ — the
 * pure arithmetic both client and server import. Without this override vitest
 * inherits the client root and finds nothing.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // The account-isolation suite talks to a real Postgres and creates rows;
    // running files in parallel would let two of them interleave inside the
    // same database and blame each other for the result.
    fileParallelism: false,
    // The fakes stand in for the venue: no need to pace requests to them like the real one.
    env: { HL_WEIGHT_PER_MIN: "1000000", HL_RETRY_WAITS: "10,10", HL_BACKOFF_MS: "50" },
  },
  // server/ imports through the same aliases the app uses, so the isolation
  // tests can only load it if vitest resolves them too.
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@": path.resolve(import.meta.dirname, "client", "src"),
    },
  },
});
