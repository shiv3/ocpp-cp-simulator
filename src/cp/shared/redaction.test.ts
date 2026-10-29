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

  it("redacts a password when the username is empty", () => {
    // `wss://:secret@host` is what the URL serializer produces for Basic auth
    // with an empty username, and it is a valid URL.
    expect(
      redactSensitiveText("wss://:s3cr3t@csms.example/ocpp/"),
    ).not.toContain("s3cr3t");
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

describe("OCPP 2.0.1 SetVariables secrets (#396)", () => {
  const setVariables = (name: string, attributeValue: string) => ({
    setVariableData: [
      {
        component: { name: "SecurityCtrlr" },
        variable: { name },
        attributeValue,
      },
    ],
  });

  it("redacts the attributeValue of BasicAuthPassword and AuthorizationKey", () => {
    for (const name of ["BasicAuthPassword", "AuthorizationKey"]) {
      expect(redactSensitiveValue(setVariables(name, "s3cret"))).toEqual(
        setVariables(name, REDACTED_VALUE),
      );
    }
  });

  it("leaves other variables alone", () => {
    const payload = setVariables("HeartbeatInterval", "60");
    expect(redactSensitiveValue(payload)).toEqual(payload);
  });
});

describe("OCPP 2.0.1 SetVariables secrets in logged frames (#400)", () => {
  // The WebSocket layer logs every inbound frame as `Received: ${raw}`, and
  // the Logger only runs the text redactor over it.
  const setVariablesPayload = (name: string, attributeValue: string) => ({
    setVariableData: [
      {
        component: { name: "SecurityCtrlr" },
        variable: { name },
        attributeValue,
      },
    ],
  });
  const frame = (name: string, attributeValue: string) =>
    `Received: [2,"m1","SetVariables",${JSON.stringify(setVariablesPayload(name, attributeValue))}]`;

  it("redacts the attributeValue of BasicAuthPassword and AuthorizationKey", () => {
    for (const name of ["BasicAuthPassword", "AuthorizationKey"]) {
      expect(redactSensitiveText(frame(name, "s3cretPW"))).toBe(
        frame(name, REDACTED_VALUE),
      );
    }
  });

  it("redacts it whatever the field order and whitespace", () => {
    const redacted = redactSensitiveText(
      '{ "attributeValue" : "s3cretPW", "component": {"name":"SecurityCtrlr"}, "variable" : { "instance": "x", "name" : "BasicAuthPassword" } }',
    );

    expect(redacted).not.toContain("s3cretPW");
    expect(redacted).toContain(`"attributeValue" : "${REDACTED_VALUE}"`);
    expect(redacted).toContain('"name" : "BasicAuthPassword"');
  });

  it("redacts every sensitive entry of a multi-variable frame and only those", () => {
    const redacted = redactSensitiveText(
      JSON.stringify({
        setVariableData: [
          { variable: { name: "HeartbeatInterval" }, attributeValue: "60" },
          { variable: { name: "BasicAuthPassword" }, attributeValue: "pw1" },
          { variable: { name: "AuthorizationKey" }, attributeValue: "key2" },
        ],
      }),
    );

    expect(redacted).not.toContain("pw1");
    expect(redacted).not.toContain("key2");
    expect(redacted).toContain('"attributeValue":"60"');
  });

  it("leaves a SetVariables of another variable untouched", () => {
    const text = frame("HeartbeatInterval", "60");
    expect(redactSensitiveText(text)).toBe(text);
  });

  it("agrees with the structured redactor on the same payload", () => {
    for (const name of ["BasicAuthPassword", "AuthorizationKey", "Other"]) {
      const payload = setVariablesPayload(name, "s3cretPW");
      expect(JSON.parse(redactSensitiveText(JSON.stringify(payload)))).toEqual(
        redactSensitiveValue(payload),
      );
    }
  });
});

describe("vehicle catalog API keys (#458)", () => {
  it("redacts a bearer token", () => {
    expect(redactSensitiveText("Authorization: Bearer abc.def-123")).toBe(
      `Authorization: Bearer ${REDACTED_VALUE}`,
    );
  });

  it("redacts apiKey assignments and drops apiKey object fields", () => {
    expect(redactSensitiveText('{"apiKey":"s3cret"}')).toBe(
      `{"apiKey":"${REDACTED_VALUE}"}`,
    );
    expect(redactSensitiveText("api_key=s3cret")).toBe(
      `api_key=${REDACTED_VALUE}`,
    );
    // Like every other sensitive key name, the field is dropped.
    expect(redactSensitiveValue({ apiKey: "s3cret", name: "x" })).toEqual({
      name: "x",
    });
  });
});
