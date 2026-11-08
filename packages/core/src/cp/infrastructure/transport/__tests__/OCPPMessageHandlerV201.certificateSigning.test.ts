import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isValidCertificateSignedResponseV201,
  isValidCertificateSignedResponseV21,
  isValidGetCertificateStatusRequestV201,
  isValidGetCertificateStatusRequestV21,
  isValidSecurityEventNotificationRequestV201,
  isValidSecurityEventNotificationRequestV21,
  isValidSignCertificateRequestV201,
  isValidSignCertificateRequestV21,
  isValidTriggerMessageResponseV201,
  isValidTriggerMessageResponseV21,
} from "@ocpp-cp-sim/ocpp/index";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { defaultConfiguration } from "../../../domain/charge-point/Configuration";
import { ConfigurationStore } from "../../../domain/charge-point/ConfigurationStore";
import { OcppCallNoAnswerError } from "../../../domain/errors/OcppCallErrors";
import { OCPPMessageType } from "../../../domain/types/OcppTypes";
import { CertificateStore } from "../../../domain/security/CertificateStore";
import {
  leafForCsr,
  selfSignedRoot,
  subCa,
} from "../../../domain/security/__tests__/certificateFixtures";
import { OCSP_RESPONSE_GOOD_BASE64 } from "../../../domain/security/__tests__/ocspFixtures";
import type { Logger } from "../../../shared/Logger";
import type { GenerationToken, Settlement } from "../network-sim";
import { OCPPMessageHandlerV201 } from "../OCPPMessageHandlerV201";
import type { OCPPWebSocket } from "../OCPPWebSocket";
import { buildV201InboundRegistry } from "../v201/inboundRegistryV201";
import { buildV21InboundRegistry } from "../v21/inboundRegistryV21";

/**
 * #537: TriggerMessage SignChargingStationCertificate / SignV2GCertificate
 * (F06, A02.FR.02/03/13) and the SignCertificate resend back-off
 * (A02.FR.17-19) on a 2.0.1 and a 2.1 station.
 */

interface WireCall {
  kind: "call";
  messageId: string;
  action: string;
  payload: Record<string, unknown>;
}
type WireEvent =
  WireCall | { kind: "result"; messageId: string; payload: unknown };

class FakeSocket {
  readonly wire: WireEvent[] = [];
  private handler:
    | ((type: number, id: string, action: string, payload: unknown) => void)
    | null = null;

  setMessageHandler(
    h: (type: number, id: string, action: string, payload: unknown) => void,
  ): void {
    this.handler = h;
  }
  onCloseTransaction(): void {}
  currentGeneration(): GenerationToken {
    return { gen: 1, closeCause: null } as unknown as GenerationToken;
  }
  isConnected(): boolean {
    return true;
  }
  sendAction(
    messageId: string,
    action: string,
    payload: Record<string, unknown>,
    _gen: GenerationToken,
    onSettled?: (s: Settlement) => void,
  ): boolean {
    this.wire.push({ kind: "call", messageId, action, payload });
    onSettled?.({ outcome: "written" });
    return true;
  }
  sendResult(
    messageId: string,
    payload: unknown,
    _gen: GenerationToken,
    onSettled?: (s: Settlement) => void,
  ): void {
    this.wire.push({ kind: "result", messageId, payload });
    onSettled?.({ outcome: "written" });
  }
  sendError(): void {}
  deliver(messageId: string, action: string, payload: unknown): void {
    this.handler?.(OCPPMessageType.CALL, messageId, action, payload);
  }
  deliverResult(messageId: string, payload: unknown): void {
    this.handler?.(OCPPMessageType.CALLRESULT, messageId, "", payload);
  }
  deliverError(messageId: string): void {
    this.handler?.(OCPPMessageType.CALLERROR, messageId, "", {
      errorCode: "InternalError",
      errorDescription: "boom",
      errorDetails: {},
    });
  }
  calls(action: string): WireCall[] {
    return this.wire.filter(
      (e): e is WireCall => e.kind === "call" && e.action === action,
    );
  }
  result(messageId: string): unknown {
    return this.wire.find(
      (e) => e.kind === "result" && e.messageId === messageId,
    )?.payload;
  }
}

const VERSIONS = {
  "OCPP-2.0.1": {
    registry: buildV201InboundRegistry,
    validTrigger: isValidTriggerMessageResponseV201,
    validSign: isValidSignCertificateRequestV201,
    validSigned: isValidCertificateSignedResponseV201,
  },
  "OCPP-2.1": {
    registry: buildV21InboundRegistry,
    validTrigger: isValidTriggerMessageResponseV21,
    validSign: isValidSignCertificateRequestV21,
    validSigned: isValidCertificateSignedResponseV21,
  },
} as const;

type Version = keyof typeof VERSIONS;

function setup(version: Version) {
  const socket = new FakeSocket();
  const configuration = new ConfigurationStore(
    "cp-sign",
    defaultConfiguration({
      connectorNumber: 1,
      wsUrl: "ws://csms.example/ocpp/",
      ocppVersion: version,
    } as ChargePoint),
    null,
  );
  configuration.applyChange("CertSigningWaitMinimum", "10");
  configuration.applyChange("CertSigningRepeatTimes", "2");
  // Under the 10000 of the schema, which would refuse a longer chain first.
  configuration.setRuntimeValue("MaxCertificateChainSize", 6000);
  const certificateStore = new CertificateStore();
  const chargePoint = {
    id: "cp-sign",
    ocppVersion: version,
    configuration,
    certificateStore,
    certificateQuirks: {},
    notifyIncomingCall: vi.fn(),
    notifyIncomingCallCompleted: vi.fn(),
    notifyOutgoingCall: vi.fn(),
    getInboundCallPolicy: vi.fn(() => undefined),
    hasResponseOverride: vi.fn(() => false),
    consumeResponseOverride: vi.fn(() => null),
    clearResponseOverride: vi.fn(),
    adoptRenewedClientCertificate: vi.fn(() => Promise.resolve()),
    useRenewedClientCertificate: vi.fn(() => Promise.resolve()),
  } as unknown as ChargePoint;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
  const handler = new OCPPMessageHandlerV201(
    chargePoint,
    socket as unknown as OCPPWebSocket,
    logger,
    VERSIONS[version].registry(),
  );
  return { socket, handler, certificateStore };
}

/** Lets the CSR generation (WebCrypto, not timers) settle. */
async function settle(socket: FakeSocket, count: number): Promise<void> {
  await vi.waitUntil(() => socket.calls("SignCertificate").length >= count, {
    timeout: 5_000,
    interval: 5,
  });
}

let seq = 0;

async function trigger(
  socket: FakeSocket,
  requestedMessage: string,
): Promise<unknown> {
  const id = `trigger-${++seq}`;
  socket.deliver(id, "TriggerMessage", { requestedMessage });
  await Promise.resolve();
  return socket.result(id);
}

async function deliverSigned(
  socket: FakeSocket,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const id = `signed-${++seq}`;
  socket.deliver(id, "CertificateSigned", payload);
  await vi.waitUntil(() => socket.result(id) !== undefined, {
    timeout: 5_000,
    interval: 5,
  });
  return socket.result(id);
}

describe.each(Object.keys(VERSIONS) as Version[])("%s", (version) => {
  const { validTrigger, validSign, validSigned } = VERSIONS[version];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["SignChargingStationCertificate", "ChargingStationCertificate"],
    ["SignV2GCertificate", "V2GCertificate"],
  ] as const)(
    "answers TriggerMessage %s, then sends a new CSR for %s (A02.FR.02/03/13)",
    async (requestedMessage, certificateType) => {
      const { socket, certificateStore } = setup(version);

      const answer = await trigger(socket, requestedMessage);
      expect(answer).toEqual({ status: "Accepted" });
      expect(validTrigger(answer)).toBe(true);
      await settle(socket, 1);

      const [sign] = socket.calls("SignCertificate");
      // F06.FR.04: the TriggerMessageResponse goes first.
      expect(socket.wire.indexOf(sign)).toBeGreaterThan(
        socket.wire.findIndex((e) => e.kind === "result"),
      );
      expect(sign.payload.certificateType).toBe(certificateType);
      expect(sign.payload.csr).toBe(
        certificateStore.pendingCsr(certificateType),
      );
      expect(validSign(sign.payload)).toBe(true);
    },
  );

  it("generates a new key pair on every trigger (A02.FR.02)", async () => {
    const { socket } = setup(version);
    await trigger(socket, "SignChargingStationCertificate");
    await settle(socket, 1);
    await trigger(socket, "SignChargingStationCertificate");
    await settle(socket, 2);
    const [first, second] = socket.calls("SignCertificate");
    expect(second.payload.csr).not.toBe(first.payload.csr);
  });

  // #553: 2.1 F06.FR.08. 2.0.1 has no V2G20 certificate and keeps
  // answering NotImplemented for SignCombinedCertificate.
  if (version === "OCPP-2.0.1") {
    it("answers NotImplemented for SignCombinedCertificate", async () => {
      const { socket } = setup(version);
      expect(await trigger(socket, "SignCombinedCertificate")).toEqual({
        status: "NotImplemented",
      });
      expect(socket.calls("SignCertificate")).toEqual([]);
    });
  } else {
    it("answers TriggerMessage SignV2G20Certificate, then sends a new CSR for V2G20Certificate (F06.FR.08)", async () => {
      const { socket, certificateStore } = setup(version);

      const answer = await trigger(socket, "SignV2G20Certificate");
      expect(answer).toEqual({ status: "Accepted" });
      expect(validTrigger(answer)).toBe(true);
      await settle(socket, 1);

      const sign = socket.calls("SignCertificate");
      expect(sign).toHaveLength(1);
      expect(socket.wire.indexOf(sign[0])).toBeGreaterThan(
        socket.wire.findIndex((e) => e.kind === "result"),
      );
      expect(sign[0].payload.certificateType).toBe("V2G20Certificate");
      expect(sign[0].payload.csr).toBe(
        certificateStore.pendingCsr("V2G20Certificate"),
      );
      expect(validSign(sign[0].payload)).toBe(true);
    });

    it("stores the V2G20Certificate chain that answers the trigger (F06.FR.08)", async () => {
      const { socket, certificateStore } = setup(version);
      await trigger(socket, "SignV2G20Certificate");
      await settle(socket, 1);
      const [sign] = socket.calls("SignCertificate");
      socket.deliverResult(sign.messageId, { status: "Accepted" });

      const root = await selfSignedRoot("01", "V2G20 Root");
      const leaf = await leafForCsr("02", sign.payload.csr as string, root);
      const answer = await deliverSigned(socket, {
        certificateChain: leaf,
        certificateType: "V2G20Certificate",
      });

      expect(answer).toEqual({ status: "Accepted" });
      expect(validSigned(answer)).toBe(true);
      expect(
        certificateStore.listSignedChains("V2G20Certificate"),
      ).toHaveLength(1);
      // The chain names no OCSP responder, so nothing is asked (M06.FR.07).
      expect(socket.calls("GetCertificateStatus")).toHaveLength(0);
    });

    it("answers TriggerMessage SignCombinedCertificate, then sends one CSR without a certificateType (F06.FR.08)", async () => {
      const { socket, certificateStore } = setup(version);

      const answer = await trigger(socket, "SignCombinedCertificate");
      expect(answer).toEqual({ status: "Accepted" });
      expect(validTrigger(answer)).toBe(true);
      await settle(socket, 1);

      const sign = socket.calls("SignCertificate");
      expect(sign).toHaveLength(1);
      expect(socket.wire.indexOf(sign[0])).toBeGreaterThan(
        socket.wire.findIndex((e) => e.kind === "result"),
      );
      // The 2.1 enum text: omitted means the certificate serves the CSMS and
      // the 15118 connection alike.
      expect(sign[0].payload).not.toHaveProperty("certificateType");
      expect(sign[0].payload.csr).toBe(
        certificateStore.pendingCsr("ChargingStationCertificate"),
      );
      expect(validSign(sign[0].payload)).toBe(true);
    });

    it("stores the chain that answers the combined trigger as the Charging Station certificate, and resends the request unchanged", async () => {
      const { socket, certificateStore } = setup(version);
      await trigger(socket, "SignCombinedCertificate");
      await settle(socket, 1);
      const [sign] = socket.calls("SignCertificate");
      socket.deliverResult(sign.messageId, { status: "Accepted" });

      // A02.FR.17-19: the back-off resends what was sent.
      vi.advanceTimersByTime(10_000);
      expect(socket.calls("SignCertificate")[1].payload).toEqual(sign.payload);

      const root = await selfSignedRoot("01", "Combined Root");
      const leaf = await leafForCsr("02", sign.payload.csr as string, root);
      const answer = await deliverSigned(socket, { certificateChain: leaf });

      expect(answer).toEqual({ status: "Accepted" });
      expect(validSigned(answer)).toBe(true);
      expect(
        certificateStore.listSignedChains("ChargingStationCertificate"),
      ).toHaveLength(1);
    });
  }

  it("resends the same request after W then 2W, CertSigningRepeatTimes times (A02.FR.17-19)", async () => {
    const { socket } = setup(version);
    await trigger(socket, "SignV2GCertificate");
    await settle(socket, 1);
    const [first] = socket.calls("SignCertificate");
    socket.deliverResult(first.messageId, { status: "Accepted" });

    vi.advanceTimersByTime(9_999);
    expect(socket.calls("SignCertificate")).toHaveLength(1);
    vi.advanceTimersByTime(1);
    const resent = socket.calls("SignCertificate");
    expect(resent).toHaveLength(2);
    expect(resent[1].payload).toEqual(first.payload);
    expect(resent[1].messageId).not.toBe(first.messageId);

    socket.deliverResult(resent[1].messageId, { status: "Accepted" });
    vi.advanceTimersByTime(19_999);
    expect(socket.calls("SignCertificate")).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(socket.calls("SignCertificate")).toHaveLength(3);

    // CertSigningRepeatTimes = 2: no third resend.
    socket.deliverResult(socket.calls("SignCertificate")[2].messageId, {
      status: "Accepted",
    });
    vi.advanceTimersByTime(10 * 60_000);
    expect(socket.calls("SignCertificate")).toHaveLength(3);

    // A02.FR.19: a TriggerMessage starts over.
    await trigger(socket, "SignV2GCertificate");
    await settle(socket, 4);
    socket.deliverResult(socket.calls("SignCertificate")[3].messageId, {
      status: "Accepted",
    });
    vi.advanceTimersByTime(10_000);
    expect(socket.calls("SignCertificate")).toHaveLength(5);
  });

  it("keeps resending after a CALLERROR or no answer to a resend (A02.FR.18)", async () => {
    const { socket } = setup(version);
    await trigger(socket, "SignChargingStationCertificate");
    await settle(socket, 1);
    const [first] = socket.calls("SignCertificate");
    socket.deliverResult(first.messageId, { status: "Accepted" });

    vi.advanceTimersByTime(10_000);
    const resent = socket.calls("SignCertificate");
    expect(resent).toHaveLength(2);
    socket.deliverError(resent[1].messageId);

    // The wait that expired doubles regardless: 2W after the resend.
    vi.advanceTimersByTime(19_999);
    expect(socket.calls("SignCertificate")).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(socket.calls("SignCertificate")).toHaveLength(3);

    // CertSigningRepeatTimes = 2, the last resend unanswered: no third.
    vi.advanceTimersByTime(10 * 60_000);
    expect(socket.calls("SignCertificate")).toHaveLength(3);
  });

  it("resends the control-plane SignCertificate unchanged (no certificateType)", async () => {
    const { socket, handler } = setup(version);
    await handler.sendSignCertificate();
    const [first] = socket.calls("SignCertificate");
    expect(first.payload).not.toHaveProperty("certificateType");
    socket.deliverResult(first.messageId, { status: "Accepted" });
    vi.advanceTimersByTime(10_000);
    expect(socket.calls("SignCertificate")[1].payload).toEqual(first.payload);
  });

  // recordPendingCsr keeps the pending CSR when the given one does not
  // parse, so that CSR is not the one the back-off waits on.
  it.each(["Accepted", "Rejected"])(
    "sends a CSR that does not parse once, the pending CSR keeping its back-off and resend (%s)",
    async (status) => {
      const { socket, handler } = setup(version);
      await handler.sendSignCertificate();
      const [pending] = socket.calls("SignCertificate");
      socket.deliverResult(pending.messageId, { status: "Accepted" });

      await handler.sendSignCertificate("not a csr");
      const [, refused] = socket.calls("SignCertificate");
      expect(refused.payload).toEqual({ csr: "not a csr" });
      socket.deliverResult(refused.messageId, { status });

      vi.advanceTimersByTime(10_000);
      const calls = socket.calls("SignCertificate");
      expect(calls).toHaveLength(3);
      expect(calls[2].payload).toEqual(pending.payload);
    },
  );

  it("never resends a CSR that does not parse", async () => {
    const { socket, handler } = setup(version);
    await handler.sendSignCertificate("not a csr");
    const [refused] = socket.calls("SignCertificate");
    socket.deliverResult(refused.messageId, { status: "Accepted" });

    vi.advanceTimersByTime(10 * 60_000);
    expect(socket.calls("SignCertificate")).toHaveLength(1);
  });

  it("does not resend once CertificateSigned is accepted", async () => {
    const { socket } = setup(version);
    await trigger(socket, "SignChargingStationCertificate");
    await settle(socket, 1);
    const [sign] = socket.calls("SignCertificate");
    socket.deliverResult(sign.messageId, { status: "Accepted" });

    const root = await selfSignedRoot("01", "Root");
    const leaf = await leafForCsr("02", sign.payload.csr as string, root);
    const answer = await deliverSigned(socket, {
      certificateChain: leaf,
      certificateType: "ChargingStationCertificate",
    });
    expect(answer).toEqual({ status: "Accepted" });
    expect(validSigned(answer)).toBe(true);

    vi.advanceTimersByTime(10 * 60_000);
    expect(socket.calls("SignCertificate")).toHaveLength(1);
  });

  it("leaves no wait behind once CertificateSigned is accepted", async () => {
    const { socket } = setup(version);
    await trigger(socket, "SignChargingStationCertificate");
    await settle(socket, 1);
    const [sign] = socket.calls("SignCertificate");
    socket.deliverResult(sign.messageId, { status: "Accepted" });
    const waiting = vi.getTimerCount();

    const root = await selfSignedRoot("01", "Root");
    await deliverSigned(socket, {
      certificateChain: await leafForCsr(
        "02",
        sign.payload.csr as string,
        root,
      ),
      certificateType: "ChargingStationCertificate",
    });

    expect(vi.getTimerCount()).toBe(waiting - 1);
  });

  // #537: only an Accepted chain ends the sequence. A02.FR.17 asks about a
  // CertificateSigned "for this CSR", and without an A02.FR.06 period or
  // hierarchy check no rejection can be tied to this CSR as an invalid
  // answer, so A02.FR.20 has no case to apply to yet.
  describe("a rejected CertificateSigned leaves the resends going", () => {
    const leafForAnotherCsr = async () =>
      leafForCsr(
        "02",
        await new CertificateStore().generateNewCsr("cp-other", "CPO"),
        await selfSignedRoot("01", "Root"),
      );

    it.each<
      [string, () => Promise<Record<string, unknown>>, number /* events */]
    >([
      [
        "a malformed chain",
        async () => ({
          certificateChain: "not a certificate",
          certificateType: "ChargingStationCertificate",
        }),
        1,
      ],
      [
        // A02.FR.16 asks for Rejected only: no security event.
        "a chain over MaxCertificateChainSize",
        async () => ({
          certificateChain: "x".repeat(6_001),
          certificateType: "ChargingStationCertificate",
        }),
        0,
      ],
      [
        "a leaf that does not match the CSR's public key",
        async () => ({
          certificateChain: await leafForAnotherCsr(),
          certificateType: "ChargingStationCertificate",
        }),
        1,
      ],
      [
        "a chain for a use with no pending CSR",
        async () => ({
          certificateChain: await leafForAnotherCsr(),
          certificateType: "V2GCertificate",
        }),
        1,
      ],
    ])(
      "goes on after %s, up to CertSigningRepeatTimes",
      async (_name, payload, events) => {
        const { socket } = setup(version);
        await trigger(socket, "SignChargingStationCertificate");
        await settle(socket, 1);
        const [sign] = socket.calls("SignCertificate");
        socket.deliverResult(sign.messageId, { status: "Accepted" });

        const answer = await deliverSigned(socket, await payload());
        expect(answer).toEqual({ status: "Rejected" });
        expect(socket.calls("SecurityEventNotification")).toHaveLength(events);

        vi.advanceTimersByTime(10_000);
        expect(socket.calls("SignCertificate")).toHaveLength(2);
        expect(socket.calls("SignCertificate")[1].payload).toEqual(
          sign.payload,
        );

        // A second rejection does not start the sequence over either.
        await deliverSigned(socket, await payload());
        vi.advanceTimersByTime(20_000);
        expect(socket.calls("SignCertificate")).toHaveLength(3);
        vi.advanceTimersByTime(10 * 60_000);
        expect(socket.calls("SignCertificate")).toHaveLength(3);
      },
    );

    it("does not let a chain for a CSR a newer trigger replaced cut the current CSR's resends", async () => {
      const { socket } = setup(version);
      await trigger(socket, "SignChargingStationCertificate");
      await settle(socket, 1);
      await trigger(socket, "SignChargingStationCertificate");
      await settle(socket, 2);
      const [stale, current] = socket.calls("SignCertificate");
      socket.deliverResult(current.messageId, { status: "Accepted" });

      const root = await selfSignedRoot("01", "Root");
      const answer = await deliverSigned(socket, {
        certificateChain: await leafForCsr(
          "02",
          stale.payload.csr as string,
          root,
        ),
        certificateType: "ChargingStationCertificate",
      });
      expect(answer).toEqual({ status: "Rejected" });

      vi.advanceTimersByTime(10_000);
      expect(socket.calls("SignCertificate")).toHaveLength(3);
      expect(socket.calls("SignCertificate")[2].payload).toEqual(
        current.payload,
      );
    });

    it("still ends on the Accepted chain that follows", async () => {
      const { socket } = setup(version);
      await trigger(socket, "SignChargingStationCertificate");
      await settle(socket, 1);
      const [sign] = socket.calls("SignCertificate");
      socket.deliverResult(sign.messageId, { status: "Accepted" });
      await deliverSigned(socket, {
        certificateChain: "not a certificate",
        certificateType: "ChargingStationCertificate",
      });

      const root = await selfSignedRoot("01", "Root");
      const answer = await deliverSigned(socket, {
        certificateChain: await leafForCsr(
          "02",
          sign.payload.csr as string,
          root,
        ),
        certificateType: "ChargingStationCertificate",
      });
      expect(answer).toEqual({ status: "Accepted" });

      vi.advanceTimersByTime(10 * 60_000);
      expect(socket.calls("SignCertificate")).toHaveLength(1);
    });
  });

  it("does not resend when the CSMS rejects the SignCertificateRequest", async () => {
    const { socket } = setup(version);
    await trigger(socket, "SignChargingStationCertificate");
    await settle(socket, 1);
    const [sign] = socket.calls("SignCertificate");
    socket.deliverResult(sign.messageId, { status: "Rejected" });
    vi.advanceTimersByTime(10 * 60_000);
    expect(socket.calls("SignCertificate")).toHaveLength(1);
  });

  it("ignores a late answer to a request a newer CSR replaced", async () => {
    const { socket } = setup(version);
    await trigger(socket, "SignChargingStationCertificate");
    await settle(socket, 1);
    await trigger(socket, "SignChargingStationCertificate");
    await settle(socket, 2);
    const [stale, current] = socket.calls("SignCertificate");
    socket.deliverResult(current.messageId, { status: "Accepted" });
    vi.advanceTimersByTime(5_000);
    // The old CSR's Rejected neither stops the current back-off…
    socket.deliverResult(stale.messageId, { status: "Rejected" });
    vi.advanceTimersByTime(5_000);
    expect(socket.calls("SignCertificate")).toHaveLength(3);
    expect(socket.calls("SignCertificate")[2].payload).toEqual(current.payload);
  });

  it("does not start the back-off on a replaced request's Accepted", async () => {
    const { socket } = setup(version);
    await trigger(socket, "SignChargingStationCertificate");
    await settle(socket, 1);
    await trigger(socket, "SignChargingStationCertificate");
    await settle(socket, 2);
    const [stale, current] = socket.calls("SignCertificate");
    socket.deliverResult(stale.messageId, { status: "Accepted" });
    vi.advanceTimersByTime(5_000);
    // …nor starts it before the current request is accepted.
    socket.deliverResult(current.messageId, { status: "Accepted" });
    vi.advanceTimersByTime(5_000);
    expect(socket.calls("SignCertificate")).toHaveLength(2);
    vi.advanceTimersByTime(5_000);
    expect(socket.calls("SignCertificate")).toHaveLength(3);
  });

  describe("across a reconnect (A02.FR.17-19)", () => {
    function reconnect(handler: OCPPMessageHandlerV201): void {
      handler.onWebSocketClosed();
      handler.setBootStatus({ status: "Accepted" });
    }

    it("holds the wait while closed and runs what it had left after the next accepted boot", async () => {
      const { socket, handler } = setup(version);
      await trigger(socket, "SignV2GCertificate");
      await settle(socket, 1);
      const [sign] = socket.calls("SignCertificate");
      socket.deliverResult(sign.messageId, { status: "Accepted" });
      vi.advanceTimersByTime(4_000);

      handler.onWebSocketClosed();
      vi.advanceTimersByTime(10 * 60_000);
      expect(socket.calls("SignCertificate")).toHaveLength(1);

      handler.setBootStatus({ status: "Accepted" });
      vi.advanceTimersByTime(5_999);
      expect(socket.calls("SignCertificate")).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(socket.calls("SignCertificate")).toHaveLength(2);
      expect(socket.calls("SignCertificate")[1].payload).toEqual(sign.payload);
      handler.onWebSocketClosed();
    });

    it("keeps the doubled wait and the resend count", async () => {
      const { socket, handler } = setup(version);
      await trigger(socket, "SignV2GCertificate");
      await settle(socket, 1);
      const [sign] = socket.calls("SignCertificate");
      socket.deliverResult(sign.messageId, { status: "Accepted" });
      vi.advanceTimersByTime(10_000);
      expect(socket.calls("SignCertificate")).toHaveLength(2);

      reconnect(handler);
      vi.advanceTimersByTime(19_999);
      expect(socket.calls("SignCertificate")).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(socket.calls("SignCertificate")).toHaveLength(3);

      // CertSigningRepeatTimes (2) reached: a reconnect does not start over.
      reconnect(handler);
      vi.advanceTimersByTime(10 * 60_000);
      expect(socket.calls("SignCertificate")).toHaveLength(3);
      handler.onWebSocketClosed();
    });

    it("goes on resending a CSR whose CertificateSigned was rejected", async () => {
      const { socket, handler, certificateStore } = setup(version);
      await trigger(socket, "SignChargingStationCertificate");
      await settle(socket, 1);
      const [sign] = socket.calls("SignCertificate");
      socket.deliverResult(sign.messageId, { status: "Accepted" });
      await deliverSigned(socket, {
        certificateChain: "not a certificate",
        certificateType: "ChargingStationCertificate",
      });
      expect(
        certificateStore.pendingCsr("ChargingStationCertificate"),
      ).toBeDefined();

      reconnect(handler);
      vi.advanceTimersByTime(10_000);
      expect(socket.calls("SignCertificate")).toHaveLength(2);
      expect(socket.calls("SignCertificate")[1].payload).toEqual(sign.payload);
      handler.onWebSocketClosed();
    });

    it("does not resend a CSR the CSMS did not accept", async () => {
      const { socket, handler } = setup(version);
      await trigger(socket, "SignChargingStationCertificate");
      await settle(socket, 1);
      const [sign] = socket.calls("SignCertificate");
      socket.deliverResult(sign.messageId, { status: "Rejected" });

      reconnect(handler);
      vi.advanceTimersByTime(10 * 60_000);
      expect(socket.calls("SignCertificate")).toHaveLength(1);
      handler.onWebSocketClosed();
    });

    it("does not arm a second timer when the boot is accepted twice", async () => {
      const { socket, handler } = setup(version);
      await trigger(socket, "SignV2GCertificate");
      await settle(socket, 1);
      const [sign] = socket.calls("SignCertificate");
      socket.deliverResult(sign.messageId, { status: "Accepted" });

      reconnect(handler);
      handler.setBootStatus({ status: "Accepted" });
      vi.advanceTimersByTime(10_000);
      expect(socket.calls("SignCertificate")).toHaveLength(2);
      handler.onWebSocketClosed();
    });
  });
});

// #537: the control-plane `security_event_notification` method used to be
// a WARN on 2.x; it now sends A04 SecurityEventNotificationRequest.
describe.each([
  ["OCPP-2.0.1", isValidSecurityEventNotificationRequestV201],
  ["OCPP-2.1", isValidSecurityEventNotificationRequestV21],
] as const)("%s SecurityEventNotification", (version, validEvent) => {
  it("sends type, timestamp and techInfo", () => {
    const { socket, handler } = setup(version);
    handler.sendSecurityEventNotification("FirmwareUpdated", "v1.2.3");
    const [event] = socket.calls("SecurityEventNotification");
    expect(event.payload).toEqual({
      type: "FirmwareUpdated",
      timestamp: expect.any(String),
      techInfo: "v1.2.3",
    });
    expect(Number.isNaN(Date.parse(event.payload.timestamp as string))).toBe(
      false,
    );
    expect(validEvent(event.payload)).toBe(true);
  });

  it("leaves techInfo out when none is given", () => {
    const { socket, handler } = setup(version);
    handler.sendSecurityEventNotification("ResetOrReboot");
    const [event] = socket.calls("SecurityEventNotification");
    expect(event.payload).not.toHaveProperty("techInfo");
    expect(validEvent(event.payload)).toBe(true);
  });

  // #537: the control plane reports a dropped CALL as `disconnected`, like
  // the first CALL of get_15118_ev_certificate.
  describe("the promise it returns", () => {
    it("resolves once the CALL is written, without waiting for an answer", async () => {
      const { socket, handler } = setup(version);
      await expect(
        handler.sendSecurityEventNotification("ResetOrReboot"),
      ).resolves.toBeUndefined();
      expect(socket.calls("SecurityEventNotification")).toHaveLength(1);
    });

    it("stays pending while the pipeline holds the CALL", async () => {
      const { socket, handler } = setup(version);
      let settled: ((s: Settlement) => void) | undefined;
      vi.spyOn(socket, "sendAction").mockImplementation(
        (_id, _action, _payload, _gen, onSettled) => {
          settled = onSettled;
          return true;
        },
      );
      const done = vi.fn();
      void handler.sendSecurityEventNotification("ResetOrReboot").then(done);

      await Promise.resolve();
      expect(done).not.toHaveBeenCalled();
      settled?.({ outcome: "written" });
      await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
    });

    it("rejects as dropped when the socket is not connected, sending nothing", async () => {
      const { socket, handler } = setup(version);
      vi.spyOn(socket, "isConnected").mockReturnValue(false);

      const sending = handler.sendSecurityEventNotification("ResetOrReboot");

      await expect(sending).rejects.toBeInstanceOf(OcppCallNoAnswerError);
      await expect(sending).rejects.toMatchObject({
        reason: "dropped",
        message: expect.stringContaining("not_connected"),
      });
      expect(socket.calls("SecurityEventNotification")).toHaveLength(0);
    });

    it.each(["socket_closed", "write_failed", "queue_overflow", "disposed"])(
      "rejects as dropped when the pipeline settles it %s",
      async (outcome) => {
        const { socket, handler } = setup(version);
        vi.spyOn(socket, "sendAction").mockImplementation(
          (_id, _action, _payload, _gen, onSettled) => {
            onSettled?.({ outcome } as Settlement);
            return true;
          },
        );

        await expect(
          handler.sendSecurityEventNotification("ResetOrReboot"),
        ).rejects.toMatchObject({
          reason: "dropped",
          message: expect.stringContaining(outcome),
        });
      },
    );

    it("rejects as dropped when the socket does not accept it", async () => {
      const { socket, handler } = setup(version);
      vi.spyOn(socket, "sendAction").mockReturnValue(false);

      await expect(
        handler.sendSecurityEventNotification("ResetOrReboot"),
      ).rejects.toMatchObject({ reason: "dropped" });
    });
  });
});

// #537 M06: GetCertificateStatus for the station's V2G certificates.
describe.each([
  ["OCPP-2.0.1", isValidGetCertificateStatusRequestV201, 512],
  ["OCPP-2.1", isValidGetCertificateStatusRequestV21, 2000],
] as const)("%s GetCertificateStatus", (version, validRequest, maxUrl) => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A V2G chain (leaf + sub-CA) signed for a triggered CSR. */
  async function installV2gChain(
    env: ReturnType<typeof setup>,
    leafUrl = "http://ocsp.example.com/leaf",
  ): Promise<unknown> {
    await trigger(env.socket, "SignV2GCertificate");
    await settle(env.socket, 1);
    const [sign] = env.socket.calls("SignCertificate");
    const root = await selfSignedRoot("01", "V2G Root");
    const sub = await subCa("02", "V2G Sub-CA", root, {
      ocspUrl: "http://ocsp.example.com/sub",
    });
    const leaf = await leafForCsr("0a1b", sign.payload.csr as string, sub, {
      ocspUrl: leafUrl,
    });
    return deliverSigned(env.socket, {
      certificateChain: `${leaf}\n${sub.pem}`,
      certificateType: "V2GCertificate",
    });
  }

  it("asks for the new V2G certificate and its sub-CA once installed (M06.FR.07)", async () => {
    const env = setup(version);
    expect(await installV2gChain(env)).toEqual({ status: "Accepted" });

    const requests = env.socket.calls("GetCertificateStatus");
    const chain = env.certificateStore.listSignedChains("V2GCertificate")[0];
    expect(requests.map((r) => r.payload)).toEqual([
      {
        ocspRequestData: {
          ...chain.hashData[0],
          responderURL: "http://ocsp.example.com/leaf",
        },
      },
      {
        ocspRequestData: {
          ...chain.hashData[1],
          responderURL: "http://ocsp.example.com/sub",
        },
      },
    ]);
    expect(requests[0].payload.ocspRequestData).toMatchObject({
      serialNumber: "a1b",
    });
    for (const request of requests) {
      expect(validRequest(request.payload)).toBe(true);
    }
  });

  it("caches an Accepted ocspResult and keeps nothing for Failed (M06.FR.02-04, FR.06)", async () => {
    const env = setup(version);
    await installV2gChain(env);
    const [leafRequest, subRequest] = env.socket.calls("GetCertificateStatus");
    env.socket.deliverResult(leafRequest.messageId, {
      status: "Accepted",
      ocspResult: OCSP_RESPONSE_GOOD_BASE64,
    });
    env.socket.deliverResult(subRequest.messageId, { status: "Failed" });

    const [leafHash, subHash] =
      env.certificateStore.listSignedChains("V2GCertificate")[0].hashData;
    expect(env.certificateStore.cachedOcspResponse(leafHash)?.ocspResult).toBe(
      OCSP_RESPONSE_GOOD_BASE64,
    );
    expect(env.certificateStore.cachedOcspResponse(subHash)).toBeUndefined();
  });

  it("asks again at boot and then every week (M06.FR.06, FR.10)", async () => {
    const env = setup(version);
    await installV2gChain(env);
    expect(env.socket.calls("GetCertificateStatus")).toHaveLength(2);

    env.handler.setBootStatus({ status: "Accepted" });
    expect(env.socket.calls("GetCertificateStatus")).toHaveLength(4);

    vi.advanceTimersByTime(7 * 24 * 3600 * 1000 - 1);
    expect(env.socket.calls("GetCertificateStatus")).toHaveLength(4);
    vi.advanceTimersByTime(1);
    expect(env.socket.calls("GetCertificateStatus")).toHaveLength(6);

    env.handler.onWebSocketClosed();
    vi.advanceTimersByTime(7 * 24 * 3600 * 1000);
    expect(env.socket.calls("GetCertificateStatus")).toHaveLength(6);
  });

  it("sends nothing for a Charging Station certificate or without a responder URL", async () => {
    const env = setup(version);
    env.handler.setBootStatus({ status: "Accepted" });
    await trigger(env.socket, "SignChargingStationCertificate");
    await settle(env.socket, 1);
    const [sign] = env.socket.calls("SignCertificate");
    const root = await selfSignedRoot("01", "Root");
    const sub = await subCa("02", "Sub", root, {
      ocspUrl: "http://ocsp.example.com/sub",
    });
    await deliverSigned(env.socket, {
      certificateChain: `${await leafForCsr("03", sign.payload.csr as string, sub)}\n${sub.pem}`,
      certificateType: "ChargingStationCertificate",
    });
    expect(env.socket.calls("GetCertificateStatus")).toEqual([]);
  });

  it(`leaves out a responderURL longer than ${maxUrl} characters`, async () => {
    const env = setup(version);
    const long = `http://ocsp.example.com/${"x".repeat(maxUrl)}`;
    await installV2gChain(env, long);
    expect(
      env.socket
        .calls("GetCertificateStatus")
        .map(
          (r) =>
            (r.payload.ocspRequestData as { responderURL: string })
              .responderURL,
        ),
    ).toEqual(["http://ocsp.example.com/sub"]);
  });
});
