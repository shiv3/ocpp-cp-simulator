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
