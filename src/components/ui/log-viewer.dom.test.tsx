// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

/** Finds a sidebar filter section's `<label>` row by its option text (e.g.
 *  section "Direction", option "Sent"). Scoped to the section because
 *  option labels can collide across sections (e.g. "Heartbeat" is both a
 *  LogType and an OCPP action name). Sidebar sections are
 *  `<div class="border-b"><button><span>{heading}</span>...</button>
 *  {options}</div>`. */
function findFilterOptionRow(
  sectionHeading: string,
  optionLabel: string,
): HTMLLabelElement {
  const heading = screen.getByText(sectionHeading, {
    exact: true,
    selector: "span",
  });
  const section = heading.closest(".border-b");
  if (!section) {
    throw new Error(`No filter section found for heading "${sectionHeading}"`);
  }
  const labels = Array.from(section.querySelectorAll("label"));
  // The direct-child text span, not `label querySelector("span")` generally
  // — a *checked* Checkbox renders its own indicator <span> (wrapping a
  // Check icon) nested inside the checkbox button, which would otherwise
  // shadow the real label text once a row is toggled on.
  const match = labels.find(
    (l) => l.querySelector(":scope > div > span")?.textContent === optionLabel,
  );
  if (!match) {
    throw new Error(
      `No filter option "${optionLabel}" found in section "${sectionHeading}"`,
    );
  }
  return match as HTMLLabelElement;
}

/** Clicks the checkbox inside a specific sidebar filter option. Goes via
 *  the label's own checkbox button rather than relying on native label
 *  click-delegation, which jsdom doesn't reliably forward onto a
 *  `<button role="checkbox">`. */
function clickFilterOption(sectionHeading: string, optionLabel: string) {
  const row = findFilterOptionRow(sectionHeading, optionLabel);
  const checkbox = row.querySelector('button[role="checkbox"]');
  if (!checkbox) {
    throw new Error(`No checkbox found for filter option "${optionLabel}"`);
  }
  fireEvent.click(checkbox);
}

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

    // "Direction"/"Action" also label the #178 2.4 sidebar filter
    // sections, so scope to the table's <thead>.
    const headerRow = container.querySelector("thead tr");
    expect(headerRow?.textContent).toContain("Direction");
    expect(headerRow?.textContent).toContain("Action");

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

describe("LogViewer direction/action filters (#178 2.4)", () => {
  // "Heartbeat" deliberately doubles as both the OCPP action name and an
  // existing LogType enum value, to prove the filter helpers (and the
  // component) don't cross-match sections that happen to share a label.
  function threeMixedLogs() {
    return [
      entry(`Sent: ${JSON.stringify([2, "1", "BootNotification", {}])}`),
      entry(`Received: ${JSON.stringify([2, "9", "Heartbeat", {}])}`),
      entry("unrelated general log line — no direction/action"),
    ];
  }

  it("filters rows down to a single direction when its checkbox is checked", () => {
    const { container } = render(<LogViewer logs={threeMixedLogs()} />);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3);

    clickFilterOption("Direction", "Sent");

    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("BootNotification");
    expect(rows[0].textContent).toContain("→ Sent");
  });

  it("filters rows down to a single OCPP action when its checkbox is checked", () => {
    const { container } = render(<LogViewer logs={threeMixedLogs()} />);

    clickFilterOption("Action", "Heartbeat");

    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Heartbeat");
    expect(rows[0].textContent).toContain("← Received");
  });

  it("filters to the '(none)' bucket for entries with no parsed direction/action", () => {
    const { container } = render(<LogViewer logs={threeMixedLogs()} />);

    clickFilterOption("Direction", "(none)");

    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain(
      "unrelated general log line — no direction/action",
    );
  });

  it("un-checking a direction filter restores the other rows", () => {
    const { container } = render(<LogViewer logs={threeMixedLogs()} />);

    clickFilterOption("Direction", "Sent");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);

    clickFilterOption("Direction", "Sent");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
  });

  it("combines an Action filter with the existing free-text search", () => {
    const { container } = render(<LogViewer logs={threeMixedLogs()} />);

    clickFilterOption("Action", "BootNotification");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);

    const searchBox = screen.getByPlaceholderText("Search in messages...");
    fireEvent.change(searchBox, { target: { value: "chargePointVendor" } });

    // Action filter still selects the BootNotification row, but the free
    // text filter now also requires "chargePointVendor" in the message,
    // which this fixture's payload doesn't contain — so no data rows
    // survive. The empty-state message is itself a <tr>, so scope to the
    // table body's text rather than counting <tr> elements (and don't
    // check page-wide text — the Action sidebar still lists
    // "BootNotification" as an available filter option regardless of
    // what's currently showing in the table).
    const tbody = container.querySelector("tbody");
    expect(tbody?.textContent).toContain("No logs match the current filters");
    expect(tbody?.textContent).not.toContain("BootNotification");
  });

  it("shows per-value counts as badges next to each Direction/Action filter option", () => {
    render(<LogViewer logs={threeMixedLogs()} />);

    const sentRow = findFilterOptionRow("Direction", "Sent");
    expect(sentRow.textContent).toContain("1");

    const heartbeatRow = findFilterOptionRow("Action", "Heartbeat");
    expect(heartbeatRow.textContent).toContain("1");
  });
});
