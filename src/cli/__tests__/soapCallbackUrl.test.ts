import { describe, expect, it } from "vitest";
import {
  buildSoapCallbackUrl,
  isHttpUrl,
  resolveSoapCallbackUrl,
} from "../soapCallbackUrl";

describe("isHttpUrl", () => {
  it("accepts absolute http/https URLs", () => {
    expect(isHttpUrl("http://example.test")).toBe(true);
    expect(isHttpUrl("https://foo.ngrok-free.app/base")).toBe(true);
  });

  it("rejects non-http(s) and non-absolute values", () => {
    expect(isHttpUrl("ftp://example.test")).toBe(false);
    expect(isHttpUrl("ws://example.test")).toBe(false);
    expect(isHttpUrl("example.test")).toBe(false);
    expect(isHttpUrl("/ocpp/soap")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
  });
});

describe("buildSoapCallbackUrl", () => {
  it("derives {base}{soapPath}/{cpId}/ChargePointService", () => {
    expect(
      buildSoapCallbackUrl("https://abcd.ngrok-free.app", "CP-1", "/ocpp/soap"),
    ).toBe("https://abcd.ngrok-free.app/ocpp/soap/CP-1/ChargePointService");
  });

  it("tolerates a trailing slash on the base URL", () => {
    expect(
      buildSoapCallbackUrl(
        "https://abcd.ngrok-free.app/",
        "CP-1",
        "/ocpp/soap",
      ),
    ).toBe("https://abcd.ngrok-free.app/ocpp/soap/CP-1/ChargePointService");
  });

  it("preserves a path prefix on the base URL", () => {
    expect(
      buildSoapCallbackUrl(
        "https://host.test/behind/proxy",
        "CP-1",
        "/ocpp/soap",
      ),
    ).toBe("https://host.test/behind/proxy/ocpp/soap/CP-1/ChargePointService");
  });

  it("honors a custom soap path", () => {
    expect(
      buildSoapCallbackUrl("https://host.test", "CP-1", "/custom/soap"),
    ).toBe("https://host.test/custom/soap/CP-1/ChargePointService");
  });

  it("normalizes a soap path without a leading slash or with a trailing slash", () => {
    expect(
      buildSoapCallbackUrl("https://host.test", "CP-1", "ocpp/soap/"),
    ).toBe("https://host.test/ocpp/soap/CP-1/ChargePointService");
  });

  it("collapses a root soap path to a single slash", () => {
    expect(buildSoapCallbackUrl("https://host.test", "CP-1", "/")).toBe(
      "https://host.test/CP-1/ChargePointService",
    );
  });

  it("percent-encodes a cpId with URL-significant characters", () => {
    // decodeURIComponent(segment) must round-trip back to the exact cpId so the
    // server's route match (decodeURIComponent(match[2]) === cpId) holds.
    const url = buildSoapCallbackUrl(
      "https://host.test",
      "CP 01/A",
      "/ocpp/soap",
    );
    expect(url).toBe(
      "https://host.test/ocpp/soap/CP%2001%2FA/ChargePointService",
    );
    const segment = /\/([^/]+)\/ChargePointService$/.exec(
      new URL(url).pathname,
    )![1];
    expect(decodeURIComponent(segment)).toBe("CP 01/A");
  });

  it("throws on a non-http(s) base URL", () => {
    expect(() =>
      buildSoapCallbackUrl("ws://host.test", "CP-1", "/ocpp/soap"),
    ).toThrow(/Invalid SOAP public base URL/);
  });
});

describe("resolveSoapCallbackUrl precedence", () => {
  it("uses the explicit callback URL verbatim, ignoring the public base", () => {
    expect(
      resolveSoapCallbackUrl({
        explicitCallbackUrl:
          "http://127.0.0.1:9700/ocpp/soap/CP-1/ChargePointService",
        publicBaseUrl: "https://abcd.ngrok-free.app",
        cpId: "CP-1",
        soapPath: "/ocpp/soap",
      }),
    ).toBe("http://127.0.0.1:9700/ocpp/soap/CP-1/ChargePointService");
  });

  it("derives from the public base when no explicit URL is given", () => {
    expect(
      resolveSoapCallbackUrl({
        explicitCallbackUrl: null,
        publicBaseUrl: "https://abcd.ngrok-free.app",
        cpId: "CP-1",
        soapPath: "/ocpp/soap",
      }),
    ).toBe("https://abcd.ngrok-free.app/ocpp/soap/CP-1/ChargePointService");
  });

  it("returns null when neither source is configured", () => {
    expect(
      resolveSoapCallbackUrl({
        explicitCallbackUrl: null,
        publicBaseUrl: null,
        cpId: "CP-1",
        soapPath: "/ocpp/soap",
      }),
    ).toBeNull();
  });

  it("returns null when a public base is set but the cpId is blank (e.g. daemon mode)", () => {
    expect(
      resolveSoapCallbackUrl({
        publicBaseUrl: "https://abcd.ngrok-free.app",
        cpId: "",
        soapPath: "/ocpp/soap",
      }),
    ).toBeNull();
  });

  it("treats a blank/whitespace explicit URL as absent and falls through", () => {
    expect(
      resolveSoapCallbackUrl({
        explicitCallbackUrl: "   ",
        publicBaseUrl: "https://abcd.ngrok-free.app",
        cpId: "CP-1",
        soapPath: "/ocpp/soap",
      }),
    ).toBe("https://abcd.ngrok-free.app/ocpp/soap/CP-1/ChargePointService");
  });
});
