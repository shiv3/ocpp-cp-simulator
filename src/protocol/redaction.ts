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

/**
 * The name the text redactor matches in `name: value` / `name=value`: one
 * that ends in a key name above under the `normalizeKeyName` rule (any case,
 * `-` and `_` anywhere), quoted or not. A suffix, as the spelling list it
 * replaces matched (#515): `api_password` and `OED_API_KEY` are secrets.
 * No leading `[-_]*`: the match is unanchored, so it adds nothing, and on a
 * long `_` run it backtracks from every position (quadratic).
 *
 * The escapable form also takes an escaped closing quote, in JSON logged
 * inside a string (`\"password\":`, #531). The assignment names and the
 * opening-line guard use it; the multi-line and PEM guards keep the plain
 * form: there it would end a value early and leave its later lines
 * readable.
 */
const SENSITIVE_NAME_VARIANTS = [...SENSITIVE_KEY_NAMES]
  .map((name) => name.split("").join("[-_]*"))
  .join("|");
/** Cheap precheck: none of the assignment passes matches without it. */
const SENSITIVE_NAME_PRESENT = new RegExp(SENSITIVE_NAME_VARIANTS, "i");
const SENSITIVE_NAME_CORE = `(?:${SENSITIVE_NAME_VARIANTS})[-_]*`;
/** The longest backslash run before a quote that the escaped forms take. */
const MAX_ESCAPES = 7;
const escapeRun = (min: 0 | 1): string => `\\\\{${min},${MAX_ESCAPES}}`;
const sensitiveName = (escape = ""): string =>
  `"?${SENSITIVE_NAME_CORE}${escape}"?`;
const SENSITIVE_ASSIGNMENT_NAME = sensitiveName();
const SENSITIVE_ESCAPABLE_NAME = sensitiveName(escapeRun(0));
/**
 * A quoted value ends at its first unescaped matching quote (`"ab\"cd"` is
 * one value). On the opening line any such quote ends it, unless a
 * sensitive assignment comes first (`password="a privateKey='S1 x" y S2'`):
 * the value then runs to the end of the line (#531). When it is on a
 * later line (a raw newline, or a backslash before the line end), it ends
 * the value only if a delimiter follows it (whitespace, `,`, `}`, `]`, end
 * of text) and no `:` / `=` precedes it: the quote opening the next line's
 * `privateKey="SECRET"` does not end `password="a` (#401, #519). Nor may the
 * value run over another sensitive assignment (`privateKey='S1 x" y S2'`),
 * whose own closing quote would come after. Without such a quote, or across
 * such an assignment, the value ends at the end of its first line, so the
 * next line's own assignment is still seen.
 *
 * A PEM value (`-----BEGIN`, after optional whitespace) ends only at a quote
 * after its `-----END …-----` marker (whitespace or a `\n` / `\r` escape,
 * at any escaping depth such as `\\n`, between) with no sensitive
 * assignment before it, else at the end of the text, whatever quotes its
 * body holds (#519). All fail closed.
 *
 * The `:` / `=` lookbehind comes after the quote it checks: placed before
 * it, V8 runs it at every backtrack position of a long whitespace run
 * (quadratic).
 *
 * The assignment guard also looks past one backslash: the escape branch
 * consumes `\p` of `\privateKey=` in one step, so the guard never runs at
 * the `p`. The END label is letters, digits, spaces and dots only (real
 * PEM labels, `X9.42 DH PARAMETERS` included), so it cannot carry an
 * assignment either.
 */
const noAssignmentAhead = (name: string): string => `(?!\\\\?${name}\\s*[:=])`;
const NO_ASSIGNMENT_AHEAD = noAssignmentAhead(SENSITIVE_ASSIGNMENT_NAME);
const NO_ESCAPABLE_ASSIGNMENT_AHEAD = noAssignmentAhead(
  SENSITIVE_ESCAPABLE_NAME,
);
/** A PEM value up to `close`, its closing quote. */
const pemValue = (close: string): string =>
  `(?=\\s*-----BEGIN)` +
  `(?:(?:${NO_ASSIGNMENT_AHEAD}[\\s\\S])*?` +
  `-----END[A-Z0-9 .]*-----(?:\\s|\\\\+[nr])*${close}|[\\s\\S]*)`;
const QUOTED_PEM_VALUE = pemValue("\\2");
const QUOTED_MULTILINE_VALUE =
  `(?:${NO_ASSIGNMENT_AHEAD}(?:\\\\[\\s\\S]|(?!\\2)[^\\\\]))*` +
  `\\2(?<![:=]\\s*\\2)(?=[\\s,}\\]]|$)`;
const QUOTED_LINE_VALUE =
  `(?:${NO_ESCAPABLE_ASSIGNMENT_AHEAD}(?:\\\\[^\\n]|(?!\\2)[^\\\\\\n]))*` +
  `\\2|[^\\n]*`;
const SENSITIVE_ASSIGNMENT = new RegExp(
  `(${SENSITIVE_ESCAPABLE_NAME}\\s*[:=]\\s*)(["'])` +
    `(?:${QUOTED_PEM_VALUE}|${QUOTED_MULTILINE_VALUE}|${QUOTED_LINE_VALUE})`,
  "gi",
);
/**
 * A value opened by an escaped quote (#531): JSON logged inside a string
 * (`{\"privateKey\":\"S1\"}`), or serialized again (`\\\"`). It ends at the
 * first quote after the same backslash run, or after that run plus an even
 * number of escaped backslashes (`\"S1\\\\\"`, a value ending in `\`); a
 * longer odd run is an escaped quote of the value (`\\\"`). Like a quoted
 * value's opening line, it does not run over a sensitive assignment, and
 * fails closed to the end of its line. A PEM behind it follows the PEM
 * rule above, across lines. The run is capped at `MAX_ESCAPES` backslashes
 * (three serializations); with a longer one the name itself no longer
 * matches, so a deeper-serialized value is not redacted at all.
 */
const ESCAPED_QUOTE_CLOSE = `(?<!\\\\)(?:\\2\\\\\\2\\\\)*\\2\\3`;
const SENSITIVE_ESCAPED_ASSIGNMENT = new RegExp(
  `(${SENSITIVE_ESCAPABLE_NAME}\\s*[:=]\\s*(${escapeRun(1)}))(["'])` +
    `(?:${pemValue(ESCAPED_QUOTE_CLOSE)}` +
    `|(?:${NO_ESCAPABLE_ASSIGNMENT_AHEAD}(?!${ESCAPED_QUOTE_CLOSE})[^\\n])*` +
    `${ESCAPED_QUOTE_CLOSE}|[^\\n]*)`,
  "gi",
);
/**
 * The head of an object or array held by a member whose name is followed by an
 * escaped quote (`\"privateKey\":{…}`, #531): up to and including the opening
 * bracket. Its extent is not a regex's to find: the value inside may be
 * escaped like the name (`{\"d\":\"S1\"}`), plain (`{"d":"S1"}`) or a mix
 * of both, so {@link redactEscapedStructuredValues} reads it by bracket depth.
 */
const SENSITIVE_ESCAPED_STRUCTURED_OPENER = new RegExp(
  `(${SENSITIVE_NAME_CORE}(${escapeRun(1)})"\\s*[:=]\\s*)[{[]`,
  "gi",
);

/**
 * Replace each object or array held by an escaped-JSON member (#531) with the
 * quoted placeholder, so none of its members is left: it ends where its
 * brackets balance, counting only those outside a string (of either quote
 * style, escaped or not), and at the end of the line when they never do. The
 * member then reads `\"[redacted]\"`, which keeps an outer JSON frame
 * parseable but cuts the JSON inside the string.
 */
function redactEscapedStructuredValues(text: string): string {
  let out = "";
  let from = 0;
  SENSITIVE_ESCAPED_STRUCTURED_OPENER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SENSITIVE_ESCAPED_STRUCTURED_OPENER.exec(text)) !== null) {
    const openAt = match.index + match[0].length - 1;
    const end = structuredValueEnd(text, openAt);
    out +=
      text.slice(from, match.index) +
      match[1] +
      match[2] +
      `"${REDACTED_VALUE}${match[2]}"`;
    from = end;
    SENSITIVE_ESCAPED_STRUCTURED_OPENER.lastIndex = end;
  }
  return out + text.slice(from);
}

/**
 * Just past the bracket closing the one at `open`, or the end of its line.
 *
 * A quote, escaped or not, opens or closes a string, and no bracket inside
 * one counts: `{\"d\":\"}S1{\"}` holds a string `}S1{` whose braces are
 * not the object's. A backslash run ahead of a quote belongs to that quote;
 * the same run closes the string it opened.
 */
function structuredValueEnd(text: string, open: number): number {
  let depth = 0;
  let string: { quote: string; escapes: number } | null = null;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n") return index;
    if (char === "\\") continue;
    if (char === '"' || char === "'") {
      let escapes = 0;
      while (text[index - 1 - escapes] === "\\") escapes += 1;
      if (string === null) {
        string = { quote: char, escapes };
      } else if (char === string.quote && escapes === string.escapes) {
        string = null;
      }
      continue;
    }
    if (string !== null) continue;
    if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return text.length;
}

const SENSITIVE_BARE_ASSIGNMENT = new RegExp(
  `(${SENSITIVE_ESCAPABLE_NAME}\\s*[:=]\\s*)(?!${escapeRun(0)}["'])([^\\s,}\\]]+)`,
  "gi",
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

/** The text redactor's name rule: `apiPassword` as well as `password`. */
function endsWithSensitiveKeyName(key: string): boolean {
  const normalized = normalizeKeyName(key);
  return [...SENSITIVE_KEY_NAMES].some((name) => normalized.endsWith(name));
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

/** The opening of a quoted sensitive assignment, value not included. */
const SENSITIVE_QUOTED_OPENER = new RegExp(
  `(${SENSITIVE_ASSIGNMENT_NAME}\\s*[:=]\\s*)(["'])`,
  "gi",
);

/**
 * #547: a regex engine may give up on a long match and report none, where
 * another completes it: JavaScriptCore (Bun) does on a quoted value of some
 * 50k characters that V8 (Node) redacts. `SENSITIVE_ASSIGNMENT` then leaves
 * the value in clear. Every quoted opener it handled is followed by the
 * redacted value, so one that is not was missed: its value is cut here, in
 * code, without a regex over its length. It ends at the first unescaped
 * matching quote on its line; a PEM value, or one with no such quote, runs
 * to the end of the text. Fails closed; a no-op where the regex completed.
 */
function redactMissedQuotedValues(text: string): string {
  let out = "";
  let from = 0;
  SENSITIVE_QUOTED_OPENER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SENSITIVE_QUOTED_OPENER.exec(text)) !== null) {
    const quote = match[2];
    const valueStart = match.index + match[0].length;
    if (text.startsWith(`${REDACTED_VALUE}${quote}`, valueStart)) continue;
    out +=
      text.slice(from, match.index) + match[1] + quote + REDACTED_VALUE + quote;
    const end = quotedValueEndOnLine(text, valueStart, quote);
    if (end === null) return out;
    from = end;
    SENSITIVE_QUOTED_OPENER.lastIndex = end;
  }
  return out + text.slice(from);
}

/** Just past the closing quote on the value's first line; `null` for a PEM
 *  value or when the line holds none. */
function quotedValueEndOnLine(
  text: string,
  start: number,
  quote: string,
): number | null {
  if (/^\s*-----BEGIN/.test(text.slice(start, start + 64))) return null;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n") return null;
    if (char === "\\") {
      index += 1;
    } else if (char === quote) {
      return index + 1;
    }
  }
  return null;
}

export function redactSensitiveText(text: string): string {
  return redactAssignments(redactOcppKeyValueText(text))
    .replace(URL_USERINFO, `$1:${REDACTED_VALUE}@`)
    .replace(URL_SECRET_QUERY, `$1${REDACTED_VALUE}`)
    .replace(BEARER_TOKEN, `$1${REDACTED_VALUE}`);
}

/**
 * The `name: value` passes, in order. Each needs a sensitive name, and the
 * escaped ones a backslash too, so most log lines skip them all: a pass
 * that cannot match leaves the text as it is.
 */
function redactAssignments(text: string): string {
  if (!SENSITIVE_NAME_PRESENT.test(text)) return text;
  let redacted = text;
  if (redacted.includes("\\")) {
    redacted = redactEscapedStructuredValues(redacted).replace(
      SENSITIVE_ESCAPED_ASSIGNMENT,
      `$1$3${REDACTED_VALUE}$2$3`,
    );
  }
  return redactMissedQuotedValues(
    redacted.replace(SENSITIVE_ASSIGNMENT, `$1$2${REDACTED_VALUE}$2`),
  ).replace(SENSITIVE_BARE_ASSIGNMENT, redactBareValue);
}

/**
 * A quoted name is a JSON member (`"simPin":1234`): quote the replacement so
 * the logged frame still parses for the trace adapter (#401). Elsewhere
 * (`api_key=…`) it stays bare. The match may start inside the name
 * (`password":` of `"api_password":`), so the closing quote decides. An
 * escaped one (`\"simPin\":1234`, #531) gets the same escape, so the string
 * holding that JSON still parses.
 */
function redactBareValue(_match: string, prefix: string): string {
  const quote = /(\\*)"\s*[:=]/.exec(prefix);
  return quote
    ? `${prefix}${quote[1]}"${REDACTED_VALUE}${quote[1]}"`
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
 * Redacts, in serialized text, the whole value of a member whose name is
 * sensitive (#515), the value of a 1.6 `{ key, value }` entry whose key is,
 * the `attributeValue` of a 2.0.1 `{ variable: { name }, attributeValue }`
 * entry whose variable is (#400) and the `key` of an object held under `vpn`
 * (#401) — the same shapes `redactSensitiveValue` handles on parsed payloads.
 */
function redactOcppKeyValueText(text: string): string {
  const replacements: Replacement[] = [];
  const objectRanges = findObjectRanges(text);
  const objectEndByStart = new Map(objectRanges);

  for (const [start, end] of objectRanges) {
    const fields = readObjectFields(text, start, end);
    // A secret-named member, whatever its value holds: the regexes stop at
    // the first `}` / `]` of an object or array value and break the JSON
    // (#515). Same name rule as theirs, so none of their matches is left.
    for (const field of fields) {
      if (endsWithSensitiveKeyName(field.name)) {
        replacements.push(redactField(field));
      }
    }

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

/**
 * The ranges come from one parse, so two of them are disjoint or nested: a
 * range inside one already replaced (`{"password":{"tlsKey":"x"}}`) is
 * dropped, since its offsets no longer hold once the outer one is applied.
 */
function applyReplacements(text: string, replacements: Replacement[]): string {
  const outermost: Replacement[] = [];
  let lastEnd = -1;
  for (const replacement of [...replacements].sort(
    (a, b) => a.start - b.start || b.end - a.end,
  )) {
    if (replacement.start < lastEnd) continue;
    outermost.push(replacement);
    lastEnd = replacement.end;
  }

  let redacted = text;
  for (const replacement of outermost.reverse()) {
    redacted =
      redacted.slice(0, replacement.start) +
      replacement.value +
      redacted.slice(replacement.end);
  }

  return redacted;
}
