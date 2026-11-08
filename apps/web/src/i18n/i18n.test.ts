import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scenarioTemplates } from "@ocpp-cp-simulator/core/utils/scenarioTemplates";
import i18n, { LOCALES, DEFAULT_LOCALE, isLocale, t } from "./index";
import { NAMESPACES } from "./resources";

const dir = new URL("./locales/", import.meta.url);

type Table = Record<string, string>;
const load = (locale: string): Table => {
  const merged: Table = {};
  for (const file of readdirSync(new URL(`${locale}/`, dir))) {
    const table = JSON.parse(
      readFileSync(new URL(`${locale}/${file}`, dir), "utf8"),
    ) as Table;
    for (const key of Object.keys(table)) {
      expect(merged, `${key} is defined twice`).not.toHaveProperty(key);
    }
    Object.assign(merged, table);
  }
  return merged;
};

/** Languages with one plural form (ja, zh) only carry `_other`; English has
 * `_one` and `_other`. Compare keys by their plural-less base name. */
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const base = (key: string): string => key.replace(PLURAL_SUFFIX, "");
const bases = (table: Table): Set<string> =>
  new Set(Object.keys(table).map(base));

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{\{\s*(\w+)[^}]*\}\}/g)].map((m) => m[1]).sort();

const messageNames = (text: string): string[] =>
  [
    ...new Set(
      [...text.matchAll(/\b[A-Z]\w*\.(?:req|conf)\b/g)].map((m) => m[0]),
    ),
  ].sort();

const en = load(DEFAULT_LOCALE);
const enBases = bases(en);
const others = LOCALES.filter((l) => l !== DEFAULT_LOCALE);

describe("locale completeness", () => {
  it("has the same namespace files in every locale", () => {
    const expected = NAMESPACES.map((n) => `${n}.json`).sort();
    for (const locale of LOCALES) {
      expect(readdirSync(new URL(`${locale}/`, dir)).sort()).toEqual(expected);
    }
  });

  it("has English strings, with _one and _other for every plural", () => {
    expect(Object.keys(en).length).toBeGreaterThan(0);
    for (const key of Object.keys(en).filter((k) => k.endsWith("_one"))) {
      expect(en, `${key} needs an _other form`).toHaveProperty(
        `${base(key)}_other`,
      );
    }
    for (const key of Object.keys(en).filter((k) => k.endsWith("_other"))) {
      expect(en, `${key} needs a _one form`).toHaveProperty(`${base(key)}_one`);
    }
  });

  it("has no Japanese or Chinese characters in en", () => {
    const cjk = /[぀-ヿ㐀-鿿＀-￯]/;
    expect(Object.keys(en).filter((k) => cjk.test(en[k]))).toEqual([]);
  });

  it("repeats the built-in template's own text in en", () => {
    // en is the source the other locales translate, so it must say what
    // the template data says (#807). A template without an entry shows its
    // own text, so only an entry that exists is compared.
    const source: Table = {};
    for (const tpl of scenarioTemplates) {
      source[`templates.${tpl.id}.name`] = tpl.name;
      source[`templates.${tpl.id}.description`] = tpl.description;
    }
    const entries = Object.entries(en).filter(([k]) =>
      k.startsWith("templates."),
    );
    expect(entries.length).toBeGreaterThan(0);
    const bad = entries
      .filter(([k, text]) => source[k] !== text)
      .map(([k]) => k);
    expect(bad, "en template text that differs or has no template").toEqual([]);
  });

  for (const locale of others) {
    const table = load(locale);

    it(`${locale} has every key that en has`, () => {
      const have = bases(table);
      const missing = [...enBases].filter((k) => !have.has(k));
      expect(missing, `${locale} is missing keys`).toEqual([]);
    });

    it(`${locale} has no keys that en lacks`, () => {
      const extra = [...bases(table)].filter((k) => !enBases.has(k));
      expect(extra, `${locale} has unknown keys`).toEqual([]);
    });

    it(`${locale} has the plural forms of its language`, () => {
      // i18next picks the suffix with Intl.PluralRules: a form missing here
      // falls back to English, an extra one is never used.
      const categories = new Intl.PluralRules(locale)
        .resolvedOptions()
        .pluralCategories.map((c) => `_${c}`)
        .sort();
      const plurals = [...enBases].filter((b) => `${b}_other` in en);
      const bad = plurals.filter((b) => {
        const forms = Object.keys(table)
          .filter((k) => base(k) === b && PLURAL_SUFFIX.test(k))
          .map((k) => k.slice(b.length))
          .sort();
        return JSON.stringify(forms) !== JSON.stringify(categories);
      });
      expect(bad, `plural forms in ${locale}`).toEqual([]);
    });

    it(`${locale} names the OCPP messages of each template description`, () => {
      // Message names are never translated, so a locale must carry the
      // template's own `X.req` tokens: a wrong name copied from en shows up
      // here once the template is fixed (#807).
      const bad = scenarioTemplates
        .filter((tpl) => {
          const text = table[`templates.${tpl.id}.description`];
          return (
            text !== undefined &&
            JSON.stringify(messageNames(text)) !==
              JSON.stringify(messageNames(tpl.description))
          );
        })
        .map((tpl) => tpl.id);
      expect(bad, `OCPP message names in ${locale}`).toEqual([]);
    });

    it(`${locale} has no empty strings`, () => {
      const empty = Object.keys(table).filter((k) => table[k].trim() === "");
      expect(empty).toEqual([]);
    });

    it(`${locale} keeps the {{placeholders}} of en`, () => {
      // Compare against the _other form: the _one form of en may drop {{count}}.
      const bad = Object.keys(table).filter((k) => {
        const source = en[k] ?? en[`${base(k)}_other`];
        return (
          source !== undefined &&
          JSON.stringify(placeholders(table[k])) !==
            JSON.stringify(placeholders(source))
        );
      });
      expect(bad, `placeholder mismatch in ${locale}`).toEqual([]);
    });
  }
});

describe("t", () => {
  it("uses the _one form for 1 and _other otherwise", () => {
    expect(t("settings.page.tagsActive", { count: 1 })).toBe("1 tag active.");
    expect(t("settings.page.tagsActive", { count: 2 })).toBe("2 tags active.");
  });

  it("interpolates params and returns the key when nothing matches", () => {
    expect(t("cp.page.confirmDelete", { id: "CP-1" })).toContain("CP-1");
    expect(i18n.t("no.such.key" as never)).toBe("no.such.key");
  });

  it("recognises supported locales only", () => {
    expect(isLocale("ja")).toBe(true);
    expect(isLocale("zh-CN")).toBe(true);
    expect(isLocale("fr")).toBe(true);
    expect(isLocale("de")).toBe(false);
  });
});
