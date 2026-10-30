import { describe, expect, it, vi } from "vitest";

import { OCPPMessageHandler } from "../OCPPMessageHandler";
import type { OCPPWebSocket } from "../OCPPWebSocket";
import type { ProtocolCodec } from "../profile/ProtocolProfile";
import { outgoingV16Warning } from "../codec/validateV16";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import {
  DefaultBootNotification,
  OCPPAction,
  OCPPMessageType,
} from "../../../domain/types/OcppTypes";
import { Logger, LogLevel, LogType } from "../../../shared/Logger";

/**
 * #407: the CSMS acknowledging a CP-initiated notification whose `.conf` is
 * empty by spec is the whole exchange, not a missing handler. #410: the same
 * holds for SignCertificate.conf, whose status is logged instead.
 */

type IncomingMessageHandler = (
  messageType: OCPPMessageType,
  messageId: string,
  action: OCPPAction,
  payload: unknown,
) => void;

const NO_HANDLER = "No handler for action result";

function harness() {
  const cp = new ChargePoint(
    "CP-407",
    DefaultBootNotification,
    1,
    "ws://127.0.0.1:9/",
    null,
    null,
    null,
    {},
    [],
    "OCPP-1.6J",
    {},
  );
  cp.events.on("error", () => undefined);
  let captured: IncomingMessageHandler | null = null;
  const sent: Array<{ messageId: string; action: string }> = [];
  const fakeSocket = {
    setMessageHandler: (handler: IncomingMessageHandler) => {
      captured = handler;
    },
    isConnected: () => true,
    sendAction: (
      messageId: string,
      action: string,
      _payload: unknown,
      _gen: unknown,
      onSettled?: (s: { outcome: "written" }) => void,
    ) => {
      sent.push({ messageId, action });
      onSettled?.({ outcome: "written" });
      return true;
    },
    currentGeneration: () => ({ gen: 1, closeCause: null }),
  } as unknown as OCPPWebSocket;
  const codec: ProtocolCodec = { outgoingWarning: outgoingV16Warning };
  const logger = new Logger(LogLevel.DEBUG);
  const warn = vi.spyOn(logger, "warn");
  const debug = vi.spyOn(logger, "debug");
  const info = vi.spyOn(logger, "info");
  const handler = new OCPPMessageHandler(cp, fakeSocket, logger, codec);
  handler.setBootStatus({ status: "Accepted" });
  const answer = (action: string, payload: unknown) => {
    const call = sent.find((s) => s.action === action);
    expect(call).toBeDefined();
    captured!(
      OCPPMessageType.CALLRESULT,
      call!.messageId,
      action as OCPPAction,
      payload,
    );
  };
  const warnedNoHandler = () =>
    warn.mock.calls.some(([message]) => message.includes(NO_HANDLER));
  return { handler, debug, info, warn, answer, warnedNoHandler };
}

describe("empty CALLRESULTs on OCPP 1.6 (#407)", () => {
  it.each<[OCPPAction, (handler: OCPPMessageHandler) => void]>([
    [
      OCPPAction.SecurityEventNotification,
      (h) => h.sendSecurityEventNotification("StartupOfTheDevice"),
    ],
    [
      OCPPAction.FirmwareStatusNotification,
      (h) => h.sendFirmwareStatusNotification("Downloading"),
    ],
    [
      OCPPAction.DiagnosticsStatusNotification,
      (h) => h.sendDiagnosticsStatusNotification("Uploading"),
    ],
    [
      OCPPAction.LogStatusNotification,
      (h) => h.sendLogStatusNotification("Uploading", 1),
    ],
    [
      OCPPAction.SignedFirmwareStatusNotification,
      (h) => h.sendSignedFirmwareStatusNotification("Downloading", 1),
    ],
  ])("treats %s's empty confirmation as handled", (action, send) => {
    const h = harness();
    send(h.handler);

    h.answer(action, {});

    expect(h.warnedNoHandler()).toBe(false);
    expect(h.debug).toHaveBeenCalledWith(
      `${action} acknowledged`,
      expect.anything(),
    );
  });
});

describe("SignCertificate.conf on OCPP 1.6 (#410)", () => {
  it("logs Accepted at INFO, not as a missing handler", async () => {
    const h = harness();
    await h.handler.sendSignCertificate("-----BEGIN CERTIFICATE REQUEST-----");

    h.answer(OCPPAction.SignCertificate, { status: "Accepted" });

    expect(h.warnedNoHandler()).toBe(false);
    expect(h.info).toHaveBeenCalledWith(
      "SignCertificate accepted by the CSMS; awaiting CertificateSigned.req",
      LogType.OCPP,
    );
    expect(h.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("SignCertificate"),
      expect.anything(),
    );
  });

  it("logs Rejected at WARN naming the status, not as a missing handler", async () => {
    const h = harness();
    await h.handler.sendSignCertificate("-----BEGIN CERTIFICATE REQUEST-----");

    h.answer(OCPPAction.SignCertificate, { status: "Rejected" });

    expect(h.warnedNoHandler()).toBe(false);
    expect(h.warn).toHaveBeenCalledWith(
      "SignCertificate not accepted by the CSMS (status Rejected); certificate renewal will not happen",
      LogType.OCPP,
    );
  });
});
