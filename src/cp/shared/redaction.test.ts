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

  // Text-redactor rule: a quoted value ends at its first unescaped closing
  // quote on the same line, else at the end of that line; only a PEM
  // (`-----BEGIN`) value may span lines, up to its closing quote, else to the
  // end of the text.
  it.each([
    [
      "an escaped double quote",
      String.raw`{"apn":{"apnPassword":"ab\"SECRET1","apn":"x"}}`,
      ["SECRET1"],
      ['"apn":"x"'],
    ],
    [
      "an escaped quote and a trailing escaped backslash",
      String.raw`{"password":"ab\"SECRET1\\","user":"u"}`,
      ["SECRET1"],
      ['"user":"u"'],
    ],
    [
      "single quotes with an escaped quote",
      String.raw`password='ab\'SECRET1' user=u`,
      ["SECRET1"],
      [" user=u"],
    ],
    [
      "an unterminated value",
      'Received: password="SECRET1',
      ["SECRET1"],
      ["Received: password="],
    ],
    [
      "an unterminated value with an escaped quote",
      String.raw`Received: {"password":"SECRET1\"SECRET2`,
      ["SECRET1", "SECRET2"],
      ["Received: "],
    ],
    [
      "an unterminated value ending in a backslash",
      'Received: password="SECRET1\\',
      ["SECRET1"],
      ["Received: "],
    ],
    [
      "an unterminated value followed by another line",
      'password="SECRET1\nnext line',
      ["SECRET1"],
      ["\nnext line"],
    ],
    [
      "an unterminated value followed by another assignment",
      'password="a\nprivateKey="SECRET1"',
      ["SECRET1"],
      ["\nprivateKey="],
    ],
    [
      "a backslash before the line end",
      'password="SECRET1\\\nuser=u',
      ["SECRET1"],
      ["\nuser=u"],
    ],
    [
      "two assignments on one line",
      'password="SECRET1" x privateKey="SECRET2"',
      ["SECRET1", "SECRET2"],
      [" x privateKey="],
    ],
    [
      "two assignments on separate lines",
      'password="SECRET1"\nx\nprivateKey="SECRET2" y',
      ["SECRET1", "SECRET2"],
      ["\nx\nprivateKey=", " y"],
    ],
    [
      "a closed multi-line PEM",
      'privateKey="-----BEGIN PRIVATE KEY-----\nSECRET1\n-----END PRIVATE KEY-----" next=1',
      ["SECRET1", "BEGIN", "END"],
      [" next=1"],
    ],
    [
      "an unterminated multi-line PEM",
      'privateKey="-----BEGIN PRIVATE KEY-----\nSECRET1\nSECRET2',
      ["SECRET1", "SECRET2"],
      ["privateKey="],
    ],
    [
      "a JSON number",
      '{"simPin":9731,"apn":"x"}',
      ["9731"],
      [`"simPin":"${REDACTED_VALUE}"`, '"apn":"x"'],
    ],
    [
      "bare assignments",
      "simPin=9731 api_key=SECRET1 tail",
      ["9731", "SECRET1"],
      [`simPin=${REDACTED_VALUE} api_key=${REDACTED_VALUE} tail`],
    ],
  ])("text redactor: %s", (_case, text, absent, kept) => {
    const redacted = redactSensitiveText(text);
    for (const secret of absent) expect(redacted).not.toContain(secret);
    for (const value of kept) expect(redacted).toContain(value);
    expect(redacted).toContain(REDACTED_VALUE);
  });

  // Exact outputs of the quoted-value rule, across lines included (#519).
  it.each([
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
    [
      'first {"password":"ab\\"cd\nsecond line',
      `first {"password":"${REDACTED_VALUE}"\nsecond line`,
    ],
    [
      'privateKey="-----BEGIN PRIVATE KEY-----\nMIIBsecret\n-----END PRIVATE KEY-----" next=1',
      `privateKey="${REDACTED_VALUE}" next=1`,
    ],
    [
      'privateKey="\n-----BEGIN PRIVATE KEY-----\nMIIBsecret\n-----END PRIVATE KEY-----\n" next=1',
      `privateKey="${REDACTED_VALUE}" next=1`,
    ],
    [
      'privateKey="-----BEGIN PRIVATE KEY-----\nMIIBsecret\n-----END',
      `privateKey="${REDACTED_VALUE}"`,
    ],
    [
      'password="a" x privateKey="b"',
      `password="${REDACTED_VALUE}" x privateKey="${REDACTED_VALUE}"`,
    ],
    [
      'password="a"\nx\nprivateKey="b" y',
      `password="${REDACTED_VALUE}"\nx\nprivateKey="${REDACTED_VALUE}" y`,
    ],
    // #519: a backslash line continuation and a raw newline stay inside the
    // value up to its closing quote.
    ['password="ab\\\ncd" user=u', `password="${REDACTED_VALUE}" user=u`],
    ['password="line1\nline2" x', `password="${REDACTED_VALUE}" x`],
    [
      "simPin=9731 api_key=s3cret",
      `simPin=${REDACTED_VALUE} api_key=${REDACTED_VALUE}`,
    ],
  ])("text redactor output of %j", (text, expected) => {
    expect(redactSensitiveText(text)).toBe(expected);
  });

  // #519: a quoted value may span lines, but only up to a closing quote that
  // is followed by a delimiter and does not open a value (`name="`); a PEM
  // only up to a quote after its `-----END …-----` marker. Each row names
  // the secrets that must be gone and the exact output, over-redaction
  // (fail closed) included.
  const R = REDACTED_VALUE;
  it.each<[string, string, string[], string]>([
    [
      "an escaped quote",
      String.raw`password="ab\"SECRET1" x`,
      ["SECRET1"],
      `password="${R}" x`,
    ],
    [
      "an unterminated value",
      'Received: password="SECRET1',
      ["SECRET1"],
      `Received: password="${R}"`,
    ],
    [
      "an unterminated value with an escaped quote",
      String.raw`password="ab\"SECRET1`,
      ["SECRET1"],
      `password="${R}"`,
    ],
    [
      "an unterminated value with a backslash before the line end",
      'password="SECRET1\\\nuser=u',
      ["SECRET1"],
      `password="${R}"\nuser=u`,
    ],
    [
      "a raw newline inside the value",
      'password="line1\nSECRET1" x',
      ["line1", "SECRET1"],
      `password="${R}" x`,
    ],
    [
      "a backslash line continuation",
      'password="ab\\\nSECRET1" user=u',
      ["SECRET1"],
      `password="${R}" user=u`,
    ],
    [
      "a PEM whose END marker is not followed by a quote",
      'privateKey="-----BEGIN PRIVATE KEY-----\nMIIBsecret\n-----END PRIVATE KEY----- user="u" password=leak',
      ["MIIBsecret", "leak"],
      `privateKey="${R}"`,
    ],
    [
      "an unterminated PEM followed by a quoted assignment",
      'privateKey="-----BEGIN KEY\nAAA\nnext=1 x="y" tail=SECRET1',
      ["AAA", "SECRET1"],
      `privateKey="${R}"`,
    ],
    [
      "a closed multi-line PEM",
      'privateKey="-----BEGIN K-----\nSECRET1\n-----END K-----" next=1',
      ["SECRET1"],
      `privateKey="${R}" next=1`,
    ],
    [
      "a closed multi-line PEM after a leading newline",
      'privateKey="\n-----BEGIN K-----\nSECRET1\n-----END K-----\n" next=1',
      ["SECRET1"],
      `privateKey="${R}" next=1`,
    ],
    [
      "an unterminated multi-line PEM",
      'privateKey="-----BEGIN K-----\nSECRET1\nSECRET2',
      ["SECRET1", "SECRET2"],
      `privateKey="${R}"`,
    ],
    [
      "an unterminated multi-line PEM after a leading newline",
      'privateKey="\n-----BEGIN K-----\nSECRET1',
      ["SECRET1"],
      `privateKey="${R}"`,
    ],
    [
      "a PEM with a quote inside its body",
      'privateKey="-----BEGIN K-----\nAB"SECRET1\n-----END K-----" next=1',
      ["SECRET1"],
      `privateKey="${R}" next=1`,
    ],
    [
      "a single-line PEM without an END marker (fail closed)",
      'privateKey="-----BEGIN SECRET1" y',
      ["SECRET1"],
      `privateKey="${R}"`,
    ],
    [
      "a PEM with escaped newlines in a truncated JSON frame",
      String.raw`Received: {"privateKey":"-----BEGIN K-----\nSECRET1\n-----END K-----\n","user":"u"`,
      ["SECRET1"],
      `Received: {"privateKey":"${R}","user":"u"`,
    ],
    [
      "two assignments on one line",
      'password="SECRET1" x privateKey="SECRET2"',
      ["SECRET1", "SECRET2"],
      `password="${R}" x privateKey="${R}"`,
    ],
    [
      "an unterminated value followed by a secret on the next line",
      'password="a\nprivateKey="SECRET1"',
      ["SECRET1"],
      `password="${R}"\nprivateKey="${R}"`,
    ],
    [
      "a next-line secret starting with a space",
      'password="a\nprivateKey=" SECRET1"',
      ["SECRET1"],
      `password="${R}"\nprivateKey="${R}"`,
    ],
    [
      "a next-line secret starting with a comma",
      'password="a\nprivateKey=",SECRET1"',
      ["SECRET1"],
      `password="${R}"\nprivateKey="${R}"`,
    ],
    [
      "a later-line secret in the other quote holding the closing quote",
      "password=\"a\nprivateKey='S1 x\" y S2'",
      ["S1", "S2"],
      `password="${R}"\nprivateKey='${R}'`,
    ],
    [
      "a later-line secret in double quotes holding the closing quote",
      "password='a\nprivateKey=\"S1 x' y S2\"",
      ["S1", "S2"],
      `password='${R}'\nprivateKey="${R}"`,
    ],
    [
      "a later-line bare secret before the closing quote",
      'password="a\napi_key=S1 x" y',
      ["S1"],
      `password="${R}"\napi_key=${R} x" y`,
    ],
    [
      "a later-line non-secret name before the closing quote (fail closed)",
      'password="a\ntoken=S1 x" y',
      ["S1"],
      `password="${R}" y`,
    ],
    [
      "a secret two lines down before the closing quote",
      'password="a\nfoo\nprivateKey="S1" z" w',
      ["S1"],
      `password="${R}"\nfoo\nprivateKey="${R}" z" w`,
    ],
    [
      "a PEM body holding a later assignment and an END marker (fail closed)",
      "privateKey=\"-----BEGIN K-----\nA\npassword='-----END K-----\" S1'",
      ["S1"],
      `privateKey="${R}"`,
    ],
    [
      "a single-quoted PEM without END inside a JSON string (fail closed)",
      `{"msg":"privateKey='-----BEGIN K-----\\nA'","n":1}`,
      ["\\nA"],
      `{"msg":"privateKey='${R}'`,
    ],
    [
      "an unterminated value followed by a quoted assignment",
      'password="a\nuser="bob" x',
      ["a\n"],
      `password="${R}"\nuser="bob" x`,
    ],
    [
      "an unterminated value followed by a line ending in a quote (fail closed)",
      'password="a\nuser=bob" x',
      ["bob"],
      `password="${R}" x`,
    ],
    [
      "single quotes spanning a line with double quotes (fail closed)",
      "password='a\nuser=\"bob\" x'",
      ["bob"],
      `password='${R}'`,
    ],
    [
      "single quotes with an escaped quote",
      String.raw`password='ab\'SECRET1' user=u`,
      ["SECRET1"],
      `password='${R}' user=u`,
    ],
    [
      "a JSON number",
      '{"simPin":9731,"apn":"x"}',
      ["9731"],
      `{"simPin":"${R}","apn":"x"}`,
    ],
    [
      "a bare assignment",
      "api_key=SECRET1 tail",
      ["SECRET1"],
      `api_key=${R} tail`,
    ],
    [
      "duplicate JSON keys",
      '{"password":"decoy","password":"SECRET1"}',
      ["decoy", "SECRET1"],
      `{"password":"${R}","password":"${R}"}`,
    ],
    [
      "a multi-line value followed by a comma",
      'password="a\nSECRET1",user=u',
      ["SECRET1"],
      `password="${R}",user=u`,
    ],
    [
      "a multi-line value followed by a closing brace",
      'x {password="a\nSECRET1"} y',
      ["SECRET1"],
      `x {password="${R}"} y`,
    ],
  ])("text redactor across lines: %s", (_case, text, absent, expected) => {
    const redacted = redactSensitiveText(text);
    for (const secret of absent) expect(redacted).not.toContain(secret);
    expect(redacted).toBe(expected);
  });

  it("keeps a redacted JSON frame valid JSON", () => {
    for (const payload of [{ apnPassword: 'ab"cd', n: 1 }, { simPin: 9731 }]) {
      expect(() =>
        JSON.parse(redactSensitiveText(JSON.stringify(payload))),
      ).not.toThrow();
    }
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

describe("text redactor parity with the structured redactor (#515)", () => {
  const R = REDACTED_VALUE;

  // Field names match as in `isSensitiveKeyName`: case, `-` and `_` ignored.
  it.each([
    [
      'Received: [2,"m1","X",{"Password":"x"}]',
      `Received: [2,"m1","X",{"Password":"${R}"}]`,
    ],
    ['{"tls_key":"x","n":1}', `{"tls_key":"${R}","n":1}`],
    ['{"TLS-KEY":7}', `{"TLS-KEY":"${R}"}`],
    ["authorization_key=x tail", `authorization_key=${R} tail`],
    ["Authorization-Key: x", `Authorization-Key: ${R}`],
    ["PASSWORD=x", `PASSWORD=${R}`],
    ["_api_key=x", `_api_key=${R}`],
    ['Password="x" n=1', `Password="${R}" n=1`],
  ])("redacts the name variant in %j", (text, expected) => {
    expect(redactSensitiveText(text)).toBe(expected);
  });

  // A name ending in a secret name is one too, as the spelling list matched
  // it as a suffix: `api_password` and `OED_API_KEY` are this project's own.
  it.each([
    ["api_password=x", `api_password=${R}`],
    ["OED_API_KEY=x", `OED_API_KEY=${R}`],
    ["tlsPrivateKey=x", `tlsPrivateKey=${R}`],
    ["x_password=x", `x_password=${R}`],
    ["myPassword=x", `myPassword=${R}`],
    ["x-api-key: x", `x-api-key: ${R}`],
    ['{"newPassword":"x"}', `{"newPassword":"${R}"}`],
    ['{"oedApiKey":{"a":1},"n":1}', `{"oedApiKey":"${R}","n":1}`],
    // A truncated frame: no closing brace, so the regex does it, quoted.
    ['Received: {"api_password":9731', `Received: {"api_password":"${R}"`],
  ])("redacts the longer name in %j", (text, expected) => {
    expect(redactSensitiveText(text)).toBe(expected);
  });

  it.each(["passwordHint=x", '{"passwordHint":"x"}', '{"apiKeyId":7}'])(
    "leaves %j readable",
    (text) => {
      expect(redactSensitiveText(text)).toBe(text);
    },
  );

  // A long `-` / `_` run made the unanchored name pattern backtrack from
  // every position: about a minute for 200k characters of a CSMS frame.
  it("stays linear on a long separator run", { timeout: 2000 }, () => {
    for (const text of [
      "_".repeat(200_000),
      `password${"_".repeat(200_000)}`,
    ]) {
      expect(redactSensitiveText(text)).toBe(text);
    }
  });

  // #519: the quoted-value and PEM patterns scan across lines; none of them
  // may backtrack quadratically on a long run.
  it("stays linear on long runs after a quoted name", { timeout: 2000 }, () => {
    const runs = ["_", "-", '"', " ", "\\", "\n"].map((char) =>
      char.repeat(200_000),
    );
    const pemBody = "A".repeat(200_000);
    const texts = [
      ...runs,
      ...runs.map((run) => `password=${run}`),
      ...runs.map((run) => `password="${run}`),
      `password="${"a\n".repeat(100_000)}`,
      'password="a\n'.repeat(20_000),
      `password="${"\nx".repeat(100_000)}`,
      `password="a\n${"passwor".repeat(30_000)}`,
      `privateKey="-----BEGIN K-----\n${"passwor".repeat(30_000)}`,
      `privateKey="-----BEGIN K-----\n${pemBody}`,
      `privateKey="-----BEGIN K-----\n${'a"'.repeat(100_000)}`,
      `privateKey="-----BEGIN K-----\n${"-----END K----- ".repeat(12_500)}`,
    ];
    for (const text of texts) {
      expect(typeof redactSensitiveText(text)).toBe("string");
    }
    expect(redactSensitiveText(texts.at(-3) ?? "")).toBe(
      `privateKey="${REDACTED_VALUE}"`,
    );
  });

  it("keeps a longer name in the structured redactor", () => {
    // The text redactor is stricter here: the structured one drops a field
    // only under an exact key name.
    expect(redactSensitiveValue({ newPassword: "x" })).toEqual({
      newPassword: "x",
    });
  });

  it("still finds an assignment inside a non-secret quoted value", () => {
    expect(redactSensitiveText('msg="see password=s3cret here"')).toBe(
      `msg="see password=${R} here"`,
    );
  });

  // The whole value of a secret-named member is replaced, so the frame stays
  // JSON for the trace adapter.
  it.each([
    ['{"password":{"a":"b"}}', `{"password":"${R}"}`],
    ['{"password":["a"]}', `{"password":"${R}"}`],
    ['{"password":{"apnPassword":"x"},"n":1}', `{"password":"${R}","n":1}`],
    ['{"privateKey":[{"tlsKey":"y"}],"n":1}', `{"privateKey":"${R}","n":1}`],
    [
      '{"key":"AuthorizationKey","value":{"password":"x"}}',
      `{"key":"AuthorizationKey","value":"${R}"}`,
    ],
    ['{"vpn":{"key":{"password":"x"}}}', `{"vpn":{"key":"${R}"}}`],
    [
      'Received: [2,"m1","X",{"Password":{"a":"b"},"n":[1]}]',
      `Received: [2,"m1","X",{"Password":"${R}","n":[1]}]`,
    ],
  ])("redacts the object or array value of %j", (text, expected) => {
    const redacted = redactSensitiveText(text);
    expect(redacted).toBe(expected);
    const json = redacted.replace(/^Received: /, "");
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
