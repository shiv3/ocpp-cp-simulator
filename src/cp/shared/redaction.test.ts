import { describe, expect, it } from "vitest";

import {
  REDACTED_VALUE,
  redactSensitiveText,
  redactSensitiveValue,
} from "./redaction";

describe("redaction", () => {
  it("redacts OCPP ChangeConfiguration key/value text", () => {
    const redacted = redactSensitiveText(
      '[2,"uid","ChangeConfiguration",{"key":"AuthorizationKey","value":"topsecret"}]',
    );

    expect(redacted).not.toContain("topsecret");
    expect(redacted).toContain("AuthorizationKey");
    expect(redacted).toContain(REDACTED_VALUE);
  });

  it("redacts OCPP ChangeConfiguration unquoted sensitive key/value text", () => {
    const redacted = redactSensitiveText(
      '[2,"id","ChangeConfiguration",{"key":"AuthorizationKey","value":123}]',
    );

    expect(redacted).not.toContain("123");
    expect(redacted).toContain("AuthorizationKey");
    expect(redacted).toContain(`"value":"${REDACTED_VALUE}"`);
  });

  it("does not redact OCPP ChangeConfiguration unquoted non-sensitive key/value text", () => {
    const redacted = redactSensitiveText(
      '[2,"id","ChangeConfiguration",{"key":"HeartbeatInterval","value":30}]',
    );

    expect(redacted).toContain("30");
    expect(redacted).toContain('"value":30');
  });

  it("redacts OCPP GetConfiguration configurationKey entry text", () => {
    const redacted = redactSensitiveText(
      '{"key":"AuthorizationKey","value":"topsecret","readonly":false}',
    );

    expect(redacted).not.toContain("topsecret");
    expect(redacted).toContain("AuthorizationKey");
    expect(redacted).toContain('"readonly":false');
  });

  it("redacts OCPP key/value text with value before key", () => {
    const redacted = redactSensitiveText(
      '{"value":"topsecret","readonly":false,"key":"AuthorizationKey"}',
    );

    expect(redacted).not.toContain("topsecret");
    expect(redacted).toContain("AuthorizationKey");
    expect(redacted).toContain(REDACTED_VALUE);
  });

  it("redacts OCPP configurationKey array entry text", () => {
    const redacted = redactSensitiveText(
      '{"configurationKey":[{"key":"AuthorizationKey","readonly":false,"value":"topsecret"}]}',
    );

    expect(redacted).not.toContain("topsecret");
    expect(redacted).toContain("AuthorizationKey");
    expect(redacted).toContain('"configurationKey"');
  });

  it("redacts parsed OCPP key/value objects without dropping the key", () => {
    expect(
      redactSensitiveValue({
        key: "AuthorizationKey",
        value: "topsecret",
        readonly: false,
      }),
    ).toEqual({
      key: "AuthorizationKey",
      value: REDACTED_VALUE,
      readonly: false,
    });
  });

  it("does not redact non-sensitive OCPP key/value objects", () => {
    expect(
      redactSensitiveValue({
        key: "HeartbeatInterval",
        value: "30",
      }),
    ).toEqual({
      key: "HeartbeatInterval",
      value: "30",
    });
  });
});

describe("URL credentials (#288)", () => {
  it("redacts the password in a ws://user:password@host URL", () => {
    // The config modal documents this form, and a client's error message
    // quotes the connection URL -- which #288 made loggable.
    const redacted = redactSensitiveText(
      "WebSocket connection to 'ws://CP001:s3cr3t@csms.example/ocpp/' failed: Expected 101 status code",
    );

    expect(redacted).not.toContain("s3cr3t");
    // The username is the charge point id; keeping it is the diagnosis.
    expect(redacted).toContain("CP001");
    expect(redacted).toContain("csms.example/ocpp/");
  });

  it("redacts it for wss:// and https:// alike", () => {
    for (const scheme of ["wss", "https", "http"]) {
      expect(
        redactSensitiveText(`${scheme}://user:hunter2@host/path`),
      ).not.toContain("hunter2");
    }
  });

  it("redacts a credential carried as a query parameter", () => {
    // The browser cannot set an Authorization header, so the Basic password
    // travels as ?ocpp_ws_secret= there.
    const redacted = redactSensitiveText(
      "WebSocket connection to 'wss://csms.example/ocpp/CP001?ocpp_ws_secret=hunter2' failed",
    );

    expect(redacted).not.toContain("hunter2");
    expect(redacted).toContain("ocpp_ws_secret=");
    expect(redacted).toContain("csms.example/ocpp/CP001");
  });

  it("redacts the other names a CSMS may expect for the same job", () => {
    for (const name of [
      "token",
      "access_token",
      "api_key",
      "apikey",
      "secret",
      "password",
    ]) {
      expect(
        redactSensitiveText(`wss://host/ocpp?x=1&${name}=hunter2&y=2`),
      ).not.toContain("hunter2");
    }
  });

  it("leaves a non-secret query parameter alone", () => {
    const url = "wss://csms.example/ocpp/CP001?tenant=acme&region=eu";
    expect(redactSensitiveText(url)).toBe(url);
  });

  it("leaves a credential-free URL alone", () => {
    const url = "ws://csms.example:8080/ocpp/CP001";
    expect(redactSensitiveText(url)).toBe(url);
  });

  it("does not mangle a bare host:port", () => {
    const text = "listening on 127.0.0.1:9700";
    expect(redactSensitiveText(text)).toBe(text);
  });
});
