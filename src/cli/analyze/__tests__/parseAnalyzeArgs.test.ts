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

  describe("--from-daemon", () => {
    it("takes the trace from a running daemon instead of a file", () => {
      const result = parseAnalyzeArgs([
        "--from-daemon",
        "--cp-id",
        "CP001",
        "--output",
        "out.html",
      ]);
      expect(result).toEqual({
        ok: true,
        args: {
          file: undefined,
          output: "out.html",
          format: undefined,
          fromDaemon: true,
          cpId: "CP001",
        },
      });
    });

    it("parses the daemon connection flags", () => {
      const result = parseAnalyzeArgs([
        "--from-daemon",
        "--cp-id",
        "CP001",
        "--http-url",
        "https://sim.example",
        "--http-basic-auth-user",
        "admin",
        "--http-basic-auth-pass",
        "secret",
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.args.httpUrl).toBe("https://sim.example");
        expect(result.args.httpBasicAuth).toEqual({
          username: "admin",
          password: "secret",
        });
      }
    });

    it("requires --cp-id (logs.get is per charge point)", () => {
      const result = parseAnalyzeArgs(["--from-daemon"]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("--from-daemon requires --cp-id");
      }
    });

    it("rejects combining a trace file with --from-daemon", () => {
      const result = parseAnalyzeArgs([
        "trace.jsonl",
        "--from-daemon",
        "--cp-id",
        "CP001",
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain(
          "--from-daemon cannot be combined with a trace file",
        );
      }
    });

    it("rejects a daemon flag without --from-daemon", () => {
      const result = parseAnalyzeArgs(["trace.jsonl", "--cp-id", "CP001"]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("only valid with --from-daemon");
      }
    });

    it("rejects a missing value on a daemon flag", () => {
      const result = parseAnalyzeArgs(["--from-daemon", "--cp-id"]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("--cp-id requires a value");
      }
    });
  });

  describe("--split-by", () => {
    it("defaults to undefined when not passed, so current behavior (split by charge point) is unchanged", () => {
      const result = parseAnalyzeArgs(["trace.jsonl"]);
      expect(result).toEqual({
        ok: true,
        args: {
          file: "trace.jsonl",
          output: undefined,
          format: undefined,
        },
      });
      if (result.ok) {
        expect(result.args.splitBy).toBeUndefined();
      }
    });

    it("parses --split-by connector", () => {
      const result = parseAnalyzeArgs([
        "trace.jsonl",
        "--split-by",
        "connector",
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.args.splitBy).toBe("connector");
      }
    });

    it("parses an explicit --split-by charge-point", () => {
      const result = parseAnalyzeArgs([
        "trace.jsonl",
        "--split-by",
        "charge-point",
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.args.splitBy).toBe("charge-point");
      }
    });

    it("rejects any value other than charge-point or connector", () => {
      const result = parseAnalyzeArgs(["trace.jsonl", "--split-by", "phase"]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain(
          "--split-by must be 'charge-point' or 'connector'",
        );
      }
    });

    it("rejects --split-by with a missing value", () => {
      const result = parseAnalyzeArgs(["trace.jsonl", "--split-by"]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain(
          "--split-by must be 'charge-point' or 'connector'",
        );
      }
    });

    it("combines with --from-daemon (an independent dimension from the trace source)", () => {
      const result = parseAnalyzeArgs([
        "--from-daemon",
        "--cp-id",
        "CP001",
        "--split-by",
        "connector",
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.args.splitBy).toBe("connector");
        expect(result.args.fromDaemon).toBe(true);
      }
    });
  });
});
