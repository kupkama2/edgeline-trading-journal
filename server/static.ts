import express from 'express';
import type { Express } from 'express';
import fs from "node:fs";
import path from "node:path";

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  /*
   * The built files are named by their hash — index-so2RqCD-.js — so a file
   * at a given name never changes and may be kept for a year. index.html is
   * the one that names them, and must be asked for every time, or a deploy
   * would leave a browser pointing at scripts that no longer exist.
   */
  app.use(
    express.static(distPath, {
      index: false,
      setHeaders(res, file) {
        if (/[\\/]assets[\\/]/.test(file)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        else res.setHeader("Cache-Control", "no-cache");
      },
    }),
  );

  // fall through to index.html if the file doesn't exist
  app.use("/{*path}", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
