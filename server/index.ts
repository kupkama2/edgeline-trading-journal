import "dotenv/config";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import { registerRoutes } from "./routes";
import { loggableError } from "./errors";
import { setupAuth, setupAuthStub } from "./auth";
import { serveStatic } from "./static";
import { createServer } from "node:http";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    limit: "25mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: "25mb" }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

/*
 * One line per API request: method, path, status, time. The response body
 * used to be appended in full — every trade, note and member email on each
 * refetch, and image payloads megabytes at a time — which cost a second
 * serialisation per request and kept the journal's contents in the host's
 * logs, where nobody had agreed to keep them.
 */
app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  res.on("finish", () => {
    if (path.startsWith("/api")) log(`${req.method} ${path} ${res.statusCode} in ${Date.now() - start}ms`);
  });
  next();
});


(async () => {
  // Tables must exist before any route can serve a query.
  const { initSchema } = await import("./storage");
  await initSchema();

  // Must precede registerRoutes — the /api guard only protects routes
  // registered after it.
  setupAuth(app);
  setupAuthStub(app);

  await registerRoutes(httpServer, app);

  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    /*
     * A 4xx thrown on purpose (a body too large, a malformed one) means its
     * message for the person who sent it. A 5xx is this server's failure,
     * and its message is whatever broke — for a database error, the query
     * and its parameters — so the browser gets a sentence and the log gets
     * the detail, with the parameters cut.
     */
    const message = status < 500 ? err.message || "Bad request" : "Something went wrong on the server — try again.";
    console.error(`${req.method} ${req.path} failed:`, loggableError(err));

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  /*
   * Deliberately NOT reusePort. SO_REUSEPORT lets a second copy of the server
   * bind the same port, and the kernel then load-balances between them — so a
   * stale process serves half of all requests and an updated build appears
   * randomly broken. This app runs as exactly one process everywhere it is
   * deployed; if the port is taken, the right outcome is a loud EADDRINUSE,
   * not silently split traffic.
   */
  httpServer.listen({ port, host: "0.0.0.0" }, () => {
    log(`serving on port ${port}`);
  });
})();
