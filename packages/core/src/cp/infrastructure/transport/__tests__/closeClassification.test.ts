import { describe, expect, it } from "vitest";

import {
  classifyFailedAttempt,
  describeConnectError,
  neverReachedCsms,
  type ConnectErrorDetail,
  type FailedAttemptKind,
} from "../ws/closeClassification";
import type { SocketClose } from "../../../domain/transport/ChargePointSocket";

/**
 * #1033 / #1034: what a failed connection attempt was, read from its error
 * event and its close. The shapes come from repro/bun-1.4.x/ws-failure-causes.ts
 * (Bun 1.4.3 and 1.4.4) and from the `ws` fallback in wsUrlWithBasic.ts.
 */

const URL = "WebSocket connection to 'wss://csms.example/ocpp/CP' failed";

/** Bun 1.4.4: `error` carries the cause, the close says nothing. */
const BLANK_1006: SocketClose = { code: 1006, reason: "" };

/** A Bun error event: a message and an `error` with a `code`, nothing else. */
function bunError(tail: string, code?: string): Event {
  const error = new Error(`${URL}: ${tail}`);
  if (code !== undefined) Object.assign(error, { code });
  return { type: "error", message: error.message, error } as unknown as Event;
}

/** The `ws` fallback's error event: the raw Node error, with its syscall. */
function nodeError(code: string, syscall: string): Event {
  const error = Object.assign(new Error(`${syscall} ${code} 127.0.0.1:1`), {
    code,
    syscall,
  });
  return { type: "error", message: error.message, error } as unknown as Event;
}

function kindOf(close: SocketClose, ev?: Event): FailedAttemptKind {
  return classifyFailedAttempt(
    close,
    ev ? describeConnectError(ev) : undefined,
  );
}

describe("classifyFailedAttempt", () => {
  describe("Bun 1.4.4: the error event carries the cause", () => {
    it.each<[string, Event, FailedAttemptKind]>([
      [
        "ECONNREFUSED",
        bunError("Failed to connect", "ECONNREFUSED"),
        "unreached",
      ],
      ["ENOTFOUND", bunError("Failed to connect", "ENOTFOUND"), "unreached"],
      ["EAI_AGAIN", bunError("Failed to connect", "EAI_AGAIN"), "unreached"],
      [
        "EHOSTUNREACH",
        bunError("Failed to connect", "EHOSTUNREACH"),
        "unreached",
      ],
      [
        "ENETUNREACH",
        bunError("Failed to connect", "ENETUNREACH"),
        "unreached",
      ],
      // The CSMS refusing the client certificate: a server was reached.
      ["ECONNRESET", bunError("Connection ended", "ECONNRESET"), "other"],
      [
        "a refused upgrade",
        bunError("Expected 101 status code: 401"),
        "upgrade-refused",
      ],
      [
        "an untrusted server certificate",
        bunError(
          "TLS handshake failed: self signed certificate",
          "DEPTH_ZERO_SELF_SIGNED_CERT",
        ),
        "tls",
      ],
      [
        "a missing client certificate",
        bunError("TLS handshake failed: CERTIFICATE_REQUIRED", "EPROTO"),
        "tls",
      ],
    ])("%s", (_name, ev, kind) => {
      expect(kindOf(BLANK_1006, ev)).toBe(kind);
    });
  });

  describe("Bun 1.4.3: the error has no code, the close says it", () => {
    const noCode = bunError("whatever the message");
    it.each<[string, SocketClose, FailedAttemptKind]>([
      [
        "a refused connection",
        { code: 1006, reason: "Failed to connect" },
        "unreached",
      ],
      [
        "a refused upgrade",
        { code: 1002, reason: "Expected 101 status code" },
        "upgrade-refused",
      ],
      [
        "a TLS handshake failure",
        { code: 1015, reason: "TLS handshake failed" },
        "tls",
      ],
      [
        "a refused client certificate",
        { code: 1006, reason: "Connection ended" },
        "other",
      ],
    ])("%s", (_name, close, kind) => {
      expect(kindOf(close, noCode)).toBe(kind);
      expect(kindOf(close)).toBe(kind);
    });
  });

  describe("the ws fallback", () => {
    it("reads an unreached server from the syscall", () => {
      expect(kindOf(BLANK_1006, nodeError("ECONNREFUSED", "connect"))).toBe(
        "unreached",
      );
      expect(kindOf(BLANK_1006, nodeError("EWHATEVER", "getaddrinfo"))).toBe(
        "unreached",
      );
    });

    it("never calls a reset connection unreached", () => {
      expect(kindOf(BLANK_1006, nodeError("ECONNRESET", "connect"))).toBe(
        "other",
      );
      expect(
        kindOf(
          { code: 1006, reason: "Failed to connect" },
          bunError("Connection ended", "ECONNRESET"),
        ),
      ).toBe("other");
    });

    it("reads a refused upgrade from the reported status", () => {
      const ev = {
        type: "error",
        message: "Unexpected server response: 302",
        httpStatus: 302,
        httpLocation: "wss://edge.example/ocpp/",
      } as unknown as Event;
      expect(describeConnectError(ev)).toEqual<ConnectErrorDetail>({
        message: "Unexpected server response: 302",
        httpStatus: 302,
        httpLocation: "wss://edge.example/ocpp/",
      });
      expect(kindOf(BLANK_1006, ev)).toBe("upgrade-refused");
    });
  });

  it("says nothing about an attempt with no detail at all", () => {
    expect(kindOf(BLANK_1006)).toBe("other");
    expect(kindOf(BLANK_1006, { type: "error" } as Event)).toBe("other");
  });

  it("never reads a refused upgrade from a blank 1006 alone", () => {
    expect(kindOf(BLANK_1006, bunError("Connection ended"))).not.toBe(
      "upgrade-refused",
    );
  });

  it("reads only the fields it knows, without throwing on odd events", () => {
    const odd = {
      type: "error",
      message: 42,
      error: { code: 7, syscall: null },
      httpStatus: "401",
    } as unknown as Event;
    expect(describeConnectError(odd)).toEqual({});
    expect(
      describeConnectError({ type: "error", error: null } as unknown as Event),
    ).toEqual({});
  });
});

describe("neverReachedCsms", () => {
  it("is classifyFailedAttempt saying unreached", () => {
    expect(
      neverReachedCsms(
        BLANK_1006,
        describeConnectError(bunError("Failed to connect", "ECONNREFUSED")),
      ),
    ).toBe(true);
    expect(
      neverReachedCsms(
        BLANK_1006,
        describeConnectError(bunError("Connection ended", "ECONNRESET")),
      ),
    ).toBe(false);
    expect(neverReachedCsms({ code: 1006, reason: "Failed to connect" })).toBe(
      true,
    );
    expect(neverReachedCsms(BLANK_1006)).toBe(false);
  });
});
