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
  it("uses the public Open EV Directory, anonymously, when nothing is set", () => {
    expect(resolve()).toEqual({
      ok: true,
      config: { baseUrl: "https://evdb.juherr.dev", apiKey: undefined },
      warnings: [],
    });
  });

  it("is off when the base URL is none, from the flag or OED_BASE_URL", () => {
    expect(resolve({ baseUrl: "none" })).toEqual({
      ok: true,
      config: null,
      warnings: [],
    });
    expect(resolve({}, { OED_BASE_URL: "NONE" })).toMatchObject({
      ok: true,
      config: null,
    });
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
      message: "OED_BASE_URL must be an absolute http(s) URL or none",
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

  it("warns about a key with import turned off, and never names the key", () => {
    const result = resolve({ baseUrl: "none" }, { OED_API_KEY: KEY });
    expect(result).toEqual({
      ok: true,
      config: null,
      warnings: [
        "An Open EV Directory API key is set but vehicle import is turned off (--oed-base-url none / OED_BASE_URL=none)",
      ],
    });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("refuses a key with a plain-http URL to another host", () => {
    expect(
      resolve({ baseUrl: "http://evd.example.test" }, { OED_API_KEY: KEY }),
    ).toEqual({
      ok: false,
      message:
        "An Open EV Directory API key is only sent over https (or to this machine over http)",
    });
    expect(
      resolve({ baseUrl: "http://localhost:8080" }, { OED_API_KEY: KEY }),
    ).toMatchObject({ ok: true, config: { apiKey: KEY } });
  });

  it("ignores blank values", () => {
    expect(resolve({}, { OED_BASE_URL: "  ", OED_API_KEY: " " })).toEqual({
      ok: true,
      config: { baseUrl: "https://evdb.juherr.dev", apiKey: undefined },
      warnings: [],
    });
  });
});
