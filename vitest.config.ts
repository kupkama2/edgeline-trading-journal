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
