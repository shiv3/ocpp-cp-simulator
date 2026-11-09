import { afterEach, describe, expect, it } from "bun:test";

import { FakeCsms } from "./FakeCsms";
import { Rig } from "./rig";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const portOf = (url: string) => Number(new URL(url).port);

// The station dials 127.0.0.1. A server listening on the wildcard address
// loses every such connection to any socket bound to 127.0.0.1 on the same
// port (BSD socket semantics, macOS): the station is refused with "Expected
// 101 status code" until the case runs out of time, and the fake CSMS sees no
// upgrade at all (#848, #874).
describe("FakeCsms loopback bind (#848)", () => {
  it("leaves no other server room on 127.0.0.1 at its port", async () => {
    const csms = new FakeCsms({ version: "1.6" });
    cleanups.push(() => csms.stop());
    let thief: ReturnType<typeof Bun.serve> | null = null;
    try {
      thief = Bun.serve({
        port: portOf(csms.url),
        hostname: "127.0.0.1",
        fetch: () => new Response("not the CSMS", { status: 404 }),
      });
    } catch {
      // EADDRINUSE: the port is the fake CSMS's own.
    }
    if (thief) cleanups.push(() => thief.stop(true));
    expect(thief).toBeNull();
  });

  it("holds the upload sink on 127.0.0.1 too", async () => {
    const rig = await Rig.create({ version: "1.6", noConnect: true });
    cleanups.push(() => rig.dispose());
    const url = rig.uploadUrl();
    let thief: ReturnType<typeof Bun.serve> | null = null;
    try {
      thief = Bun.serve({
        port: portOf(url),
        hostname: "127.0.0.1",
        fetch: () => new Response("not the sink", { status: 404 }),
      });
    } catch {
      // EADDRINUSE: the port is the sink's own.
    }
    if (thief) cleanups.push(() => thief.stop(true));
    expect(thief).toBeNull();
  });
});
