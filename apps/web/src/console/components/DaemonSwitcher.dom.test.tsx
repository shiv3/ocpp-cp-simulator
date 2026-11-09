// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import "../../i18n";
import DaemonSwitcher from "./DaemonSwitcher";
import { DataContext } from "../../data/providers/DataProvider";
import { createFakeChargePointService } from "../test/harness";
import { SAVED_DAEMONS_KEY } from "../../data/savedDaemons";

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function mount(
  mode: "local" | "remote",
  switchDaemon: (url: string) => Promise<void>,
  serverUrl = "http://origin:9700",
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <DataContext.Provider
        value={{
          mode,
          serverUrl,
          originUrl: "http://origin:9700",
          switchDaemon: mode === "remote" ? switchDaemon : undefined,
          defaultEvSettings: null,
          setDefaultEvSettings: () => {},
          chargePointService: createFakeChargePointService(),
        }}
      >
        <DaemonSwitcher />
      </DataContext.Provider>,
    );
  });
  return { container, root };
}

const click = async (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no button ${label}`);
  return found;
}

describe("DaemonSwitcher (#619)", () => {
  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => {
    document.body.innerHTML = "";
    window.localStorage.clear();
  });

  it("renders nothing in Local mode", async () => {
    await mount("local", vi.fn());
    expect(
      document.querySelector('[data-testid="daemon-switcher"]'),
    ).toBeNull();
  });

  it("saves an address, persists it and switches to it", async () => {
    const switchDaemon = vi.fn(async () => undefined);
    await mount("remote", switchDaemon);
    await click(button("Add daemon"));
    const [address] = Array.from(document.querySelectorAll("input"));
    await act(async () => setInput(address, "10.1.1.1:9700"));
    await click(button("Save and switch"));
    expect(switchDaemon).toHaveBeenCalledWith("http://10.1.1.1:9700");
    expect(JSON.parse(window.localStorage.getItem(SAVED_DAEMONS_KEY)!)).toEqual(
      [{ url: "http://10.1.1.1:9700", name: "" }],
    );
    const options = Array.from(document.querySelectorAll("option")).map(
      (o) => o.value,
    );
    expect(options).toEqual(["http://origin:9700", "http://10.1.1.1:9700"]);
  });

  it("says so when a switch fails and keeps the selection", async () => {
    window.localStorage.setItem(
      SAVED_DAEMONS_KEY,
      JSON.stringify([{ url: "http://down:1", name: "Down" }]),
    );
    const switchDaemon = vi.fn(async () => {
      throw new Error("unreachable");
    });
    await mount("remote", switchDaemon);
    const select = document.querySelector("select")!;
    await act(async () => {
      select.value = "http://down:1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "http://down:1",
    );
    // serverUrl in context did not change, so the select is back on the origin
    expect(select.value).toBe("http://origin:9700");
  });

  it("rejects an address with credentials", async () => {
    const switchDaemon = vi.fn(async () => undefined);
    await mount("remote", switchDaemon);
    await click(button("Add daemon"));
    const [address] = Array.from(document.querySelectorAll("input"));
    await act(async () => setInput(address, "http://u:p@h:1"));
    await click(button("Save and switch"));
    expect(switchDaemon).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });
});
