import { afterEach, describe, expect, it } from "bun:test";

import { setOcppWebSocketConstructor } from "../../cp/infrastructure/transport/wsUrlWithBasic";
import { Rig } from "./rig";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  setOcppWebSocketConstructor(null);
});

describe("host seams of the OCPP-J transport (#1126)", () => {
  it("onWireFrame reports every frame the fake CSMS saw or sent", async () => {
    const seen: string[] = [];
    const rig = await Rig.create({
      version: "1.6",
      beforeConnect: (cp) =>
        void cp.onWireFrame((dir, raw) => seen.push(`${dir}:${raw}`)),
    });
    cleanups.push(() => rig.dispose());
    const sent = seen.filter((s) => s.startsWith("sent:")).length;
    const received = seen.filter((s) => s.startsWith("received:")).length;
    expect(sent).toBe(rig.frames.filter((f) => f.dir === "CP>").length);
    expect(received).toBe(rig.frames.filter((f) => f.dir === "CSMS>").length);
    expect(sent).toBeGreaterThan(0);
    expect(seen.some((s) => s.includes('"BootNotification"'))).toBe(true);
  });

  it("opens the socket through an injected constructor", async () => {
    const opened: string[] = [];
    setOcppWebSocketConstructor(
      class extends WebSocket {
        constructor(url: string, options: unknown) {
          opened.push(url);
          super(url, options as never);
        }
      } as never,
    );
    const rig = await Rig.create({ version: "1.6" });
    cleanups.push(() => rig.dispose());
    expect(opened.length).toBeGreaterThan(0);
    expect(rig.frames.some((f) => f.action === "BootNotification")).toBe(true);
  });
});
