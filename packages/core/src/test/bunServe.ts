/**
 * The address a test server binds when its clients dial `127.0.0.1`. Left to
 * its default, `Bun.serve` listens on the wildcard address, and on macOS any
 * socket bound to 127.0.0.1 on the same port (another test process, a server
 * of an earlier case) then takes every connection to `127.0.0.1:<port>`: the
 * client is refused until it runs out of time (#848, #874).
 */
export const LOOPBACK = "127.0.0.1";

/**
 * The TCP port a `Bun.serve` server bound. Bun types `port` as optional
 * because a server may listen on a unix socket; a test server never does.
 */
export function tcpPort(server: { readonly port?: number }): number {
  if (server.port === undefined) throw new Error("server bound no TCP port");
  return server.port;
}

/** Whether this environment lets a test bind a local HTTP server (some
 *  sandboxes refuse); suites that need one skip otherwise. */
export function canBindBunServe(port = 0): boolean {
  try {
    const server = Bun.serve({
      port,
      fetch() {
        return new Response("ok");
      },
    });
    void server.stop(true);
    return true;
  } catch {
    return false;
  }
}
