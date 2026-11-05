// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import OcppCallForm from "../OcppCallForm";

let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  const current = root;
  if (current) await act(async () => current.unmount());
  root = null;
  document.body.replaceChildren();
});

async function render(payload: unknown): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <OcppCallForm
        value={{ label: "Call", action: "Heartbeat", payload }}
        onChange={() => undefined}
      />,
    ),
  );
  return container;
}

describe("OcppCallForm (#389)", () => {
  it.each([
    ["an array", []],
    ["null", null],
    ["unparsed text", '{"a":'],
  ])("flags %s as a payload and keeps the text", async (_label, payload) => {
    const c = await render(payload);
    expect(c.querySelector('[role="alert"]')?.textContent).toContain(
      "must be a JSON object",
    );
    const text = c.querySelector("textarea")!.value;
    expect(text).toBe(
      typeof payload === "string" ? payload : JSON.stringify(payload),
    );
  });

  it("raises no error for an object payload", async () => {
    const c = await render({});
    expect(c.querySelector('[role="alert"]')).toBeNull();
  });
});
