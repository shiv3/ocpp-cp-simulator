// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { LogLevel, LogType, type LogEntry } from "../../../cp/shared/Logger";
import CompactLogList, { MAX_ROWS } from "./CompactLogList";

function entry(message: string, at = "2026-07-12T10:00:03"): LogEntry {
  return {
    timestamp: new Date(at),
    level: LogLevel.INFO,
    type: LogType.OCPP,
    message,
  };
}

describe("CompactLogList", () => {
  let root: Root | null = null;
  let container: HTMLElement;

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = "";
  });

  async function render(logs: LogEntry[]) {
    if (!root) {
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
    }
    await act(async () => {
      root!.render(<CompactLogList logs={logs} />);
    });
  }
  const rows = () =>
    Array.from(container.querySelectorAll<HTMLElement>("[data-log-row]"));

  it("shows time, direction arrow, action and payload of wire frames; a result takes its call's action", async () => {
    await render([
      entry('Sent: [2,"7","BootNotification",{"chargePointVendor":"Acme"}]'),
      entry('Received: [3,"7",{"status":"Accepted"}]'),
      entry('Received: [2,"8","Reset",{"type":"Soft"}]'),
    ]);

    expect(rows()).toHaveLength(3);
    expect(rows()[0].textContent).toContain("10:00:03");
    expect(rows()[0].textContent).toContain("↑");
    expect(rows()[0].textContent).toContain("BootNotification");
    expect(rows()[0].textContent).toContain('"chargePointVendor":"Acme"');
    // The payload, not the "Sent: " transport prefix.
    expect(rows()[0].textContent).not.toContain("Sent:");
    expect(rows()[1].textContent).toContain("↓");
    expect(rows()[1].textContent).toContain("BootNotification");
    expect(rows()[2].textContent).toContain("Reset");
  });

  it("colors the arrows by direction with the console tokens", async () => {
    await render([
      entry('Sent: [2,"1","Heartbeat",{}]'),
      entry('Received: [3,"1",{}]'),
    ]);

    const arrows = container.querySelectorAll<HTMLElement>("[data-direction]");
    expect(arrows[0].dataset.direction).toBe("sent");
    expect(arrows[0].className).toContain("text-cx-accent");
    expect(arrows[1].dataset.direction).toBe("received");
    expect(arrows[1].className).toContain("text-cx-emerald");
  });

  it("lists a line that is not wire traffic by its message, without an arrow", async () => {
    await render([entry("WebSocket connected")]);

    expect(rows()[0].textContent).toContain("WebSocket connected");
    expect(rows()[0].querySelector("[data-direction]")).toBeNull();
  });

  it("says so when there is nothing to show", async () => {
    await render([]);

    expect(container.textContent).toContain("No messages yet");
    expect(rows()).toHaveLength(0);
  });

  it("renders the newest rows only when the log is longer than MAX_ROWS", async () => {
    const logs = Array.from({ length: MAX_ROWS + 5 }, (_, i) =>
      entry(`line ${i}`),
    );
    await render(logs);

    expect(rows()).toHaveLength(MAX_ROWS);
    expect(rows().at(-1)!.textContent).toContain(`line ${MAX_ROWS + 4}`);
    expect(container.textContent).toContain(
      `latest ${MAX_ROWS} of ${MAX_ROWS + 5}`,
    );
  });

  it("scrolls to the newest row when one arrives, unless the reader scrolled up", async () => {
    // jsdom has no layout: give the scroller a height so "at the bottom" means something.
    const heights = { scrollHeight: 1000, clientHeight: 300 };
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => heights.scrollHeight,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => heights.clientHeight,
    });
    try {
      await render([entry("one")]);
      const scroller = container.querySelector<HTMLElement>(
        '[data-testid="compact-log-scroller"]',
      )!;
      expect(scroller.scrollTop).toBe(1000);

      // The reader scrolls up: new lines must not yank the view down.
      scroller.scrollTop = 100;
      await act(async () => {
        scroller.dispatchEvent(new Event("scroll"));
      });
      heights.scrollHeight = 1200;
      await render([entry("one"), entry("two")]);
      expect(scroller.scrollTop).toBe(100);

      // Back at the bottom: following resumes.
      scroller.scrollTop = 900;
      await act(async () => {
        scroller.dispatchEvent(new Event("scroll"));
      });
      heights.scrollHeight = 1400;
      await render([entry("one"), entry("two"), entry("three")]);
      expect(scroller.scrollTop).toBe(1400);
    } finally {
      const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
      delete proto.scrollHeight;
      delete proto.clientHeight;
    }
  });
});
