import { describe, it, expect, beforeEach } from "vitest";
import {
  GetLocalListVersionHandler,
  SendLocalListHandler,
} from "../LocalAuthListHandlers";
import { LocalAuthListManager } from "../../../../../domain/auth/LocalAuthList";
import { Logger } from "../../../../../shared/Logger";
import type { HandlerContext } from "../../MessageHandlerRegistry";

/**
 * Builds the minimal duck-typed HandlerContext the handlers consume. We
 * stub Configuration via semantic accessors so tests can flip
 * LocalAuthListEnabled / *MaxLength without spinning up a full
 * ChargePoint + ConfigurationStore + Database stack.
 */
function buildContext(
  opts: {
    enabled?: boolean;
    localMax?: number;
    sendMax?: number;
    manager?: LocalAuthListManager;
  } = {},
): HandlerContext {
  const logger = new Logger();
  const manager = opts.manager ?? new LocalAuthListManager(logger);
  const configStub = {
    localAuthListEnabled: () => opts.enabled ?? true,
    localAuthListMaxLength: () => opts.localMax ?? 1000,
    sendLocalListMaxLength: () => opts.sendMax ?? 100,
  };
  const chargePointStub = {
    configuration: configStub,
    localAuthListManager: manager,
  };
  return {
    // Tests only exercise the handler surface — the real ChargePoint type
    // is far wider than what these specific handlers touch.
    chargePoint: chargePointStub as unknown as HandlerContext["chargePoint"],
    logger,
  };
}

describe("GetLocalListVersionHandler", () => {
  it("returns the manager's current version when enabled", () => {
    const manager = new LocalAuthListManager(new Logger());
    manager.applyFull(4, [{ idTag: "A", idTagInfo: { status: "Accepted" } }], {
      localAuthListMaxLength: 100,
      sendLocalListMaxLength: 50,
    });
    const ctx = buildContext({ manager });
    const handler = new GetLocalListVersionHandler();
    expect(handler.handle({}, ctx)).toEqual({ listVersion: 4 });
  });

  it("returns -1 when LocalAuthListEnabled is false (§9.4)", () => {
    const ctx = buildContext({ enabled: false });
    const handler = new GetLocalListVersionHandler();
    expect(handler.handle({}, ctx)).toEqual({ listVersion: -1 });
  });
});

describe("SendLocalListHandler", () => {
  let handler: SendLocalListHandler;
  beforeEach(() => {
    handler = new SendLocalListHandler();
  });

  it("Full update accepted", () => {
    const ctx = buildContext();
    const res = handler.handle(
      {
        listVersion: 1,
        updateType: "Full",
        localAuthorizationList: [
          { idTag: "A", idTagInfo: { status: "Accepted" } },
        ],
      },
      ctx,
    );
    expect(res).toEqual({ status: "Accepted" });
    expect(ctx.chargePoint.localAuthListManager.getVersion()).toBe(1);
    expect(ctx.chargePoint.localAuthListManager.size()).toBe(1);
  });

  it("Differential with older version → VersionMismatch", () => {
    const manager = new LocalAuthListManager(new Logger());
    manager.applyFull(5, [], {
      localAuthListMaxLength: 100,
      sendLocalListMaxLength: 50,
    });
    const ctx = buildContext({ manager });
    const res = handler.handle(
      {
        listVersion: 5,
        updateType: "Differential",
        localAuthorizationList: [],
      },
      ctx,
    );
    expect(res).toEqual({ status: "VersionMismatch" });
  });

  it("returns NotSupported when feature is disabled", () => {
    const ctx = buildContext({ enabled: false });
    const res = handler.handle(
      { listVersion: 1, updateType: "Full", localAuthorizationList: [] },
      ctx,
    );
    expect(res).toEqual({ status: "NotSupported" });
  });

  it("Full update exceeding SendLocalListMaxLength → Failed", () => {
    const ctx = buildContext({ sendMax: 2 });
    const res = handler.handle(
      {
        listVersion: 1,
        updateType: "Full",
        localAuthorizationList: [
          { idTag: "A", idTagInfo: { status: "Accepted" } },
          { idTag: "B", idTagInfo: { status: "Accepted" } },
          { idTag: "C", idTagInfo: { status: "Accepted" } },
        ],
      },
      ctx,
    );
    expect(res).toEqual({ status: "Failed" });
  });
});
