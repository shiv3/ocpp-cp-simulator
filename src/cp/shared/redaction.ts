export const REDACTED_VALUE = "[redacted]";

const SENSITIVE_KEY_NAMES = new Set([
  "apikey",
  // 2.0.1 / 2.1 SetNetworkProfile `connectionData.apn.apnPassword` (#401).
  "apnpassword",
  "authorizationkey",
  // 2.1 SetNetworkProfile `connectionData.basicAuthPassword` (#401), and the
  // 2.0.1 `BasicAuthPassword` variable (#396).
  "basicauthpassword",
  "password",
  "privatekey",
  // 2.0.1 / 2.1 SetNetworkProfile `connectionData.apn.simPin`, an integer
  // (#401).
  "simpin",
  "tlskey",
]);

/** The names the text redactor matches in `name: value` / `name=value`. */
const SENSITIVE_ASSIGNMENT_NAMES =
  "AuthorizationKey|authorizationKey|password|apnPassword|basicAuthPassword|BasicAuthPassword|simPin|privateKey|PrivateKey|tlsKey|TlsKey|apiKey|ApiKey|api_key|API_KEY";
const SENSITIVE_ASSIGNMENT = new RegExp(
  `((?:"?(?:${SENSITIVE_ASSIGNMENT_NAMES})"?)\\s*[:=]\\s*)(["'])(.*?)\\2`,
  "g",
);
const SENSITIVE_BARE_ASSIGNMENT = new RegExp(
  `((?:"?(?:${SENSITIVE_ASSIGNMENT_NAMES})"?)\\s*[:=]\\s*)(?!["'])([^\\s,}\\]]+)`,
  "g",
);

/** #458: an `Authorization: Bearer …` value. */
const BEARER_TOKEN = /(\bBearer\s+)[A-Za-z0-9\-._~+/]+=*/g;

type StringToken = {
  content: string;
  end: number;
  quote: string;
};

type ObjectField = {
  name: string;
  valueStart: number;
  valueEnd: number;
  stringValue?: string;
  quote?: string;
};

type Replacement = {
  start: number;
  end: number;
  value: string;
};

/** `AuthorizationKey`, `authorization_key` and `authorization-key` alike. */
export function normalizeKeyName(key: string): string {
  return key.replace(/[-_]/g, "").toLowerCase();
}

export function isSensitiveKeyName(key: string): boolean {
  return SENSITIVE_KEY_NAMES.has(normalizeKeyName(key));
}

/**
 * OCPP 2.0.1 variables whose `attributeValue` is a secret (#396): the key
 * names above. The structured and the text redactors both use this rule
 * (#400).
 */
function isSensitiveVariableName(name: string): boolean {
  return isSensitiveKeyName(name);
}

function isSensitiveVariable(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const name = (value as { name?: unknown }).name;
  return typeof name === "string" && isSensitiveVariableName(name);
}

/**
 * `scheme://user:password@host` — the form the config modal documents for
 * putting Basic credentials in a WebSocket URL. It is not a named assignment,
 * so the patterns above never saw it, and a client error message that quotes
 * the connection URL would otherwise print the password (#288 made those
 * messages loggable). The username is kept: it is the charge point id in
 * every OCPP use of this form, and losing it would cost the diagnosis.
 */
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*):[^/\s@]*@/gi;

/**
 * Credentials carried as a query parameter. `ocpp_ws_secret` is this
 * project's own — the browser cannot set an `Authorization` header, so the
 * Basic password goes in the URL there (see `wsUrlWithBasic.ts`) — and the
 * rest are the names a CSMS is likely to expect for the same job. Same
 * reason as the userinfo pattern above: a client's error message quotes the
 * whole URL, and #288 made those messages loggable.
 */
const URL_SECRET_QUERY =
  /([?&](?:ocpp_ws_secret|password|passwd|secret|token|access_token|api[-_]?key|auth(?:orization)?[-_]?key)=)([^&#\s"'<>]+)/gi;

export function redactSensitiveText(text: string): string {
  return redactOcppKeyValueText(text)
    .replace(SENSITIVE_ASSIGNMENT, `$1$2${REDACTED_VALUE}$2`)
    .replace(SENSITIVE_BARE_ASSIGNMENT, redactBareValue)
    .replace(URL_USERINFO, `$1:${REDACTED_VALUE}@`)
    .replace(URL_SECRET_QUERY, `$1${REDACTED_VALUE}`)
    .replace(BEARER_TOKEN, `$1${REDACTED_VALUE}`);
}

/**
 * A quoted name is a JSON member (`"simPin":1234`): quote the replacement so
 * the logged frame still parses for the trace adapter (#401). Elsewhere
 * (`api_key=…`) it stays bare.
 */
function redactBareValue(_match: string, prefix: string): string {
  return prefix.startsWith('"')
    ? `${prefix}"${REDACTED_VALUE}"`
    : `${prefix}${REDACTED_VALUE}`;
}

export function redactSensitiveValue(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactSensitiveValue);
  if (!value || typeof value !== "object") return value;

  const entries = Object.entries(value);
  const ocppKeyValueObject = entries.some(
    ([key, nested]) =>
      key === "key" && typeof nested === "string" && isSensitiveKeyName(nested),
  );
  // 2.0.1 SetVariableData: `{ component, variable: { name }, attributeValue }`.
  const sensitiveVariable = isSensitiveVariable(
    (value as { variable?: unknown }).variable,
  );
  const out: Record<string, unknown> = {};
  for (const [key, nested] of entries) {
    if (isSensitiveKeyName(key)) continue;
    if (
      (ocppKeyValueObject && key === "value") ||
      (sensitiveVariable && key === "attributeValue")
    ) {
      out[key] = REDACTED_VALUE;
      continue;
    }
    out[key] = key === "vpn" ? redactVpn(nested) : redactSensitiveValue(nested);
  }
  return out;
}

/**
 * 2.0.1 / 2.1 SetNetworkProfile `connectionData.vpn.key`, the VPN shared
 * secret (#401). `key` is only a secret under `vpn` — elsewhere it is the
 * name of a 1.6 `{ key, value }` configuration entry — so, like the 1.6
 * `value`, it is replaced rather than dropped.
 */
function redactVpn(value: unknown): unknown {
  const redacted = redactSensitiveValue(value);
  if (!isPlainObject(redacted) || !("key" in redacted)) return redacted;
  return { ...redacted, key: REDACTED_VALUE };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Redacts, in serialized text, the value of a 1.6 `{ key, value }` entry
 * whose key is sensitive, the `attributeValue` of a 2.0.1
 * `{ variable: { name }, attributeValue }` entry whose variable is (#400)
 * and the `key` of an object held under `vpn` (#401) — the same shapes
 * `redactSensitiveValue` handles on parsed payloads.
 */
function redactOcppKeyValueText(text: string): string {
  const replacements: Replacement[] = [];
  const objectRanges = findObjectRanges(text);
  const objectEndByStart = new Map(objectRanges);

  for (const [start, end] of objectRanges) {
    const fields = readObjectFields(text, start, end);
    const sensitiveKey = fields.some(
      (field) =>
        field.name === "key" &&
        field.stringValue !== undefined &&
        isSensitiveKeyName(field.stringValue),
    );
    // A duplicate key is not a way around this: JSON.parse keeps the last
    // one, so any `key` / `variable` may decide and every value is redacted.
    if (sensitiveKey) {
      for (const field of fields) {
        if (field.name === "value") replacements.push(redactField(field));
      }
    }

    const sensitiveVariable = fields.some(
      (field) =>
        field.name === "variable" &&
        isSensitiveVariableText(text, field, objectEndByStart),
    );
    if (sensitiveVariable) {
      for (const field of fields) {
        if (field.name === "attributeValue") {
          replacements.push(redactField(field));
        }
      }
    }

    // 2.0.1 / 2.1 SetNetworkProfile `vpn.key` (#401), as in `redactVpn`;
    // every copy of a duplicated `vpn` / `key`, as above.
    for (const vpnField of fields) {
      if (vpnField.name !== "vpn") continue;
      for (const field of nestedObjectFields(
        text,
        vpnField,
        objectEndByStart,
      )) {
        if (field.name === "key") replacements.push(redactField(field));
      }
    }
  }

  return applyReplacements(text, replacements);
}

function redactField(field: ObjectField): Replacement {
  return {
    start: field.valueStart,
    end: field.valueEnd,
    value: field.quote
      ? `${field.quote}${REDACTED_VALUE}${field.quote}`
      : `"${REDACTED_VALUE}"`,
  };
}

/** A `variable` field whose value is an object naming a sensitive variable. */
function isSensitiveVariableText(
  text: string,
  variableField: ObjectField,
  objectEndByStart: Map<number, number>,
): boolean {
  return nestedObjectFields(text, variableField, objectEndByStart).some(
    (field) =>
      field.name === "name" &&
      field.stringValue !== undefined &&
      isSensitiveVariableName(field.stringValue),
  );
}

/** The fields of the object a field holds; none when it holds no object. */
function nestedObjectFields(
  text: string,
  field: ObjectField,
  objectEndByStart: Map<number, number>,
): ObjectField[] {
  const objectEnd = objectEndByStart.get(field.valueStart);
  if (objectEnd === undefined) return [];
  return readObjectFields(text, field.valueStart, objectEnd);
}

function findObjectRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const starts: number[] = [];
  let quote: string | null = null;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "{") {
      starts.push(index);
    } else if (char === "}") {
      const start = starts.pop();
      if (start !== undefined) ranges.push([start, index + 1]);
    }
  }

  return ranges;
}

function readObjectFields(
  text: string,
  objectStart: number,
  objectEnd: number,
): ObjectField[] {
  const fields: ObjectField[] = [];
  let index = objectStart + 1;

  while (index < objectEnd - 1) {
    index = skipWhitespaceAndCommas(text, index, objectEnd - 1);
    const name = readStringToken(text, index);
    if (!name) break;

    index = skipWhitespace(text, name.end, objectEnd - 1);
    if (text[index] !== ":") break;
    index = skipWhitespace(text, index + 1, objectEnd - 1);

    const valueStart = index;
    const value = readStringToken(text, index);
    let valueEnd: number;

    if (value) {
      valueEnd = value.end;
      fields.push({
        name: name.content,
        valueStart,
        valueEnd,
        stringValue: value.content,
        quote: value.quote,
      });
    } else {
      valueEnd = findValueEnd(text, index, objectEnd);
      fields.push({
        name: name.content,
        valueStart,
        valueEnd,
      });
    }

    index = valueEnd;
  }

  return fields;
}

function readStringToken(text: string, start: number): StringToken | null {
  const quote = text[start];
  if (quote !== '"' && quote !== "'") return null;

  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char !== quote) continue;

    const token = text.slice(start, index + 1);
    return {
      content: parseStringTokenContent(token, quote),
      end: index + 1,
      quote,
    };
  }

  return null;
}

function parseStringTokenContent(token: string, quote: string): string {
  if (quote === '"') {
    try {
      return JSON.parse(token) as string;
    } catch (_error) {
      return token.slice(1, -1);
    }
  }

  return token.slice(1, -1).replace(/\\(['\\])/g, "$1");
}

function skipWhitespace(text: string, start: number, end: number): number {
  let index = start;
  while (index < end && /\s/.test(text[index])) index += 1;
  return index;
}

function skipWhitespaceAndCommas(
  text: string,
  start: number,
  end: number,
): number {
  let index = start;
  while (index < end && (/\s/.test(text[index]) || text[index] === ",")) {
    index += 1;
  }
  return index;
}

function findValueEnd(text: string, start: number, objectEnd: number): number {
  let depth = 0;
  let quote: string | null = null;

  for (let index = start; index < objectEnd - 1; index += 1) {
    const char = text[index];

    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      if (depth === 0) return index;
      depth -= 1;
    } else if (char === "," && depth === 0) {
      return index;
    }
  }

  return objectEnd - 1;
}

function applyReplacements(text: string, replacements: Replacement[]): string {
  let redacted = text;

  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    redacted =
      redacted.slice(0, replacement.start) +
      replacement.value +
      redacted.slice(replacement.end);
  }

  return redacted;
}
