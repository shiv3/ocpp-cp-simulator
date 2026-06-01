import { describe, expect, it } from "vitest";

import {
  buildOcppBasicAuthorization,
  buildOcppWebSocketUrl,
} from "./wsUrlWithBasic";

describe("OCPP WebSocket Basic auth", () => {
  it("keeps CLI credentials out of the WebSocket URL", () => {
    expect(
      buildOcppWebSocketUrl({
        baseUrl: "wss://csms.example.com/ocpp/",
        chargePointId: "CP001",
        basicAuth: { username: "CP001", password: "secret" },
      }),
    ).toBe("wss://csms.example.com/ocpp/CP001");
  });

  it("builds the HTTP Basic Authorization header", () => {
    expect(
      buildOcppBasicAuthorization({
        username: "CP001",
        password: "secret",
      }),
    ).toBe("Basic Q1AwMDE6c2VjcmV0");
  });

  it("falls back to a query param for browser WebSocket clients", () => {
    const runtime = globalThis as { document?: unknown };
    const previousDocument = runtime.document;
    runtime.document = {};

    try {
      expect(
        buildOcppWebSocketUrl({
          baseUrl: "wss://csms.example.com/ocpp/",
          chargePointId: "CP001",
          basicAuth: { username: "CP001", password: "secret" },
        }),
      ).toBe("wss://csms.example.com/ocpp/CP001?ocpp_ws_secret=secret");
    } finally {
      if (previousDocument === undefined) {
        delete runtime.document;
      } else {
        runtime.document = previousDocument;
      }
    }
  });
});
