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
