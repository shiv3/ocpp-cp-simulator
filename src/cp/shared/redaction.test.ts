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

describe("duplicate JSON keys in logged frames (#400 review)", () => {
  // JSON.parse keeps the last duplicate, so the station uses the value the
  // first-match lookup used to leave in clear.
  it.each([
    [
      "a second value",
      '{"key":"AuthorizationKey","value":"x","value":"S3CRET"}',
    ],
    [
      "a second key",
      '{"key":"HeartbeatInterval","key":"AuthorizationKey","value":"S3CRET"}',
    ],
    [
      "a second variable",
      '{"variable":{"name":"Foo"},"variable":{"name":"BasicAuthPassword"},"attributeValue":"S3CRET"}',
    ],
    [
      "a second variable name",
      '{"variable":{"name":"Foo","name":"BasicAuthPassword"},"attributeValue":"S3CRET"}',
    ],
    [
      "a second attributeValue",
      '{"variable":{"name":"BasicAuthPassword"},"attributeValue":"a","attributeValue":"S3CRET"}',
    ],
  ])("redacts the secret behind %s", (_case, text) => {
    const redacted = redactSensitiveText(text);
    expect(redacted).not.toContain("S3CRET");
    expect(redacted).toContain(REDACTED_VALUE);
  });
});

describe("OCPP 2.0.1 SetNetworkProfile secrets (#401)", () => {
  const setNetworkProfile = () => ({
    configurationSlot: 1,
    connectionData: {
      ocppVersion: "OCPP20",
      ocppTransport: "JSON",
      ocppCsmsUrl: "wss://csms.example/ocpp",
      messageTimeout: 30,
      securityProfile: 1,
      ocppInterface: "Wireless0",
      apn: {
        apn: "internet.example",
        apnUserName: "apnUSER",
        apnPassword: "apnSECRET",
        apnAuthentication: "PAP",
      },
      vpn: {
        server: "vpn.example",
        user: "vpnUSER",
        group: "vpnGROUP",
        password: "vpnPASSWORD",
        key: "vpnSHAREDKEY",
        type: "IPSec",
      },
    },
  });
  const secrets = ["apnSECRET", "vpnPASSWORD", "vpnSHAREDKEY"];
  const readable = ["apnUSER", "vpn.example", "vpnUSER", "vpnGROUP"];

  it("removes the APN password and the VPN key from a parsed payload", () => {
    const redacted = redactSensitiveValue(setNetworkProfile()) as ReturnType<
      typeof setNetworkProfile
    >;
    const serialized = JSON.stringify(redacted);

    for (const secret of secrets) expect(serialized).not.toContain(secret);
    // A context-dependent secret is replaced, like the 1.6 `value`; a
    // sensitive key name (apnPassword, password) is dropped.
    expect(redacted.connectionData.vpn.key).toBe(REDACTED_VALUE);
    expect(redacted.connectionData.apn).not.toHaveProperty("apnPassword");
    expect(redacted.connectionData.apn.apnUserName).toBe("apnUSER");
    expect(redacted.connectionData.vpn.server).toBe("vpn.example");
    expect(redacted.connectionData.vpn.user).toBe("vpnUSER");
  });

  it("redacts both in the Received: log line of the frame", () => {
    const redacted = redactSensitiveText(
      `Received: [2,"m1","SetNetworkProfile",${JSON.stringify(setNetworkProfile())}]`,
    );

    for (const secret of secrets) expect(redacted).not.toContain(secret);
    for (const value of readable) expect(redacted).toContain(value);
    expect(redacted).toContain(`"apnPassword":"${REDACTED_VALUE}"`);
    expect(redacted).toContain(`"key":"${REDACTED_VALUE}"`);
  });

  it("redacts the VPN key whatever the field order and whitespace", () => {
    const redacted = redactSensitiveText(
      '{ "vpn" : { "key" : "vpnSHAREDKEY", "server": "vpn.example" } }',
    );

    expect(redacted).toBe(
      `{ "vpn" : { "key" : "${REDACTED_VALUE}", "server": "vpn.example" } }`,
    );
  });

  describe("OCPP 2.1 connectionData.basicAuthPassword", () => {
    const setNetworkProfile21 = () => {
      const payload = setNetworkProfile();
      return {
        ...payload,
        connectionData: {
          ...payload.connectionData,
          identity: "CP001",
          basicAuthPassword: "basicSECRET",
        },
      };
    };
    const secrets21 = [...secrets, "basicSECRET"];

    it("removes it with the APN password and the VPN key", () => {
      const redacted = redactSensitiveValue(
        setNetworkProfile21(),
      ) as ReturnType<typeof setNetworkProfile21>;
      const serialized = JSON.stringify(redacted);

      for (const secret of secrets21) expect(serialized).not.toContain(secret);
      expect(redacted.connectionData).not.toHaveProperty("basicAuthPassword");
      expect(redacted.connectionData.vpn.key).toBe(REDACTED_VALUE);
      expect(redacted.connectionData.identity).toBe("CP001");
      expect(redacted.connectionData.apn.apnUserName).toBe("apnUSER");
      expect(redacted.connectionData.vpn.server).toBe("vpn.example");
      expect(redacted.connectionData.vpn.user).toBe("vpnUSER");
    });

    it("redacts it in the Received: log line of the frame", () => {
      const redacted = redactSensitiveText(
        `Received: [2,"m1","SetNetworkProfile",${JSON.stringify(setNetworkProfile21())}]`,
      );

      for (const secret of secrets21) expect(redacted).not.toContain(secret);
      for (const value of [...readable, "CP001"]) {
        expect(redacted).toContain(value);
      }
      expect(redacted).toContain(`"basicAuthPassword":"${REDACTED_VALUE}"`);
    });
  });

  it("redacts the numeric SIM PIN in both redactors", () => {
    const payload = setNetworkProfile();
    const withPin = {
      ...payload,
      connectionData: {
        ...payload.connectionData,
        apn: { ...payload.connectionData.apn, simPin: 9731 },
      },
    };

    const structured = redactSensitiveValue(withPin) as typeof withPin;
    expect(JSON.stringify(structured)).not.toContain("9731");
    expect(structured.connectionData.apn).not.toHaveProperty("simPin");
    expect(structured.connectionData.apn.apnUserName).toBe("apnUSER");

    const text = redactSensitiveText(
      `Received: [2,"m1","SetNetworkProfile",${JSON.stringify(withPin)}]`,
    );
    expect(text).not.toContain("9731");
    // Quoted, so the frame stays JSON: the trace adapter parses it.
    expect(text).toContain(`"simPin":"${REDACTED_VALUE}"`);
    expect(text).toContain("apnUSER");
    expect(() =>
      JSON.parse(redactSensitiveText(JSON.stringify(withPin))),
    ).not.toThrow();
  });

  it("redacts a quoted secret past an escaped quote", () => {
    // A lazy `(.*?)` stopped at the escaped quote and logged the suffix.
    for (const [text, expected] of [
      [
        String.raw`{"apn":{"apnPassword":"ab\"cd","apn":"x"}}`,
        `{"apn":{"apnPassword":"${REDACTED_VALUE}","apn":"x"}}`,
      ],
      [
        String.raw`{"password":"ab\"cd\\","user":"u"}`,
        `{"password":"${REDACTED_VALUE}","user":"u"}`,
      ],
      [
        String.raw`password='ab\'cd' user=u`,
        `password='${REDACTED_VALUE}' user=u`,
      ],
    ]) {
      const redacted = redactSensitiveText(text);
      expect(redacted).not.toContain("cd");
      expect(redacted).toBe(expected);
    }
    expect(
      JSON.parse(
        redactSensitiveText(JSON.stringify({ apnPassword: 'ab"cd', n: 1 })),
      ),
    ).toEqual({ apnPassword: REDACTED_VALUE, n: 1 });
  });

  it("fails closed on a quoted secret that is never closed", () => {
    // A truncated log line: without a closing quote the value runs to the
    // end of the text, and the whole of it is redacted.
    for (const text of [
      String.raw`Received: {"password":"ab\"cd`,
      'Received: password="abcd',
      String.raw`Received: {"apn":{"apnPassword":"ab\"cd`,
      'Received: password="abcd\\',
    ]) {
      const redacted = redactSensitiveText(text);
      expect(redacted).not.toContain("ab");
      expect(redacted).not.toContain("cd");
      expect(redacted).toContain(REDACTED_VALUE);
    }
    // No closing quote anywhere: everything after the opening quote goes.
    expect(redactSensitiveText('first {"password":"ab\\"cd\nsecond line')).toBe(
      `first {"password":"${REDACTED_VALUE}"`,
    );
    // An unterminated multi-line PEM loses every line after the header.
    const pem = redactSensitiveText(
      'privateKey="-----BEGIN PRIVATE KEY-----\nMIIBsecret\n-----END',
    );
    expect(pem).not.toContain("MIIBsecret");
    expect(pem).not.toContain("BEGIN");
  });

  it("redacts a closed quoted secret spanning several lines", () => {
    // A PEM in non-JSON text keeps its raw newlines.
    expect(
      redactSensitiveText(
        'privateKey="-----BEGIN PRIVATE KEY-----\nMIIBsecret\n-----END PRIVATE KEY-----" next=1',
      ),
    ).toBe(`privateKey="${REDACTED_VALUE}" next=1`);
  });

  it("stops each closed quoted secret at its own closing quote", () => {
    expect(redactSensitiveText('password="a" x privateKey="b"')).toBe(
      `password="${REDACTED_VALUE}" x privateKey="${REDACTED_VALUE}"`,
    );
    expect(redactSensitiveText('password="a"\nx\nprivateKey="b" y')).toBe(
      `password="${REDACTED_VALUE}"\nx\nprivateKey="${REDACTED_VALUE}" y`,
    );
  });

  it("consumes a backslash-newline inside a quoted secret", () => {
    const redacted = redactSensitiveText('password="ab\\\ncd" user=u');
    expect(redacted).not.toContain("cd");
    expect(redacted).toBe(`password="${REDACTED_VALUE}" user=u`);
  });

  it("keeps a bare value bare outside a JSON member", () => {
    expect(redactSensitiveText("simPin=9731 api_key=s3cret")).toBe(
      `simPin=${REDACTED_VALUE} api_key=${REDACTED_VALUE}`,
    );
  });

  it("redacts every duplicate vpn and key member, not only the first", () => {
    // JSON.parse keeps the last duplicate, so a first-match redaction would
    // hide a decoy and log the value the station actually uses.
    for (const text of [
      '{"vpn":{"key":"decoyA","key":"vpnSHAREDKEY"}}',
      '{"vpn":{"server":"vpn.example"},"vpn":{"key":"vpnSHAREDKEY"}}',
      '{"apn":{"apnPassword":"decoyA","apnPassword":"apnSECRET"}}',
      '{"basicAuthPassword":"decoyA","basicAuthPassword":"basicSECRET"}',
    ]) {
      const redacted = redactSensitiveText(text);
      for (const secret of [
        "decoyA",
        "vpnSHAREDKEY",
        "apnSECRET",
        "basicSECRET",
      ]) {
        expect(redacted).not.toContain(secret);
      }
    }
  });

  it("leaves a key outside a vpn object readable", () => {
    for (const text of [
      '{"key":"HeartbeatInterval","value":"30"}',
      '{"apn":{"key":"notASecret"}}',
      '{"vpn":"notAnObject","key":"x"}',
    ]) {
      expect(redactSensitiveText(text)).toBe(text);
    }
    expect(redactSensitiveValue({ apn: { key: "notASecret" } })).toEqual({
      apn: { key: "notASecret" },
    });
    expect(redactSensitiveValue({ vpn: "notAnObject", key: "x" })).toEqual({
      vpn: "notAnObject",
      key: "x",
    });
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
