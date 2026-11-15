/**
 * A lenient JSON tokenizer for syntax highlighting. The trace viewer hands
 * the host its printed payload, which may be cut or carry markers
 * (`"[redacted]"`, a "more" note), so this never parses: it splits the text
 * into tokens whose texts concatenate back to the input, and anything it does
 * not recognize stays plain text.
 */

export type JsonTokenKind =
  "key" | "string" | "number" | "boolean" | "null" | "punct" | "text";

export interface JsonToken {
  kind: JsonTokenKind;
  text: string;
}

// A string (a key when a colon follows), a number, a literal, punctuation.
const TOKEN =
  /("(?:[^"\\\n]|\\.)*")(?=\s*:)|("(?:[^"\\\n]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|\b(null)\b|([{}[\],:])/g;

export function tokenizeJson(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index;
    if (start > last)
      tokens.push({ kind: "text", text: text.slice(last, start) });
    const [all, key, string, number, boolean, literal] = match;
    const kind: JsonTokenKind =
      key !== undefined
        ? "key"
        : string !== undefined
          ? "string"
          : number !== undefined
            ? "number"
            : boolean !== undefined
              ? "boolean"
              : literal !== undefined
                ? "null"
                : "punct";
    tokens.push({ kind, text: all });
    last = start + all.length;
  }
  if (last < text.length) tokens.push({ kind: "text", text: text.slice(last) });
  return tokens;
}
