import { describe, expect, it } from "vitest";
import { adaptCentralSystemUrlScheme } from "../ocppUrlScheme";

describe("adaptCentralSystemUrlScheme (#164)", () => {
  // A generic, non-SteVe-boilerplate host/path, used to verify the plain
  // "scheme flips, everything else is preserved" invariant in isolation from
  // the SteVe-specific path rewrite (#178, tested separately below).
  const STEVE = "example.com:8080/ocpp/CentralSystemService/";

  describe("switching to a SOAP transport", () => {
    it("maps ws:// -> http:// and keeps host/port/path", () => {
      expect(adaptCentralSystemUrlScheme(`ws://${STEVE}`, true)).toBe(
        `http://${STEVE}`,
      );
    });

    it("maps wss:// -> https:// (secure stays secure)", () => {
      expect(adaptCentralSystemUrlScheme(`wss://${STEVE}`, true)).toBe(
        `https://${STEVE}`,
      );
    });

    it("leaves an already-compatible http/https URL unchanged", () => {
      expect(adaptCentralSystemUrlScheme(`http://${STEVE}`, true)).toBe(
        `http://${STEVE}`,
      );
      expect(adaptCentralSystemUrlScheme(`https://${STEVE}`, true)).toBe(
        `https://${STEVE}`,
      );
    });
  });

  describe("switching to a JSON/WebSocket transport", () => {
    it("maps http:// -> ws:// and keeps host/port/path", () => {
      expect(adaptCentralSystemUrlScheme(`http://${STEVE}`, false)).toBe(
        `ws://${STEVE}`,
      );
    });

    it("maps https:// -> wss:// (secure stays secure)", () => {
      expect(adaptCentralSystemUrlScheme(`https://${STEVE}`, false)).toBe(
        `wss://${STEVE}`,
      );
    });

    it("leaves an already-compatible ws/wss URL unchanged", () => {
      expect(adaptCentralSystemUrlScheme(`ws://${STEVE}`, false)).toBe(
        `ws://${STEVE}`,
      );
      expect(adaptCentralSystemUrlScheme(`wss://${STEVE}`, false)).toBe(
        `wss://${STEVE}`,
      );
    });
  });

  it("matches schemes case-insensitively (RFC 3986)", () => {
    expect(adaptCentralSystemUrlScheme(`WS://${STEVE}`, true)).toBe(
      `http://${STEVE}`,
    );
    expect(adaptCentralSystemUrlScheme(`WSS://${STEVE}`, true)).toBe(
      `https://${STEVE}`,
    );
    expect(adaptCentralSystemUrlScheme(`HTTP://${STEVE}`, false)).toBe(
      `ws://${STEVE}`,
    );
    expect(adaptCentralSystemUrlScheme(`HTTPS://${STEVE}`, false)).toBe(
      `wss://${STEVE}`,
    );
  });

  it("preserves a custom URL with an unrecognised scheme", () => {
    expect(adaptCentralSystemUrlScheme("example.com/ocpp", true)).toBe(
      "example.com/ocpp",
    );
    expect(adaptCentralSystemUrlScheme("tcp://host:9000", false)).toBe(
      "tcp://host:9000",
    );
  });

  it("does not touch host/port/path — only the scheme is converted", () => {
    expect(
      adaptCentralSystemUrlScheme("wss://ocpp.example.com:443/path?q=1", true),
    ).toBe("https://ocpp.example.com:443/path?q=1");
  });

  describe("SteVe default path rewrite (#178)", () => {
    const STEVE_JSON = "localhost:8080/steve/websocket/CentralSystemService/";
    const STEVE_SOAP = "localhost:8080/steve/services/CentralSystemService";

    it("rewrites the SteVe JSON/websocket path to the SOAP services path when switching to SOAP", () => {
      expect(adaptCentralSystemUrlScheme(`ws://${STEVE_JSON}`, true)).toBe(
        `http://${STEVE_SOAP}`,
      );
      expect(adaptCentralSystemUrlScheme(`wss://${STEVE_JSON}`, true)).toBe(
        `https://${STEVE_SOAP}`,
      );
    });

    it("rewrites the SteVe SOAP services path back to the websocket path when switching to JSON", () => {
      expect(adaptCentralSystemUrlScheme(`http://${STEVE_SOAP}`, false)).toBe(
        `ws://${STEVE_JSON}`,
      );
      expect(adaptCentralSystemUrlScheme(`https://${STEVE_SOAP}`, false)).toBe(
        `wss://${STEVE_JSON}`,
      );
    });

    it("does not rewrite a customized path that isn't the exact SteVe boilerplate", () => {
      expect(
        adaptCentralSystemUrlScheme(
          "ws://localhost:8080/steve/websocket/CentralSystemService/extra",
          true,
        ),
      ).toBe(
        "http://localhost:8080/steve/websocket/CentralSystemService/extra",
      );
      expect(
        adaptCentralSystemUrlScheme("ws://otherhost/some/custom/path", true),
      ).toBe("http://otherhost/some/custom/path");
    });
  });
});
