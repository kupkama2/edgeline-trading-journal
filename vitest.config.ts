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
  },
});
