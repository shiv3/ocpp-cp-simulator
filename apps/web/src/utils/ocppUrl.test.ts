import { describe, expect, it } from "vitest";

import { buildFullOcppUrl, parseFullOcppUrl } from "./ocppUrl";

describe("buildFullOcppUrl", () => {
  it("returns the plain URL when basic auth is disabled", () => {
    expect(
      buildFullOcppUrl("wss://csms.example.com/ocpp/", {
        enabled: false,
        username: "ignored",
        password: "ignored",
      }),
    ).toBe("wss://csms.example.com/ocpp/");
  });

  it("embeds userinfo when basic auth is enabled", () => {
    expect(
      buildFullOcppUrl("wss://csms.example.com/ocpp/", {
        enabled: true,
        username: "CP001",
        password: "secret",
      }),
    ).toBe("wss://CP001:secret@csms.example.com/ocpp/");
  });

  it("strips existing userinfo when basic auth is disabled", () => {
    expect(
      buildFullOcppUrl("wss://stale:creds@csms.example.com/ocpp/", {
        enabled: false,
        username: "",
        password: "",
      }),
    ).toBe("wss://csms.example.com/ocpp/");
  });

  it("percent-encodes special characters in username/password", () => {
    const url = buildFullOcppUrl("wss://csms.example.com/ocpp/", {
      enabled: true,
      username: "user@domain",
      password: "p@ss/word",
    });
    const parsed = new URL(url);
    expect(decodeURIComponent(parsed.username)).toBe("user@domain");
    expect(decodeURIComponent(parsed.password)).toBe("p@ss/word");
  });

  it("returns empty string when wsURL is blank", () => {
    expect(
      buildFullOcppUrl("   ", {
        enabled: true,
        username: "u",
        password: "p",
      }),
    ).toBe("");
  });

  it("returns the raw text when the URL is malformed", () => {
    expect(
      buildFullOcppUrl("not-a-url", {
        enabled: false,
        username: "",
        password: "",
      }),
    ).toBe("not-a-url");
  });
});

describe("parseFullOcppUrl", () => {
  it("extracts userinfo into basic auth fields", () => {
    expect(
      parseFullOcppUrl("wss://CP001:secret@csms.example.com/ocpp/"),
    ).toEqual({
      wsURL: "wss://csms.example.com/ocpp/",
      basicAuthEnabled: true,
      basicAuthUsername: "CP001",
      basicAuthPassword: "secret",
    });
  });

  it("decodes percent-encoded userinfo", () => {
    expect(
      parseFullOcppUrl(
        "wss://user%40domain:p%40ss%2Fword@csms.example.com/ocpp/",
      ),
    ).toEqual({
      wsURL: "wss://csms.example.com/ocpp/",
      basicAuthEnabled: true,
      basicAuthUsername: "user@domain",
      basicAuthPassword: "p@ss/word",
    });
  });

  it("returns disabled basic auth when no userinfo is present", () => {
    expect(parseFullOcppUrl("wss://csms.example.com/ocpp/")).toEqual({
      wsURL: "wss://csms.example.com/ocpp/",
      basicAuthEnabled: false,
      basicAuthUsername: "",
      basicAuthPassword: "",
    });
  });

  it("accepts ws:// in addition to wss://", () => {
    const parsed = parseFullOcppUrl("ws://localhost:8080/ocpp");
    expect(parsed?.wsURL).toBe("ws://localhost:8080/ocpp");
  });

  it("rejects non-WebSocket schemes", () => {
    expect(parseFullOcppUrl("https://csms.example.com/")).toBeNull();
    expect(parseFullOcppUrl("http://csms.example.com/")).toBeNull();
  });

  it("rejects malformed URLs", () => {
    expect(parseFullOcppUrl("not-a-url")).toBeNull();
    expect(parseFullOcppUrl("")).toBeNull();
    expect(parseFullOcppUrl("   ")).toBeNull();
  });

  it("round-trips with buildFullOcppUrl", () => {
    const original = "wss://CP001:secret@csms.example.com/ocpp/";
    const parsed = parseFullOcppUrl(original);
    expect(parsed).not.toBeNull();
    const rebuilt = buildFullOcppUrl(parsed!.wsURL, {
      enabled: parsed!.basicAuthEnabled,
      username: parsed!.basicAuthUsername,
      password: parsed!.basicAuthPassword,
    });
    expect(rebuilt).toBe(original);
  });
});
