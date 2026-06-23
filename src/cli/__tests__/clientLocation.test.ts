import { describe, it, expect } from "vitest";
import { resolveClientLocation } from "../clientLocation";

const base = {
  httpUrl: null as string | null,
  unixSocket: null as string | null,
  httpBasicAuth: null as { username: string; password: string } | null,
  httpHost: "",
  httpPort: null as number | null,
  basicAuth: null as { username: string; password: string } | null,
};

describe("resolveClientLocation", () => {
  it("uses explicit --http-url + --http-basic-auth with no warnings", () => {
    const { location, warnings } = resolveClientLocation({
      ...base,
      httpUrl: "http://h:1",
      httpBasicAuth: { username: "u", password: "p" },
    });
    expect(location).toEqual({
      httpUrl: "http://h:1",
      unixSocket: null,
      basicAuth: { username: "u", password: "p" },
    });
    expect(warnings).toEqual([]);
  });

  it("derives client target from --http-port/--http-host with a deprecation warning", () => {
    const { location, warnings } = resolveClientLocation({
      ...base,
      httpHost: "localhost",
      httpPort: 9700,
    });
    expect(location.httpUrl).toBe("http://localhost:9700");
    expect(
      warnings.some(
        (w) => w.includes("deprecated") && w.includes("--http-url"),
      ),
    ).toBe(true);
  });

  it("defaults the derived host to 127.0.0.1", () => {
    const { location } = resolveClientLocation({ ...base, httpPort: 9700 });
    expect(location.httpUrl).toBe("http://127.0.0.1:9700");
  });

  it("falls back to --basic-auth-* for client credentials with a deprecation warning", () => {
    const { location, warnings } = resolveClientLocation({
      ...base,
      httpUrl: "http://h:1",
      basicAuth: { username: "a", password: "b" },
    });
    expect(location.basicAuth).toEqual({ username: "a", password: "b" });
    expect(
      warnings.some(
        (w) => w.includes("deprecated") && w.includes("--http-basic-auth"),
      ),
    ).toBe(true);
  });

  it("prefers --http-basic-auth over --basic-auth (no warning)", () => {
    const { location, warnings } = resolveClientLocation({
      ...base,
      httpUrl: "http://h:1",
      httpBasicAuth: { username: "x", password: "y" },
      basicAuth: { username: "a", password: "b" },
    });
    expect(location.basicAuth).toEqual({ username: "x", password: "y" });
    expect(warnings).toEqual([]);
  });

  it("an explicit unix socket suppresses the --http-port derivation", () => {
    const { location, warnings } = resolveClientLocation({
      ...base,
      unixSocket: "/tmp/s.sock",
      httpPort: 9700,
    });
    expect(location.httpUrl).toBeNull();
    expect(location.unixSocket).toBe("/tmp/s.sock");
    expect(warnings).toEqual([]);
  });
});
