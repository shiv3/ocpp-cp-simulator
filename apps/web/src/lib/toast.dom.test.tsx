// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppToaster } from "@/components/ui/sonner";
import { DarkModeProvider } from "@/contexts/DarkModeContext";
import { notify, toastId } from "./toast";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;

const settle = () =>
  act(async () => void (await new Promise((r) => setTimeout(r, 30))));
const toasts = () => host.ownerDocument.querySelectorAll("[data-sonner-toast]");

beforeEach(async () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <DarkModeProvider>
        <AppToaster />
      </DarkModeProvider>,
    );
  });
});

afterEach(async () => {
  await act(async () => notify.dismiss());
  await act(async () => root.unmount());
  host.remove();
  document.documentElement.classList.remove("dark");
});

describe("notify / AppToaster", () => {
  it("renders each kind and exposes one labelled live region", async () => {
    await act(async () => {
      notify.success("saved");
      notify.error("broke");
      notify.warning("careful");
      notify.info("fyi");
    });
    await settle();
    const types = [...toasts()].map((t) => t.getAttribute("data-type")).sort();
    expect(types).toEqual(["error", "info", "success", "warning"]);
    const regions = document.querySelectorAll("section[aria-label]");
    expect(regions).toHaveLength(1);
    expect(regions[0].getAttribute("aria-label")).toContain("Notifications");
    expect(regions[0].getAttribute("aria-live")).toBe("polite");
  });

  it("collapses identical repeats and never lets a success replace an error", async () => {
    await act(async () => {
      notify.error("Failed to save");
      notify.error("Failed to save");
      notify.error("Failed to save");
      notify.success("Saved other CP");
    });
    await settle();
    const text = [...toasts()].map((t) => t.textContent ?? "");
    expect(text.filter((t) => t.includes("Failed to save"))).toHaveLength(1);
    expect(text.filter((t) => t.includes("Saved other CP"))).toHaveLength(1);
    expect(toastId("error", "x")).not.toBe(toastId("success", "x"));
  });

  it("dismisses on the close button", async () => {
    await act(async () => void notify.info("closable"));
    await settle();
    const close = document.querySelector<HTMLButtonElement>(
      "[data-close-button]",
    )!;
    await act(async () => close.click());
    await act(async () => void (await new Promise((r) => setTimeout(r, 500))));
    expect(document.body.textContent).not.toContain("closable");
  });

  it("moves a promise from pending to success, and to error", async () => {
    let resolve!: (v: number) => void;
    const ok = new Promise<number>((r) => (resolve = r));
    await act(async () => {
      void notify.promise(ok, {
        loading: "Working",
        success: (n) => `Done ${n}`,
        error: "nope",
      });
    });
    await settle();
    expect(document.body.textContent).toContain("Working");
    await act(async () => resolve(3));
    await settle();
    expect(document.body.textContent).toContain("Done 3");
    expect(document.body.textContent).not.toContain("Working");

    const bad = Promise.reject(new Error("kaput"));
    await act(async () => {
      notify
        .promise(bad, {
          loading: "Again",
          success: "fine",
          error: (e) => `Failed: ${(e as Error).message}`,
        })
        .catch(() => {});
    });
    await settle();
    expect(document.body.textContent).toContain("Failed: kaput");
  });

  it("keeps overlapping promises as separate toasts", async () => {
    await act(async () => {
      void notify.promise(new Promise(() => {}), {
        loading: "first",
        success: "a",
        error: "a",
      });
      void notify.promise(new Promise(() => {}), {
        loading: "second",
        success: "b",
        error: "b",
      });
    });
    await settle();
    expect(toasts()).toHaveLength(2);
  });

  it("follows the console theme", async () => {
    document.documentElement.classList.add("dark");
    localStorage.setItem("theme", "dark");
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () =>
      root.render(
        <DarkModeProvider>
          <AppToaster />
        </DarkModeProvider>,
      ),
    );
    await act(async () => void notify.info("themed"));
    await settle();
    expect(
      document
        .querySelector("[data-sonner-toaster]")
        ?.getAttribute("data-sonner-theme"),
    ).toBe("dark");
    localStorage.removeItem("theme");
  });
});
