import { createServer } from "node:http";
import { describe, expect, it } from "vitest";

/**
 * A dead feed must be distinguishable from an empty one.
 *
 * The first version swallowed every fetch failure, so an unreachable venue and
 * a venue with nothing to say produced the identical result: no pairs, no
 * chart, no symbol fold, and no way to tell which had happened. Binance
 * answers 451 to US IPs on its main API — which is where a service hosted in
 * Oregon calls from — so this is not a hypothetical failure mode, it is the
 * likely one.
 *
 * Its own file because the hosts are read once when the module loads, and a
 * test that sets them after some earlier test has already imported it is
 * measuring the wrong thing. That happened, and the giveaway was an error
 * message naming no host at all.
 */
describe("what the feed says when it refuses", () => {
  it("names the host and the status, not just 'failed'", async () => {
    const srv = createServer((_req, res) => {
      res.statusCode = 451; // what a geo-block actually looks like
      res.end("{}");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as any).port;
    process.env.BINANCE_BASE = `http://127.0.0.1:${port}`;
    process.env.BINANCE_FUTURES_BASE = `http://127.0.0.1:${port}`;

    const { fetchCatalogue, feedStatus } = await import("../server/binance");
    await expect(fetchCatalogue()).rejects.toThrow();

    const st = feedStatus();
    // The two facts that turn a shrug into a diagnosis.
    expect(st.lastError).toMatch(/451/);
    expect(st.lastError).toMatch(/127\.0\.0\.1/);
    expect(st.lastTriedAt).toBeTruthy();
    expect(st.lastOkAt).toBeNull();

    await new Promise<void>((r) => srv.close(() => r()));
  });
});
