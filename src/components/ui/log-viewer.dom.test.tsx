// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LogViewer } from "./log-viewer";
import { LogLevel, LogType, type LogEntry } from "@/cp/shared/Logger";

function entry(message: string, overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: new Date("2026-07-12T10:00:00.000Z"),
    level: LogLevel.INFO,
    type: LogType.OCPP,
    message,
    ...overrides,
  };
}

describe("LogViewer horizontal scroll (#178 2.1)", () => {
  it("scrolls the table container horizontally instead of wrapping long messages", () => {
    const longPayload = `Sent: ${JSON.stringify([
      2,
      "1",
      "BootNotification",
      { chargePointVendor: "Acme", chargePointModel: "X".repeat(200) },
    ])}`;
    const { container } = render(<LogViewer logs={[entry(longPayload)]} />);

    const messageCell = screen.getByText(longPayload, { exact: false });
    expect(messageCell.className).toContain("whitespace-nowrap");
    expect(messageCell.className).not.toContain("break-all");

    const scrollContainer = container.querySelector("table")?.parentElement;
    expect(scrollContainer?.className).toContain("overflow-x-auto");
    expect(scrollContainer?.className).toContain("overflow-y-auto");
  });

  it("keeps the scroll container inside a min-w-0 flex column so it can't blow out the page width", () => {
    const { container } = render(<LogViewer logs={[entry("hello")]} />);
    const scrollContainer = container.querySelector("table")?.parentElement;
    const rightColumn = scrollContainer?.parentElement;
    expect(rightColumn?.className).toContain("min-w-0");
  });

  it("still renders timestamp, level, and type as before (no regression)", () => {
    const { container } = render(
      <LogViewer
        logs={[
          entry("hello world", {
            level: LogLevel.WARN,
            type: LogType.HEARTBEAT,
          }),
        ]}
      />,
    );

    // Scope to the row, not the sidebar filter lists which also render
    // "WARN"/"Heartbeat" as filter option labels.
    const row = container.querySelector("tbody tr");
    expect(row?.textContent).toContain("WARN");
    expect(row?.textContent).toContain("Heartbeat");
    expect(row?.textContent).toContain("hello world");
    expect(row?.textContent).toContain("10:00:00.000");
  });
});
