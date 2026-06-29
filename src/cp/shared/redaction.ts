export const REDACTED_VALUE = "[redacted]";

const SENSITIVE_KEY_NAMES = new Set([
  "authorizationkey",
  "password",
  "privatekey",
  "tlskey",
]);

const SENSITIVE_ASSIGNMENT =
  /((?:"?(?:AuthorizationKey|authorizationKey|password|privateKey|PrivateKey|tlsKey|TlsKey)"?)\s*[:=]\s*)(["'])(.*?)\2/g;
const SENSITIVE_BARE_ASSIGNMENT =
  /((?:"?(?:AuthorizationKey|authorizationKey|password|privateKey|PrivateKey|tlsKey|TlsKey)"?)\s*[:=]\s*)(?!["'])([^\s,}\]]+)/g;

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

export function isSensitiveKeyName(key: string): boolean {
  return SENSITIVE_KEY_NAMES.has(key.replace(/[-_]/g, "").toLowerCase());
}

export function redactSensitiveText(text: string): string {
  return redactOcppKeyValueText(text)
    .replace(SENSITIVE_ASSIGNMENT, `$1$2${REDACTED_VALUE}$2`)
    .replace(SENSITIVE_BARE_ASSIGNMENT, `$1${REDACTED_VALUE}`);
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
  const out: Record<string, unknown> = {};
  for (const [key, nested] of entries) {
    if (isSensitiveKeyName(key)) continue;
    if (ocppKeyValueObject && key === "value") {
      out[key] = REDACTED_VALUE;
      continue;
    }
    out[key] = redactSensitiveValue(nested);
  }
  return out;
}

function redactOcppKeyValueText(text: string): string {
  const replacements: Replacement[] = [];

  for (const [start, end] of findObjectRanges(text)) {
    const fields = readObjectFields(text, start, end);
    const sensitiveKey = fields.some(
      (field) =>
        field.name === "key" &&
        field.stringValue !== undefined &&
        isSensitiveKeyName(field.stringValue),
    );
    const valueField = fields.find((field) => field.name === "value");

    if (sensitiveKey && valueField) {
      const redactedValue = valueField.quote
        ? `${valueField.quote}${REDACTED_VALUE}${valueField.quote}`
        : `"${REDACTED_VALUE}"`;

      replacements.push({
        start: valueField.valueStart,
        end: valueField.valueEnd,
        value: redactedValue,
      });
    }
  }

  return applyReplacements(text, replacements);
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
