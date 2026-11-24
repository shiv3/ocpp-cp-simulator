import { describe, expect, it } from "vitest";
import {
  PolyfillAbortController,
  PolyfillURL,
  base64Decode,
  base64Encode,
  installPolyfills,
} from "../polyfills";

describe("URL polyfill agrees with WHATWG URL on what the engine reads", () => {
  const samples = [
    "ws://csms.example.com/ocpp",
    "wss://csms.example.com:8443/ocpp/v1?token=abc&x=1#frag",
    "ws://user:pa%20ss@127.0.0.1:9000/a/b",
    "ws://localhost:80/ocpp",
    "wss://HOST.example.com:443/",
    "http://[::1]:8080/path?q=1",
    "ws://csms.example.com",
  ];
  for (const href of samples) {
    it(href, () => {
      const real = new URL(href);
      const poly = new PolyfillURL(href);
      expect(poly.protocol).toBe(real.protocol);
      expect(poly.hostname).toBe(real.hostname);
      expect(poly.port).toBe(real.port);
      expect(poly.pathname).toBe(real.pathname);
      expect(poly.username).toBe(real.username);
      expect(poly.password).toBe(real.password);
      expect(poly.search).toBe(real.search);
      expect(poly.hash).toBe(real.hash);
      expect(poly.host).toBe(real.host);
      expect(poly.origin).toBe(real.origin);
    });
  }

  it("rejects what is not an absolute URL, as new URL does", () => {
    expect(() => new PolyfillURL("/ocpp")).toThrow(TypeError);
    expect(() => new PolyfillURL("not a url")).toThrow(TypeError);
  });

  it("round-trips search params", () => {
    const url = new PolyfillURL("ws://h/p?a=1");
    url.searchParams.set("b", "x y");
    expect(url.search).toBe("?a=1&b=x%20y");
    expect(url.searchParams.get("a")).toBe("1");
  });
});

describe("base64", () => {
  for (const text of [
    "",
    "f",
    "fo",
    "foo",
    "foob",
    "CP-00001:secret",
    "ÿ\u0000a",
  ]) {
    it(`matches btoa/atob for ${JSON.stringify(text)}`, () => {
      expect(base64Encode(text)).toBe(btoa(text));
      expect(base64Decode(btoa(text))).toBe(text);
    });
  }
  it("refuses characters outside Latin1", () => {
    expect(() => base64Encode("€")).toThrow();
  });
});

describe("AbortController polyfill", () => {
  it("aborts once and notifies listeners", () => {
    const c = new PolyfillAbortController();
    let n = 0;
    c.signal.addEventListener("abort", () => n++);
    c.abort("why");
    c.abort("again");
    expect(c.signal.aborted).toBe(true);
    expect(c.signal.reason).toBe("why");
    expect(n).toBe(1);
  });
});

describe("installPolyfills", () => {
  it("fills a bare global and leaves existing members alone", async () => {
    const target: Record<string, unknown> = { btoa: () => "kept" };
    installPolyfills(target);
    for (const name of [
      "URL",
      "URLSearchParams",
      "AbortController",
      "AbortSignal",
      "EventTarget",
      "Event",
      "queueMicrotask",
      "setImmediate",
      "atob",
      "performance",
      "structuredClone",
    ]) {
      expect(target[name], name).toBeDefined();
    }
    expect((target.btoa as () => string)()).toBe("kept");
    let ran = false;
    (target.queueMicrotask as (f: () => void) => void)(() => (ran = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(ran).toBe(true);
    expect(
      (target.structuredClone as (v: unknown) => unknown)({ a: [1] }),
    ).toEqual({ a: [1] });
  });
});
