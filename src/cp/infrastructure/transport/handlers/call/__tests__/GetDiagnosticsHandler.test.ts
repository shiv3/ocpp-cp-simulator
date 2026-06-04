import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GetDiagnosticsHandler } from "../GetDiagnosticsHandler";
import { Logger } from "../../../../../shared/Logger";
import type { HandlerContext } from "../../MessageHandlerRegistry";
import type { ChargePoint } from "../../../../../domain/charge-point/ChargePoint";

type DiagStatus = "Idle" | "Uploaded" | "UploadFailed" | "Uploading";

function buildContext() {
  const sent: DiagStatus[] = [];
  const logger = new Logger();
  const chargePoint = {
    sendDiagnosticsStatusNotification: (status: DiagStatus) => {
      sent.push(status);
    },
  };
  return {
    ctx: {
      chargePoint: chargePoint as unknown as ChargePoint,
      logger,
    } as HandlerContext,
    sent,
  };
}

describe("GetDiagnosticsHandler", () => {
  // The narrow vi.spyOn signature is awkward to satisfy across vitest
  // versions when spying on globalThis.fetch; the test just needs to keep
  // a handle for mockRestore so loose typing here is fine.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any = null;

  beforeEach(() => {
    // Blob/File/FormData live on globalThis under happy-dom / jsdom but
    // not under node's default environment. The handler instantiates a
    // Blob+File regardless of test env, so we polyfill the trio here.
    if (typeof globalThis.Blob === "undefined") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).Blob = class Blob {
        constructor(
          public parts: unknown[],
          public opts?: unknown,
        ) {}
      };
    }
    if (typeof globalThis.File === "undefined") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).File = class File extends (globalThis as any).Blob {
        constructor(
          parts: unknown[],
          public name: string,
        ) {
          super(parts);
        }
      };
    }
    if (typeof globalThis.FormData === "undefined") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).FormData = class FormData {
        append(): void {}
      };
    }
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
  });

  it("returns the fileName immediately", () => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 200 }));
    const { ctx } = buildContext();
    const handler = new GetDiagnosticsHandler();
    const res = handler.handle({ location: "http://example/upload" }, ctx);
    expect(res).toEqual({ fileName: "diagnostics.txt" });
  });

  it("sends Uploading then Uploaded on HTTP success", async () => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 200 }));
    const { ctx, sent } = buildContext();
    const handler = new GetDiagnosticsHandler();
    handler.handle({ location: "http://example/upload" }, ctx);
    // microtask drain → schedules Uploading + starts fetch
    await Promise.resolve();
    // fetch promise resolves on the next microtask + the await chain
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual(["Uploading", "Uploaded"]);
  });

  it("sends UploadFailed when fetch rejects", async () => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("ECONNREFUSED"));
    const { ctx, sent } = buildContext();
    const handler = new GetDiagnosticsHandler();
    handler.handle({ location: "http://nope/upload" }, ctx);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(sent).toEqual(["Uploading", "UploadFailed"]);
  });

  it("sends UploadFailed on non-2xx HTTP", async () => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 500 }));
    const { ctx, sent } = buildContext();
    const handler = new GetDiagnosticsHandler();
    handler.handle({ location: "http://broken/upload" }, ctx);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(sent).toEqual(["Uploading", "UploadFailed"]);
  });
});
