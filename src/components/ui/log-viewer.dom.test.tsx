// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogViewer, type ClearLogsScope } from "./log-viewer";
import { LogLevel, LogType, type LogEntry } from "@/cp/shared/Logger";

type ViewerEntry = LogEntry & { cpId?: string };

// vitest doesn't run with `globals: true` in this repo, so
// @testing-library/react's auto-cleanup-on-afterEach detection never fires
// (it looks for a global `afterEach`). Without this, every `render()` in
// this file would pile onto the same jsdom document, and later tests'
// `screen.getByText` queries would match leftover nodes from earlier tests.
afterEach(() => {
  cleanup();
});

/** Finds a sidebar filter option's `<label>` by its group and text (e.g.
 *  group "Direction", option "Sent"). Scoped to the group because option
 *  labels collide across groups (e.g. "Heartbeat" is both a LogType and an
 *  OCPP action name). Groups carry `data-filter-group`, options
 *  `data-filter-option`. */
function findFilterOptionRow(
  groupHeading: string,
  optionLabel: string,
): HTMLLabelElement {
  const group = document.querySelector(`[data-filter-group="${groupHeading}"]`);
  if (!group) {
    throw new Error(`No filter group found for heading "${groupHeading}"`);
  }
  const match = group.querySelector<HTMLLabelElement>(
    `label[data-filter-option="${optionLabel}"]`,
  );
  if (!match) {
    throw new Error(
      `No filter option "${optionLabel}" found in group "${groupHeading}"`,
    );
  }
  return match;
}

function clickFilterOption(groupHeading: string, optionLabel: string) {
  const checkbox = findFilterOptionRow(groupHeading, optionLabel).querySelector(
    'input[type="checkbox"]',
  );
  if (!checkbox) {
    throw new Error(`No checkbox found for filter option "${optionLabel}"`);
  }
  fireEvent.click(checkbox);
}

function entry(
  message: string,
  overrides: Partial<ViewerEntry> = {},
): ViewerEntry {
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

describe("LogViewer toolbar (#405)", () => {
  // jsdom has no layout, so a clipped toolbar cannot be measured here. The
  // wrapping classes are the regression guard: without `flex-wrap` the bar
  // and its action buttons overflowed and clipped in a narrow container.
  it("lets the title row and the action groups wrap instead of clipping", () => {
    render(
      <LogViewer
        logs={[entry('Sent: [2, "1", "Heartbeat", {}]')]}
        onClear={() => undefined}
        onDownload={() => undefined}
      />,
    );

    const bar = screen.getByTestId("log-toolbar");
    expect(bar.className).toContain("flex-wrap");
    expect(
      screen.getByText("Logs", { selector: "h3" }).parentElement?.className,
    ).toContain("flex-wrap");
    expect(
      screen.getByText("Download").closest("[data-toolbar-actions]")?.className,
    ).toContain("flex-wrap");
  });

  it("shows total / filtered counts, Auto-scroll and the three actions", () => {
    render(
      <LogViewer
        logs={[entry("a"), entry("b")]}
        onClear={() => undefined}
        onDownload={() => undefined}
      />,
    );
    expect(screen.getByTestId("log-toolbar").textContent).toContain(
      "2 total / 2 filtered",
    );
    expect(screen.getByLabelText("Auto-scroll")).toBeTruthy();
    for (const name of ["Download", "Clear screen", "Clear screen + DB"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
  });

  it("hides Download and Clear when no handler is given", () => {
    render(<LogViewer logs={[entry("a")]} />);
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear screen" })).toBeNull();
  });

  it("reports the clear scope and calls onDownload", () => {
    const onClear = vi.fn<(scope: ClearLogsScope) => void>();
    const onDownload = vi.fn();
    render(
      <LogViewer
        logs={[entry("a")]}
        onClear={onClear}
        onDownload={onDownload}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear screen" }));
    expect(onClear).toHaveBeenLastCalledWith("screen");
    fireEvent.click(screen.getByRole("button", { name: "Clear screen + DB" }));
    expect(onClear).toHaveBeenLastCalledWith("all");
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(onDownload).toHaveBeenCalledTimes(1);
  });
});

describe("LogViewer auto-scroll", () => {
  it("scrolls the table to the bottom when rows arrive, until Auto-scroll is unchecked", () => {
    const scrollTo = vi.fn();
    const original = Element.prototype.scrollTo;
    Element.prototype.scrollTo = scrollTo as unknown as typeof original;
    try {
      const { rerender } = render(<LogViewer logs={[entry("one")]} />);
      expect(scrollTo).toHaveBeenCalled();

      fireEvent.click(screen.getByLabelText("Auto-scroll"));
      scrollTo.mockClear();
      rerender(<LogViewer logs={[entry("one"), entry("two")]} />);
      expect(scrollTo).not.toHaveBeenCalled();
    } finally {
      Element.prototype.scrollTo = original;
    }
  });
});

describe("LogViewer level and type filters", () => {
  const logs = () => [
    entry("debug line", { level: LogLevel.DEBUG, type: LogType.GENERAL }),
    entry("warn line", { level: LogLevel.WARN, type: LogType.HEARTBEAT }),
    entry("error line", { level: LogLevel.ERROR, type: LogType.HEARTBEAT }),
  ];

  it("filters by level and shows per-level counts", () => {
    const { container } = render(<LogViewer logs={logs()} />);
    expect(findFilterOptionRow("Level", "WARN").textContent).toContain("1");

    clickFilterOption("Level", "ERROR");
    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("error line");
    expect(screen.getByTestId("log-toolbar").textContent).toContain(
      "3 total / 1 filtered",
    );
  });

  it("filters by type and counts per type", () => {
    const { container } = render(<LogViewer logs={logs()} />);
    expect(findFilterOptionRow("Type", "Heartbeat").textContent).toContain("2");
    clickFilterOption("Type", "Heartbeat");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
  });

  it("the search box narrows by message text", () => {
    const { container } = render(<LogViewer logs={logs()} />);
    fireEvent.change(screen.getByPlaceholderText("Search in messages..."), {
      target: { value: "WARN" },
    });
    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("warn line");
  });

  it("filters by the connector a message names", () => {
    const { container } = render(
      <LogViewer
        logs={[
          entry('Sent: [2,"1","StatusNotification",{"connectorId":2}]'),
          entry("Handling connector 3 reset"),
          entry("no connector here"),
        ]}
      />,
    );
    clickFilterOption("Connector", "Connector 2");
    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("StatusNotification");
  });

  it("group headings collapse their options", () => {
    render(<LogViewer logs={logs()} />);
    const group = document.querySelector('[data-filter-group="Level"]')!;
    const heading = group.querySelector("button[aria-expanded]")!;
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(heading);
    expect(heading.getAttribute("aria-expanded")).toBe("false");
    expect(group.querySelector("label")).toBeNull();
  });
});

describe("LogViewer restyle", () => {
  it("uses console tokens only: no raw palette classes, no filled badges", () => {
    const { container } = render(
      <LogViewer
        logs={[
          entry(`Sent: ${JSON.stringify([2, "1", "Heartbeat", {}])}`, {
            level: LogLevel.ERROR,
            cpId: "CP-A",
          }),
        ]}
        onClear={() => undefined}
        onDownload={() => undefined}
      />,
    );
    expect(container.innerHTML).not.toMatch(
      /\b(?:bg|text|border|ring)-(?:gray|blue|sky|amber|red|green|purple|pink|slate|zinc)-\d/,
    );
    // Status dots, not the filled `.log-*` / Badge look.
    expect(container.innerHTML).not.toMatch(/\blog-(?:ocpp|level-)/);
    const row = container.querySelector("tbody tr")!;
    expect(row.querySelector("[data-level-dot]")).toBeTruthy();
    expect(row.querySelector("[data-direction-dot]")).toBeTruthy();
  });

  it("sets Timestamp and Action in a monospace face", () => {
    const { container } = render(
      <LogViewer
        logs={[entry(`Sent: ${JSON.stringify([2, "1", "Heartbeat", {}])}`)]}
      />,
    );
    const cells = container.querySelectorAll("tbody tr td");
    const byText = (text: string) =>
      Array.from(cells).find((c) => c.textContent?.includes(text))!;
    expect(byText("10:00:00.000").className).toContain("font-mono");
    expect(byText("Heartbeat").className).toContain("font-mono");
  });
});

describe("LogViewer row detail", () => {
  const withJson = entry('Received: {"code":1006,"nested":{"a":1}} end');

  it("a chevron expands the row to the pretty-printed message and collapses it again", () => {
    const { container } = render(<LogViewer logs={[withJson]} />);
    expect(container.querySelector("pre")).toBeNull();

    const toggle = screen.getByRole("button", { name: "Show details" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);

    const pre = container.querySelector("pre")!;
    expect(pre.textContent).toContain('"code": 1006');
    expect(pre.textContent).toContain('"a": 1');
    const hide = screen.getByRole("button", { name: "Hide details" });
    expect(hide.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(hide);
    expect(container.querySelector("pre")).toBeNull();
  });

  it("keeps a row expanded while newer rows arrive", () => {
    const { container, rerender } = render(<LogViewer logs={[withJson]} />);
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    rerender(<LogViewer logs={[withJson, entry("newer")]} />);
    expect(container.querySelectorAll("pre")).toHaveLength(1);
    expect(container.querySelector("pre")?.textContent).toContain(
      '"code": 1006',
    );
  });

  it("leaves a message without JSON as it is", () => {
    const { container } = render(<LogViewer logs={[entry("plain {text")]} />);
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    expect(container.querySelector("pre")?.textContent).toBe("plain {text");
  });
});

describe("LogViewer charge point group", () => {
  const logs = () => [
    entry("from a1", { cpId: "CP-A" }),
    entry("from a2", { cpId: "CP-A" }),
    entry("from b", { cpId: "CP-B" }),
  ];

  it("has no Charge point group or column for entries without a cpId", () => {
    const { container } = render(<LogViewer logs={[entry("plain")]} />);
    expect(
      document.querySelector('[data-filter-group="Charge point"]'),
    ).toBeNull();
    expect(container.querySelector("thead")?.textContent).not.toContain(
      "Charge point",
    );
  });

  it("derives a group with a count per charge point and filters by it", () => {
    const { container } = render(<LogViewer logs={logs()} />);
    expect(findFilterOptionRow("Charge point", "CP-A").textContent).toContain(
      "2",
    );
    expect(findFilterOptionRow("Charge point", "CP-B").textContent).toContain(
      "1",
    );
    expect(container.querySelector("thead")?.textContent).toContain(
      "Charge point",
    );

    clickFilterOption("Charge point", "CP-B");
    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("CP-B");
    expect(rows[0].textContent).toContain("from b");

    // Two selected: either.
    clickFilterOption("Charge point", "CP-A");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
  });

  it("is controlled by selectedConnectorIds / onConnectorFilterChange", () => {
    const onChange = vi.fn();
    const { container } = render(
      <LogViewer
        logs={[
          entry('Sent: [2,"1","StatusNotification",{"connectorId":2}]'),
          entry("Handling connector 3 reset"),
          entry("no connector here"),
        ]}
        selectedConnectorIds={[2]}
        onConnectorFilterChange={onChange}
      />,
    );
    const rows = () => container.querySelectorAll("tbody tr");
    expect(rows()).toHaveLength(1);
    expect(rows()[0].textContent).toContain("StatusNotification");
    expect(
      findFilterOptionRow(
        "Connector",
        "Connector 2",
      ).querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked,
    ).toBe(true);

    clickFilterOption("Connector", "Connector 3");
    expect(onChange).toHaveBeenLastCalledWith([2, 3]);
    clickFilterOption("Connector", "Connector 2");
    expect(onChange).toHaveBeenLastCalledWith([]);
    // Controlled: nothing changed until the owner passes the new value.
    expect(rows()).toHaveLength(1);
  });

  it("is controlled by selectedCpIds / onCpFilterChange, and lists a selected id that has no entries", () => {
    const onChange = vi.fn();
    const { container } = render(
      <LogViewer
        logs={logs()}
        selectedCpIds={["CP-gone"]}
        onCpFilterChange={onChange}
      />,
    );
    const gone = findFilterOptionRow("Charge point", "CP-gone");
    expect(gone.textContent).toContain("0");
    expect(
      gone.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked,
    ).toBe(true);
    const bodyText = () => container.querySelector("tbody")?.textContent;
    expect(bodyText()).toContain("No logs match the current filters");

    clickFilterOption("Charge point", "CP-A");
    expect(onChange).toHaveBeenLastCalledWith(["CP-gone", "CP-A"]);
    // Controlled: nothing changed until the owner passes the new value.
    expect(bodyText()).not.toContain("from a1");
  });
});

describe("LogViewer filter sidebar toggle", () => {
  const logs = () => [
    entry(`Sent: ${JSON.stringify([2, "1", "BootNotification", {}])}`),
    entry("unrelated general log line — no direction/action"),
  ];
  const sidebar = (container: HTMLElement) =>
    container.querySelector<HTMLElement>("[data-filter-group]")!.parentElement!
      .parentElement!;
  const filtersButton = () =>
    screen.getByRole("button", { name: "Filters" }) as HTMLButtonElement;

  it("is open by default and the Filters button hides and shows it", () => {
    const { container } = render(<LogViewer logs={logs()} />);
    expect(sidebar(container).hasAttribute("hidden")).toBe(false);
    expect(filtersButton().getAttribute("aria-pressed")).toBe("true");
    expect(filtersButton().getAttribute("aria-controls")).toBe(
      sidebar(container).id,
    );
    // The button leads the toolbar's left group, before the Logs heading.
    const left = screen.getByTestId("log-toolbar").firstElementChild!;
    expect(left.firstElementChild).toBe(filtersButton());

    fireEvent.click(filtersButton());
    expect(sidebar(container).hasAttribute("hidden")).toBe(true);
    expect(filtersButton().getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(filtersButton());
    expect(sidebar(container).hasAttribute("hidden")).toBe(false);
    expect(filtersButton().getAttribute("aria-pressed")).toBe("true");
  });

  it("defaultFiltersOpen={false} starts it closed; a hidden active filter shows as a count badge", () => {
    const { container } = render(
      <LogViewer logs={logs()} defaultFiltersOpen={false} />,
    );
    expect(sidebar(container).hasAttribute("hidden")).toBe(true);
    expect(filtersButton().getAttribute("aria-pressed")).toBe("false");
    expect(filtersButton().textContent).toBe("Filters");

    fireEvent.click(filtersButton());
    clickFilterOption("Direction", "Sent");
    // Open: no badge, the sidebar shows the selection itself.
    expect(filtersButton().textContent).toBe("Filters");

    fireEvent.click(filtersButton());
    expect(sidebar(container).hasAttribute("hidden")).toBe(true);
    expect(filtersButton().textContent).toBe("Filters1");
    // The filter still applies, and it survives reopening (kept mounted).
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
    fireEvent.click(filtersButton());
    expect(
      findFilterOptionRow("Direction", "Sent").querySelector<HTMLInputElement>(
        'input[type="checkbox"]',
      )!.checked,
    ).toBe(true);
  });

  it("the badge counts the groups with a selection, not the values", () => {
    render(<LogViewer logs={logs()} />);
    clickFilterOption("Direction", "Sent");
    clickFilterOption("Level", "INFO");
    clickFilterOption("Level", "DEBUG");
    fireEvent.click(filtersButton());
    expect(filtersButton().textContent).toBe("Filters2");
  });
});
