import { describe, expect, it } from "vitest";
import { tokenizeJson } from "./jsonHighlight";

const kinds = (text: string) =>
  tokenizeJson(text)
    .filter((token) => token.kind !== "text")
    .map((token) => `${token.kind}:${token.text}`);

describe("tokenizeJson", () => {
  it("tells keys from string values, and marks numbers, literals and punctuation", () => {
    expect(
      kinds('{"connectorId": 1, "status": "Available", "ok": true, "x": null}'),
    ).toEqual([
      "punct:{",
      'key:"connectorId"',
      "punct::",
      "number:1",
      "punct:,",
      'key:"status"',
      "punct::",
      'string:"Available"',
      "punct:,",
      'key:"ok"',
      "punct::",
      "boolean:true",
      "punct:,",
      'key:"x"',
      "punct::",
      "null:null",
      "punct:}",
    ]);
  });

  it("keeps escaped quotes inside a string, and reads negative and exponent numbers", () => {
    expect(kinds('["a \\"quoted\\" word", -1.5e3]')).toEqual([
      "punct:[",
      'string:"a \\"quoted\\" word"',
      "punct:,",
      "number:-1.5e3",
      "punct:]",
    ]);
  });

  it("is lossless, even on text that is not valid JSON (a cut or a marker)", () => {
    for (const text of [
      '{\n  "idTag": "[redacted]",\n  "meterStart": 12',
      "… 3 more",
      '{"unterminated: "x',
      "",
    ]) {
      expect(
        tokenizeJson(text)
          .map((token) => token.text)
          .join(""),
      ).toBe(text);
    }
  });

  it("leaves words that only contain a literal as plain text", () => {
    expect(kinds("nullable truest")).toEqual([]);
  });
});
