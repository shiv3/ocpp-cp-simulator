import { describe, expect, it } from "vitest";
import { ANALYZE_USAGE, parseAnalyzeArgs } from "../parseAnalyzeArgs";

describe("parseAnalyzeArgs", () => {
  it("parses a bare file argument", () => {
    const result = parseAnalyzeArgs(["trace.jsonl"]);
    expect(result).toEqual({
      ok: true,
      args: { file: "trace.jsonl", output: undefined, format: undefined },
    });
  });

  it("parses --output and -o", () => {
    expect(parseAnalyzeArgs(["trace.jsonl", "--output", "out.html"])).toEqual({
      ok: true,
      args: { file: "trace.jsonl", output: "out.html", format: undefined },
    });
    expect(parseAnalyzeArgs(["trace.jsonl", "-o", "out.md"])).toEqual({
      ok: true,
      args: { file: "trace.jsonl", output: "out.md", format: undefined },
    });
  });

  it("parses --format html|markdown", () => {
    expect(parseAnalyzeArgs(["trace.jsonl", "--format", "html"])).toEqual({
      ok: true,
      args: { file: "trace.jsonl", output: undefined, format: "html" },
    });
    expect(parseAnalyzeArgs(["trace.jsonl", "--format", "markdown"])).toEqual({
      ok: true,
      args: { file: "trace.jsonl", output: undefined, format: "markdown" },
    });
  });

  it("accepts flags in any position relative to the positional file", () => {
    const result = parseAnalyzeArgs([
      "--format",
      "html",
      "trace.jsonl",
      "-o",
      "out.html",
    ]);
    expect(result).toEqual({
      ok: true,
      args: { file: "trace.jsonl", output: "out.html", format: "html" },
    });
  });

  it("rejects an invalid --format value", () => {
    const result = parseAnalyzeArgs(["trace.jsonl", "--format", "xml"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("--format must be");
    }
  });

  it("rejects --output with a missing value", () => {
    const result = parseAnalyzeArgs(["trace.jsonl", "--output"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("--output requires a value");
    }
  });

  it("rejects an unknown flag", () => {
    const result = parseAnalyzeArgs(["trace.jsonl", "--bogus"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("Unknown option: --bogus");
    }
  });

  it("rejects a second positional argument as unknown", () => {
    const result = parseAnalyzeArgs(["trace.jsonl", "extra.jsonl"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("Unknown option: extra.jsonl");
    }
  });

  it("reports a missing file with the usage line", () => {
    const result = parseAnalyzeArgs([]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain(
        "Error: analyze requires a trace file path",
      );
      expect(result.message).toContain(ANALYZE_USAGE);
    }
  });

  it("reports a missing file when only flags are given", () => {
    const result = parseAnalyzeArgs(["--format", "html"]);
    expect(result.ok).toBe(false);
  });
});
