import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installLogSink,
  parseLogLevel,
  parseSize,
  RotatingFile,
} from "../logSink";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "logsink-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("parsers", () => {
  it("parses levels and sizes", () => {
    expect(parseLogLevel("WARN")).toBe("warn");
    expect(parseLogLevel("trace")).toBeNull();
    expect(parseSize("10m")).toBe(10 * 1024 * 1024);
    expect(parseSize("512k")).toBe(512 * 1024);
    expect(parseSize("1000")).toBe(1000);
    expect(parseSize("0")).toBeNull();
    expect(parseSize("ten")).toBeNull();
  });
});

describe("RotatingFile", () => {
  it("rotates by size and keeps `keep` files", () => {
    const file = path.join(dir, "d.log");
    const rf = new RotatingFile({ file, maxBytes: 20, keep: 2 });
    for (let i = 0; i < 6; i++) rf.write(`line-${i}-xxxxxxxx`); // 16 bytes each
    rf.close();
    expect(fs.readdirSync(dir).sort()).toEqual(["d.log", "d.log.1", "d.log.2"]);
    expect(fs.readFileSync(file, "utf-8")).toBe("line-5-xxxxxxxx\n");
    expect(fs.readFileSync(`${file}.1`, "utf-8")).toBe("line-4-xxxxxxxx\n");
    expect(fs.readFileSync(`${file}.2`, "utf-8")).toBe("line-3-xxxxxxxx\n");
  });

  it("rotates when the local date changes", () => {
    const file = path.join(dir, "d.log");
    let now = new Date(2026, 0, 1, 23, 59);
    const rf = new RotatingFile({ file, daily: true, keep: 3, now: () => now });
    rf.write("day one");
    now = new Date(2026, 0, 2, 0, 1);
    rf.write("day two");
    rf.close();
    expect(fs.readFileSync(`${file}.1`, "utf-8")).toBe("day one\n");
    expect(fs.readFileSync(file, "utf-8")).toBe("day two\n");
  });

  it("appends to an existing file and creates the directory", () => {
    const file = path.join(dir, "sub", "d.log");
    const first = new RotatingFile({ file });
    first.write("a");
    first.close();
    const second = new RotatingFile({ file });
    second.write("b");
    second.close();
    expect(fs.readFileSync(file, "utf-8")).toBe("a\nb\n");
  });

  it("never rotates without a limit", () => {
    const file = path.join(dir, "d.log");
    const rf = new RotatingFile({ file });
    for (let i = 0; i < 100; i++) rf.write("x".repeat(100));
    rf.close();
    expect(fs.readdirSync(dir)).toEqual(["d.log"]);
  });
});

describe("installLogSink", () => {
  function fakeConsole() {
    const seen: string[] = [];
    const make =
      (level: string) =>
      (...args: unknown[]) => {
        seen.push(`${level}:${args.join(" ")}`);
      };
    return {
      seen,
      console: {
        debug: make("debug"),
        info: make("info"),
        warn: make("warn"),
        error: make("error"),
      } as Pick<Console, "debug" | "info" | "warn" | "error">,
    };
  }

  it("changes nothing when neither option is given", () => {
    const { console: c } = fakeConsole();
    const before = { ...c };
    installLogSink({}, c)();
    expect(c.info).toBe(before.info);
    installLogSink({}, c);
    expect(c.info).toBe(before.info);
  });

  it("drops lines below the level and copies the rest into the file", () => {
    const { console: c, seen } = fakeConsole();
    const file = path.join(dir, "d.log");
    const restore = installLogSink({ level: "info", file: { file } }, c);
    c.debug("hidden");
    c.info("a %s", "b");
    c.warn("w");
    c.error("e");
    restore();
    expect(seen).toEqual(["info:a %s b", "warn:w", "error:e"].map((l) => l));
    expect(fs.readFileSync(file, "utf-8")).toBe("a b\nw\ne\n");
  });

  it("restores the console on teardown", () => {
    const { console: c, seen } = fakeConsole();
    const original = c.info;
    const restore = installLogSink({ level: "error" }, c);
    expect(c.info).not.toBe(original);
    restore();
    expect(c.info).toBe(original);
    c.info("x");
    expect(seen).toEqual(["info:x"]);
  });
});
