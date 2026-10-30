import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChargePoint,
  RENEWED_CERTIFICATE_RECONNECT_MAX_DEFER_MS,
} from "../ChargePoint";
import { DefaultBootNotification } from "../../types/OcppTypes";
import type { OCPPWebSocket } from "../../../infrastructure/transport/OCPPWebSocket";
import type { Outbox } from "../../transport/Outbox";
import {
  leafForCsr,
  selfSignedRoot,
} from "../../security/__tests__/certificateFixtures";

/**
 * #537 A02.FR.08: the switch to a renewed Charging Station certificate
 * reconnects a connected station only. One that is not connected (never
 * connected, in reconnect back-off, in a simulated outage) presents it at
 * its next connection, which keeps its own timing.
 */
function profile3Station(version = "OCPP-2.0.1"): ChargePoint {
  const cp = new ChargePoint(
    "CP-RENEW-UNIT",
    DefaultBootNotification,
    1,
    "wss://csms.example/ocpp",
    null,
    null,
    null,
    {},
    [],
    version,
    {},
    3,
    undefined,
    undefined,
    { cert: "CONFIGURED CERT", key: "CONFIGURED KEY" },
  );
  cp.events.on("error", () => undefined);
  return cp;
}

function transportOf(cp: ChargePoint): OCPPWebSocket {
  return (cp as unknown as { _webSocket: OCPPWebSocket })._webSocket;
}

function outboxOf(cp: ChargePoint): Outbox {
  return (cp as unknown as { _outbox: Outbox })._outbox;
}

function switchTimerOf(cp: ChargePoint): unknown {
  return (cp as unknown as { _clientCertificateSwitchTimer: unknown })
    ._clientCertificateSwitchTimer;
}

const IDENTITY = {
  cert: "RENEWED CERT",
  key: "RENEWED KEY",
  notBefore: new Date(0),
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ChargePoint.useRenewedClientCertificate", () => {
  it("does not reconnect a station that is not connected", async () => {
    const cp = profile3Station();
    vi.spyOn(cp.certificateStore, "tlsClientIdentity").mockResolvedValue(
      IDENTITY,
    );
    const reset = vi.spyOn(cp, "reset").mockImplementation(() => undefined);

    await cp.useRenewedClientCertificate();

    expect(reset).not.toHaveBeenCalled();
    cp.dispose();
  });

  it("keeps a certificate not yet valid across a manual disconnect", async () => {
    vi.useFakeTimers();
    const cp = profile3Station();
    vi.spyOn(cp.certificateStore, "tlsClientIdentity").mockResolvedValue({
      ...IDENTITY,
      notBefore: new Date(Date.now() + 5_000),
    });
    const present = vi.spyOn(transportOf(cp), "useRenewedClientCertificate");
    const reset = vi.spyOn(cp, "reset").mockImplementation(() => undefined);

    await cp.useRenewedClientCertificate();
    cp.disconnect();
    await vi.advanceTimersByTimeAsync(5_000);

    // Presented at the next connect(), with no reconnect of its own.
    expect(present).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
    cp.dispose();
  });

  it("forgets a renewed identity once the store drops its key", async () => {
    const cp = profile3Station();
    const clear = vi.spyOn(transportOf(cp), "clearRenewedClientCertificate");
    // The store holds a Charging Station chain without a key (one signed
    // for a caller-supplied CSR, say).
    vi.spyOn(cp.certificateStore, "tlsClientIdentity").mockResolvedValue(
      undefined,
    );

    cp.certificateStore.clearAll();
    await vi.waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
    cp.dispose();
  });

  it("keeps the renewed identity when the store installs a keyed chain", async () => {
    const cp = profile3Station();
    const clear = vi.spyOn(transportOf(cp), "clearRenewedClientCertificate");
    const root = await selfSignedRoot("01", "Root");
    const csr = await cp.certificateStore.generateNewCsr(cp.id, "CPO");
    const leaf = await leafForCsr("02", csr, root);

    const outcome = await cp.certificateStore.applySignedChain(
      "ChargingStationCertificate",
      [leaf],
    );
    expect(outcome.status).toBe("Accepted");
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The confirmed identity is the fallback of the one just installed.
    expect(clear).not.toHaveBeenCalled();
    cp.dispose();
  });

  it("keeps the renewed identity while the store holds its key", async () => {
    const cp = profile3Station();
    const clear = vi.spyOn(transportOf(cp), "clearRenewedClientCertificate");
    const identity = vi
      .spyOn(cp.certificateStore, "tlsClientIdentity")
      .mockResolvedValue(IDENTITY);

    cp.certificateStore.clearAll();
    await vi.waitFor(() => expect(identity).toHaveBeenCalled());
    await Promise.resolve();
    expect(clear).not.toHaveBeenCalled();
    cp.dispose();
  });

  describe("reconnect with a transaction message in flight", () => {
    function connectedStation() {
      vi.useFakeTimers();
      const cp = profile3Station();
      vi.spyOn(cp.certificateStore, "tlsClientIdentity").mockResolvedValue(
        IDENTITY,
      );
      vi.spyOn(transportOf(cp), "isOpenOrConnecting").mockReturnValue(true);
      const reset = vi.spyOn(cp, "reset").mockImplementation(() => undefined);
      const inFlight = vi.spyOn(outboxOf(cp), "hasTransactionMessagesInFlight");
      return { cp, reset, inFlight };
    }

    it("waits until no transaction message awaits an answer or a resend", async () => {
      const { cp, reset, inFlight } = connectedStation();
      inFlight.mockReturnValue(true);

      await cp.useRenewedClientCertificate();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(reset).not.toHaveBeenCalled();

      inFlight.mockReturnValue(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reset).toHaveBeenCalledTimes(1);
      cp.dispose();
    });

    it("reconnects anyway once the wait bound is reached", async () => {
      const { cp, reset, inFlight } = connectedStation();
      inFlight.mockReturnValue(true);

      await cp.useRenewedClientCertificate();
      await vi.advanceTimersByTimeAsync(
        RENEWED_CERTIFICATE_RECONNECT_MAX_DEFER_MS - 1_000,
      );
      expect(reset).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reset).toHaveBeenCalledTimes(1);
      cp.dispose();
    });

    it("reconnects at once when nothing is in flight", async () => {
      const { cp, reset, inFlight } = connectedStation();
      inFlight.mockReturnValue(false);

      await cp.useRenewedClientCertificate();
      expect(reset).toHaveBeenCalledTimes(1);
      cp.dispose();
    });

    it("does not reconnect a connection opened again during the wait", async () => {
      const { cp, reset, inFlight } = connectedStation();
      inFlight.mockReturnValue(true);

      await cp.useRenewedClientCertificate();
      // Another connection (a reconnect after a drop) presents it already.
      vi.spyOn(transportOf(cp), "currentGeneration").mockReturnValue({
        gen: 99,
        closeCause: null,
      });
      await vi.advanceTimersByTimeAsync(
        RENEWED_CERTIFICATE_RECONNECT_MAX_DEFER_MS,
      );

      expect(reset).not.toHaveBeenCalled();
      cp.dispose();
    });

    it("does not reconnect a station disconnected during the wait", async () => {
      const { cp, reset, inFlight } = connectedStation();
      inFlight.mockReturnValue(true);
      let open = true;
      vi.spyOn(transportOf(cp), "isOpenOrConnecting").mockImplementation(
        () => open,
      );

      await cp.useRenewedClientCertificate();
      cp.disconnect();
      open = false;
      await vi.advanceTimersByTimeAsync(
        RENEWED_CERTIFICATE_RECONNECT_MAX_DEFER_MS,
      );

      expect(reset).not.toHaveBeenCalled();
      cp.dispose();
    });

    it("leaves no timer behind once disposed during the wait", async () => {
      const { cp, reset, inFlight } = connectedStation();
      inFlight.mockReturnValue(true);

      await cp.useRenewedClientCertificate();
      cp.dispose();
      expect(switchTimerOf(cp)).toBeNull();
      await vi.advanceTimersByTimeAsync(
        RENEWED_CERTIFICATE_RECONNECT_MAX_DEFER_MS,
      );

      expect(reset).not.toHaveBeenCalled();
    });
  });

  describe("a switch superseded while reading the store", () => {
    function deferredIdentities(cp: ChargePoint) {
      const resolvers: ((identity: typeof IDENTITY) => void)[] = [];
      vi.spyOn(cp.certificateStore, "tlsClientIdentity").mockImplementation(
        () => new Promise((resolve) => resolvers.push(resolve)),
      );
      return resolvers;
    }

    const notYetValid = () => ({
      ...IDENTITY,
      notBefore: new Date(Date.now() + 60_000),
    });

    it("keeps a single notBefore wait when called twice", async () => {
      vi.useFakeTimers();
      const cp = profile3Station();
      const resolvers = deferredIdentities(cp);
      const present = vi.spyOn(transportOf(cp), "useRenewedClientCertificate");
      const baseline = vi.getTimerCount();

      const first = cp.useRenewedClientCertificate();
      const second = cp.useRenewedClientCertificate();
      resolvers[1](notYetValid());
      await second;
      resolvers[0](notYetValid());
      await first;

      expect(vi.getTimerCount() - baseline).toBe(1);
      // The one left is the one dispose() cancels.
      const before = vi.getTimerCount();
      cp.dispose();
      expect(switchTimerOf(cp)).toBeNull();
      resolvers.length = 0;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(before).toBeGreaterThan(0);
      expect(resolvers).toHaveLength(0);
      expect(present).not.toHaveBeenCalled();
    });

    it("arms nothing once disposed while reading the store", async () => {
      vi.useFakeTimers();
      const cp = profile3Station();
      const resolvers = deferredIdentities(cp);
      const present = vi.spyOn(transportOf(cp), "useRenewedClientCertificate");

      const pending = cp.useRenewedClientCertificate();
      cp.dispose();
      resolvers[0](notYetValid());
      await pending;

      expect(switchTimerOf(cp)).toBeNull();
      resolvers.length = 0;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(resolvers).toHaveLength(0);
      expect(present).not.toHaveBeenCalled();
    });

    it("presents nothing once disposed while reading a valid identity", async () => {
      const cp = profile3Station();
      const resolvers = deferredIdentities(cp);
      const present = vi.spyOn(transportOf(cp), "useRenewedClientCertificate");

      const pending = cp.useRenewedClientCertificate();
      cp.dispose();
      resolvers[0](IDENTITY);
      await pending;

      expect(present).not.toHaveBeenCalled();
    });
  });

  describe("releaseRenewedClientCertificate (cp.update replaces the instance)", () => {
    it("cancels the wait, forgets the identity and the keys, keeps the chain", async () => {
      vi.useFakeTimers();
      const cp = profile3Station();
      const root = await selfSignedRoot("01", "Root");
      const csr = await cp.certificateStore.generateNewCsr(cp.id, "CPO");
      await cp.certificateStore.applySignedChain("ChargingStationCertificate", [
        await leafForCsr("02", csr, root),
      ]);
      const identity = vi
        .spyOn(cp.certificateStore, "tlsClientIdentity")
        .mockResolvedValue({
          ...IDENTITY,
          notBefore: new Date(Date.now() + 60_000),
        });
      await cp.useRenewedClientCertificate();
      expect(switchTimerOf(cp)).not.toBeNull();
      const clear = vi.spyOn(transportOf(cp), "clearRenewedClientCertificate");
      const present = vi.spyOn(transportOf(cp), "useRenewedClientCertificate");

      cp.releaseRenewedClientCertificate();

      expect(switchTimerOf(cp)).toBeNull();
      expect(clear).toHaveBeenCalledTimes(1);
      identity.mockClear();
      // The store listener is detached: a change reads nothing.
      cp.certificateStore.clearAll();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(identity).not.toHaveBeenCalled();
      expect(present).not.toHaveBeenCalled();
      // A switch requested afterwards is ignored.
      await cp.useRenewedClientCertificate();
      expect(identity).not.toHaveBeenCalled();
      cp.dispose();
    });

    it("drops the store's keys and keeps its chains", async () => {
      const cp = profile3Station();
      const root = await selfSignedRoot("01", "Root");
      const csr = await cp.certificateStore.generateNewCsr(cp.id, "CPO");
      await cp.certificateStore.applySignedChain("ChargingStationCertificate", [
        await leafForCsr("02", csr, root),
      ]);

      cp.releaseRenewedClientCertificate();

      expect(await cp.certificateStore.tlsClientIdentity()).toBeUndefined();
      expect(
        cp.certificateStore.listSignedChains("ChargingStationCertificate"),
      ).toHaveLength(1);
      cp.dispose();
    });
  });
});

describe("DiscardedRenewedClientCertificate (2.1 A02.FR.29)", () => {
  function discardThenBoot(version: string): ReturnType<typeof vi.fn> {
    const cp = profile3Station(version);
    const send = vi
      .spyOn(outboxOf(cp), "sendSecurityEventNotification")
      .mockImplementation(() => undefined);
    vi.spyOn(outboxOf(cp), "sendStatusNotification").mockImplementation(
      () => undefined,
    );
    transportOf(cp).observers.emit("renewedClientCertificateDiscarded", {});
    expect(send).not.toHaveBeenCalled();
    cp.onBootNotificationResult({
      status: "Accepted",
      interval: 0,
      currentTime: new Date().toISOString(),
    });
    cp.onBootNotificationResult({
      status: "Accepted",
      interval: 0,
      currentTime: new Date().toISOString(),
    });
    cp.dispose();
    return send as unknown as ReturnType<typeof vi.fn>;
  }

  it("is sent once, after the next accepted boot, on 2.1", () => {
    const send = discardThenBoot("OCPP-2.1");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe("DiscardedRenewedClientCertificate");
  });

  it("is not sent on 2.0.1, whose security events do not define it", () => {
    expect(discardThenBoot("OCPP-2.0.1")).not.toHaveBeenCalled();
  });
});
