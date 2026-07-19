import { describe, expect, it } from "vitest";
import {
  ANALYZE_DISCLAIMER,
  appendMarkdownDisclaimer,
  injectHtmlDisclaimer,
  perGroupOutputPath,
  resolveReportFormat,
  sanitizeCpIdForFilename,
} from "../runAnalyze";

describe("resolveReportFormat", () => {
  it("honors an explicit --format over the --output extension", () => {
    expect(resolveReportFormat("out.html", "markdown")).toBe("markdown");
    expect(resolveReportFormat("out.md", "html")).toBe("html");
  });

  it("infers html from a .html --output extension when --format is absent", () => {
    expect(resolveReportFormat("report.html", undefined)).toBe("html");
    expect(resolveReportFormat("report.HTML", undefined)).toBe("html");
  });

  it("defaults to markdown when there is no --format and no .html extension", () => {
    expect(resolveReportFormat("report.md", undefined)).toBe("markdown");
    expect(resolveReportFormat("report", undefined)).toBe("markdown");
    expect(resolveReportFormat(undefined, undefined)).toBe("markdown");
  });
});

describe("sanitizeCpIdForFilename", () => {
  it("passes through a plain charge point id", () => {
    expect(sanitizeCpIdForFilename("CP001")).toBe("CP001");
  });

  it("replaces characters unsafe for a filesystem path with underscores", () => {
    expect(sanitizeCpIdForFilename("CP 001/foo")).toBe("CP_001_foo");
    expect(sanitizeCpIdForFilename("(no chargePointId)")).toBe(
      "_no_chargePointId_",
    );
  });

  it("leaves dots, underscores, and hyphens untouched", () => {
    expect(sanitizeCpIdForFilename("CP-001_v1.6")).toBe("CP-001_v1.6");
  });
});

describe("perGroupOutputPath", () => {
  it("inserts the sanitized chargePointId before the extension", () => {
    expect(perGroupOutputPath("out.html", "CP001")).toBe("out.CP001.html");
    expect(perGroupOutputPath("report.md", "CP-B")).toBe("report.CP-B.md");
  });

  it("handles an --output path with no extension", () => {
    expect(perGroupOutputPath("report", "CP001")).toBe("report.CP001");
  });

  it("handles an --output path with a directory component", () => {
    expect(perGroupOutputPath("/tmp/out/report.html", "CP001")).toBe(
      "/tmp/out/report.CP001.html",
    );
  });

  it("sanitizes the chargePointId for filesystem safety", () => {
    expect(perGroupOutputPath("out.html", "(no chargePointId)")).toBe(
      "out._no_chargePointId_.html",
    );
  });
});

describe("appendMarkdownDisclaimer", () => {
  it("appends the disclaimer as a trailing paragraph", () => {
    const md = "# Report\n\nsome content\n";
    const withDisclaimer = appendMarkdownDisclaimer(md);
    expect(withDisclaimer.startsWith(md)).toBe(true);
    expect(withDisclaimer).toContain(ANALYZE_DISCLAIMER);
  });
});

describe("injectHtmlDisclaimer", () => {
  it("inserts a <p> disclaimer immediately before </body>", () => {
    const html = "<html><body><h1>Report</h1></body></html>";
    const result = injectHtmlDisclaimer(html);
    expect(result).toBe(
      `<html><body><h1>Report</h1><p>${ANALYZE_DISCLAIMER}</p></body></html>`,
    );
  });

  it("appends at the end when </body> is missing", () => {
    const html = "<html><h1>Report</h1></html>";
    const result = injectHtmlDisclaimer(html);
    expect(result).toBe(
      `<html><h1>Report</h1></html><p>${ANALYZE_DISCLAIMER}</p>`,
    );
  });
});
