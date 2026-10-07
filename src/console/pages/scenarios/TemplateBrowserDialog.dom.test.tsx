// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { scenarioTemplates } from "../../../utils/scenarioTemplates";
import { flush } from "../../test/harness";
import TemplateGallery from "./TemplateGallery";

let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = null;
  }
  document.body.innerHTML = "";
});

async function renderGallery() {
  const onUseTemplate = vi.fn();
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(<TemplateGallery onUseTemplate={onUseTemplate} />),
  );
  return { host, onUseTemplate };
}

function browseButton(): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll("button")).find((b) =>
    /^Browse all \d+ templates$/.test(b.textContent?.trim() ?? ""),
  );
}

function dialog(): HTMLElement | null {
  return document.body.querySelector('[role="dialog"]');
}

function rows(): HTMLElement[] {
  return Array.from(
    dialog()?.querySelectorAll<HTMLElement>("[data-template-id]") ?? [],
  );
}

function search(): HTMLInputElement {
  const input = dialog()?.querySelector<HTMLInputElement>(
    'input[type="search"], input[aria-label="Search templates"]',
  );
  if (!input) throw new Error("no template search input");
  return input;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function openBrowser() {
  await act(async () => browseButton()!.click());
  await flush(10);
}

describe("TemplateBrowserDialog", () => {
  it("opens from a Browse all button that names the template count", async () => {
    await renderGallery();
    const button = browseButton();
    expect(button?.textContent?.trim()).toBe(
      `Browse all ${scenarioTemplates.length} templates`,
    );
    expect(dialog()).toBeNull();

    await openBrowser();
    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain("Scenario templates");
    expect(dialog()!.textContent).toContain(
      `${scenarioTemplates.length} of ${scenarioTemplates.length}`,
    );
    // The "only in the scenario editor" note is gone.
    expect(document.body.textContent).not.toContain(
      "more available in the scenario editor",
    );
  });

  it("lists every template, each with its target type and a Use template button", async () => {
    await renderGallery();
    await openBrowser();

    const list = rows();
    expect(list).toHaveLength(scenarioTemplates.length);
    const first = list[0];
    expect(first.textContent).toContain(scenarioTemplates[0].name);
    expect(first.textContent).toContain(scenarioTemplates[0].targetType);
    expect(
      Array.from(first.querySelectorAll("button")).map((b) =>
        b.textContent?.trim(),
      ),
    ).toEqual(["Use template"]);
  });

  it("focuses the search and narrows the list by name and description, ignoring case", async () => {
    await renderGallery();
    await openBrowser();
    expect(document.activeElement).toBe(search());

    await act(async () => setInputValue(search(), "CERT"));
    const expected = scenarioTemplates.filter((t) =>
      `${t.name}\n${t.description}`.toLowerCase().includes("cert"),
    );
    expect(expected.length).toBeGreaterThan(0);
    expect(rows().map((r) => r.dataset.templateId)).toEqual(
      expected.map((t) => t.id),
    );
    expect(dialog()!.textContent).toContain(
      `${expected.length} of ${scenarioTemplates.length}`,
    );

    await act(async () => setInputValue(search(), "no such template xyz"));
    expect(rows()).toHaveLength(0);
    expect(dialog()!.textContent).toContain(`0 of ${scenarioTemplates.length}`);
  });

  it("Use template on a row hands that template over and closes the dialog", async () => {
    const { onUseTemplate } = await renderGallery();
    await openBrowser();

    const target = scenarioTemplates[scenarioTemplates.length - 1];
    const row = rows().find((r) => r.dataset.templateId === target.id)!;
    await act(async () =>
      Array.from(row.querySelectorAll("button"))
        .find((b) => b.textContent?.trim() === "Use template")!
        .click(),
    );
    await flush(10);

    expect(onUseTemplate).toHaveBeenCalledTimes(1);
    expect(onUseTemplate).toHaveBeenCalledWith(target);
    expect(dialog()).toBeNull();
  });

  it("Enter in the search uses the first visible template", async () => {
    const { onUseTemplate } = await renderGallery();
    await openBrowser();

    await act(async () => setInputValue(search(), "cert"));
    const firstVisible = rows()[0].dataset.templateId;
    await act(async () => {
      search().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await flush(10);

    expect(onUseTemplate).toHaveBeenCalledTimes(1);
    expect(onUseTemplate.mock.calls[0][0].id).toBe(firstVisible);
    expect(dialog()).toBeNull();
  });

  it("Enter with no match does nothing", async () => {
    const { onUseTemplate } = await renderGallery();
    await openBrowser();

    await act(async () => setInputValue(search(), "zzzz-none"));
    await act(async () => {
      search().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(onUseTemplate).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
  });

  it("starts with an empty search each time it opens", async () => {
    await renderGallery();
    await openBrowser();
    await act(async () => setInputValue(search(), "cert"));
    await act(async () => {
      Array.from(dialog()!.querySelectorAll("button"))
        .find((b) => b.textContent?.trim() === "Close")!
        .click();
    });
    await flush(10);
    expect(dialog()).toBeNull();

    await openBrowser();
    expect(search().value).toBe("");
    expect(rows()).toHaveLength(scenarioTemplates.length);
  });
});
