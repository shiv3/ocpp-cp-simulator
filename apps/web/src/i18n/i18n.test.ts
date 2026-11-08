import { describe, expect, it } from "vitest";
import {
  LOCALES,
  DEFAULT_LOCALE,
  MESSAGE_TABLES,
  isLocale,
  translate,
  type MessageKey,
} from "./index";

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const en = MESSAGE_TABLES[DEFAULT_LOCALE] as Record<string, string>;
const others = LOCALES.filter((l) => l !== DEFAULT_LOCALE);

describe("locale completeness", () => {
  it("has English strings", () => {
    expect(Object.keys(en).length).toBeGreaterThan(0);
  });

  for (const locale of others) {
    const table = MESSAGE_TABLES[locale] as Record<string, string>;

    it(`${locale} has every key that en has`, () => {
      const missing = Object.keys(en).filter((k) => !(k in table));
      expect(missing, `${locale} is missing keys`).toEqual([]);
    });

    it(`${locale} has no keys that en lacks`, () => {
      const extra = Object.keys(table).filter((k) => !(k in en));
      expect(extra, `${locale} has unknown keys`).toEqual([]);
    });

    it(`${locale} has no empty strings`, () => {
      const empty = Object.keys(table).filter((k) => table[k].trim() === "");
      expect(empty).toEqual([]);
    });

    it(`${locale} keeps the {placeholders} of en`, () => {
      const bad = Object.keys(table).filter(
        (k) =>
          k in en &&
          JSON.stringify(placeholders(table[k])) !==
            JSON.stringify(placeholders(en[k])),
      );
      expect(bad, `placeholder mismatch in ${locale}`).toEqual([]);
    });
  }
});

describe("translate", () => {
  it("interpolates params and falls back to English for a missing key", () => {
    const key = Object.keys(en).find((k) => /\{\w+\}/.test(en[k])) as
      MessageKey | undefined;
    if (key) {
      expect(translate("en", key, { count: 3, name: "X" })).not.toMatch(
        /\{count\}|\{name\}/,
      );
    }
    expect(translate("ja", "no.such.key" as MessageKey)).toBe("no.such.key");
  });

  it("recognises supported locales only", () => {
    expect(isLocale("ja")).toBe(true);
    expect(isLocale("zh-CN")).toBe(true);
    expect(isLocale("fr")).toBe(false);
  });
});
