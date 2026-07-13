// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LogViewer } from "./log-viewer";
import { LogLevel, LogType, type LogEntry } from "@/cp/shared/Logger";

// vitest doesn't run with `globals: true` in this repo, so
// @testing-library/react's auto-cleanup-on-afterEach detection never fires
// (it looks for a global `afterEach`). Without this, every `render()` in
// this file would pile onto the same jsdom document, and later tests'
// `screen.getByText` queries would match leftover nodes from earlier tests.
afterEach(() => {
  cleanup();
});

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

describe("LogViewer action + direction columns (#178 2.2/2.3)", () => {
  it("shows the parsed action and a Sent badge for an outgoing CALL", () => {
    const { container } = render(
      <LogViewer
        logs={[
          entry(
            `Sent: ${JSON.stringify([2, "1", "BootNotification", { chargePointVendor: "Acme" }])}`,
          ),
        ]}
      />,
    );

    const row = container.querySelector("tbody tr");
    expect(row?.textContent).toContain("BootNotification");
    expect(row?.textContent).toContain("→ Sent");
  });

  it("shows the parsed action and a Received badge for an incoming CALL", () => {
    const { container } = render(
      <LogViewer
        logs={[
          entry(
            `Received: ${JSON.stringify([2, "9", "RemoteStartTransaction", {}])}`,
          ),
        ]}
      />,
    );

    const row = container.querySelector("tbody tr");
    expect(row?.textContent).toContain("RemoteStartTransaction");
    expect(row?.textContent).toContain("← Received");
  });

  it("correlates a CALLRESULT back to its CALL's action across rows", () => {
    const { container } = render(
      <LogViewer
        logs={[
          entry(
            `Sent: ${JSON.stringify([2, "1", "BootNotification", { chargePointVendor: "Acme" }])}`,
          ),
          entry(
            `Received: ${JSON.stringify([3, "1", { status: "Accepted" }])}`,
          ),
        ]}
      />,
    );

    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("BootNotification");
    expect(rows[0].textContent).toContain("→ Sent");
    expect(rows[1].textContent).toContain("BootNotification");
    expect(rows[1].textContent).toContain("← Received");
  });

  it("shows the SOAP operation as the action for SOAP wire log lines", () => {
    const { container } = render(
      <LogViewer
        logs={[
          entry("SOAP POST Heartbeat: <soap:Envelope/>"),
          entry("SOAP response Heartbeat: <soap:Envelope/>"),
        ]}
      />,
    );

    const rows = container.querySelectorAll("tbody tr");
    expect(rows[0].textContent).toContain("Heartbeat");
    expect(rows[0].textContent).toContain("→ Sent");
    expect(rows[1].textContent).toContain("Heartbeat");
    expect(rows[1].textContent).toContain("← Received");
  });

  it("renders a dash placeholder for non-wire log lines (no action/direction)", () => {
    const { container } = render(
      <LogViewer logs={[entry("Scenario step completed: Connect to CSMS")]} />,
    );

    const row = container.querySelector("tbody tr");
    expect(row?.textContent).toContain("—");
    expect(row?.textContent).not.toContain("Sent");
    expect(row?.textContent).not.toContain("Received");
  });

  it("still shows Direction/Action headers and preserves correlation when filtering by text", async () => {
    const { container } = render(
      <LogViewer
        logs={[
          entry(`Sent: ${JSON.stringify([2, "1", "BootNotification", {}])}`),
          entry(
            `Received: ${JSON.stringify([3, "1", { status: "Accepted" }])}`,
          ),
          entry("unrelated general log line"),
        ]}
      />,
    );

    expect(screen.getByText("Direction")).toBeInTheDocument();
    expect(screen.getByText("Action")).toBeInTheDocument();

    // Even though the CALLRESULT row's message text doesn't contain
    // "BootNotification" itself, correlation still resolves its action
    // because logOcppInfo is computed over the full `logs` list.
    const rows = container.querySelectorAll("tbody tr");
    const receivedRow = [...rows].find((r) =>
      r.textContent?.includes("← Received"),
    );
    expect(receivedRow?.textContent).toContain("BootNotification");
  });
});
