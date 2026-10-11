import { describe, expect, it } from "vitest";

import { resolveVehicleCatalogConfig } from "../vehicleCatalogConfig";

const KEY = "evd_live_SENTINEL_key";

function resolve(
  flags: { baseUrl?: string | null; apiKeyFile?: string | null } = {},
  env: Record<string, string | undefined> = {},
  files: Record<string, string> = {},
) {
  return resolveVehicleCatalogConfig({
    flagBaseUrl: flags.baseUrl ?? null,
    flagApiKeyFile: flags.apiKeyFile ?? null,
    env,
    readFile: (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
  });
}

describe("resolveVehicleCatalogConfig (#458)", () => {
  it("is off when nothing is set", () => {
    expect(resolve()).toEqual({ ok: true, config: null, warnings: [] });
  });

  it("takes the base URL from the flag, then from OED_BASE_URL", () => {
    expect(
      resolve(
        { baseUrl: "https://flag.example" },
        { OED_BASE_URL: "https://env.example" },
      ),
    ).toMatchObject({ ok: true, config: { baseUrl: "https://flag.example" } });
    expect(resolve({}, { OED_BASE_URL: "https://env.example" })).toMatchObject({
      ok: true,
      config: { baseUrl: "https://env.example", apiKey: undefined },
    });
  });

  it("refuses an OED_BASE_URL that is not http(s)", () => {
    expect(resolve({}, { OED_BASE_URL: "evd.example" })).toEqual({
      ok: false,
      message: "OED_BASE_URL must be an absolute http(s) URL",
    });
  });

  it("reads the key from OED_API_KEY", () => {
    expect(
      resolve({}, { OED_BASE_URL: "https://env.example", OED_API_KEY: KEY }),
    ).toMatchObject({ ok: true, config: { apiKey: KEY } });
  });

  it("prefers a key file, from the flag then from OED_API_KEY_FILE, trimmed", () => {
    const files = {
      "/run/secrets/a": `${KEY}-a\n`,
      "/run/secrets/b": `${KEY}-b`,
    };
    const env = {
      OED_BASE_URL: "https://env.example",
      OED_API_KEY: KEY,
      OED_API_KEY_FILE: "/run/secrets/b",
    };
    expect(resolve({ apiKeyFile: "/run/secrets/a" }, env, files)).toMatchObject(
      {
        config: { apiKey: `${KEY}-a` },
      },
    );
    expect(resolve({}, env, files)).toMatchObject({
      config: { apiKey: `${KEY}-b` },
    });
  });

  it("fails on an unreadable or empty key file without quoting its content", () => {
    const env = { OED_BASE_URL: "https://env.example" };
    const missing = resolve({ apiKeyFile: "/nope" }, env);
    expect(missing).toMatchObject({ ok: false });
    const empty = resolve({ apiKeyFile: "/empty" }, env, { "/empty": " \n" });
    expect(empty).toEqual({
      ok: false,
      message: "--oed-api-key-file /empty is empty",
    });
  });

  it("warns about a key without a base URL, and never names the key", () => {
    const result = resolve({}, { OED_API_KEY: KEY });
    expect(result).toEqual({
      ok: true,
      config: null,
      warnings: [
        "An Open EV Directory API key is set but no base URL (--oed-base-url or OED_BASE_URL); vehicle import is disabled",
      ],
    });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("ignores blank values", () => {
    expect(resolve({}, { OED_BASE_URL: "  ", OED_API_KEY: " " })).toEqual({
      ok: true,
      config: null,
      warnings: [],
    });
  });
});
