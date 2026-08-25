/**
 * How outbound requests leave this process.
 *
 * Its own module because two things need it — the Binance API client and the
 * archive reader — and having them import each other for it would tie the
 * live feed and the historical one into a cycle for the sake of six lines.
 *
 * NO_PROXY is honoured for loopback and private addresses, which is not
 * housekeeping: a request to a host on this machine sent through an external
 * proxy simply fails, and the failure looks exactly like "the venue is down"
 * — an empty catalogue and every trade left unmatched, with nothing saying
 * why. In production there is no proxy and this is undefined throughout.
 */
import { ProxyAgent } from "undici";

const LOCAL_HOST =
  /^(localhost|127\.|\[?::1\]?|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i;

let dispatcher: ProxyAgent | undefined;

export function egressFor(base: string): ProxyAgent | undefined {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxy) return undefined;
  try {
    if (LOCAL_HOST.test(new URL(base).hostname)) return undefined;
  } catch {
    /* an unparseable base is someone else's error; proxy as normal */
  }
  if (!dispatcher) dispatcher = new ProxyAgent(proxy);
  return dispatcher;
}
