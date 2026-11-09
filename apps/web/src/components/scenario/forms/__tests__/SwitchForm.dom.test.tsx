// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import SwitchForm from "../SwitchForm";
import type { NodeFormData } from "../types";

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

async function render(
  value: NodeFormData,
  onChange: (next: NodeFormData) => void,
): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(<SwitchForm value={value} onChange={onChange} />),
  );
  return container;
}

const matchCases = [
  "Accepted",
  { $match: { in: ["Blocked", "Invalid", "Expired"] } },
  { $match: { gte: 80 } },
  { $match: { exists: false } },
];

describe("SwitchForm $match cases (schema 1.7)", () => {
  it("shows a $match case as a short read-only chip, not as a JSON field", async () => {
    const c = await render(
      { value: { $from: "response.kind" }, cases: matchCases },
      () => undefined,
    );
    const chip = (i: number) =>
      c.querySelector(`[data-testid="switch-case-match-${i}"] code`)
        ?.textContent;
    expect(c.querySelector('[data-testid="switch-case-match-0"]')).toBeNull();
    expect(chip(1)).toBe("in Blocked|Invalid|Expired");
    expect(chip(2)).toBe("≥ 80");
    expect(chip(3)).toBe("missing");
    // The matcher has no input of its own.
    expect(
      c.querySelector('[data-testid="switch-case-match-1"] input, textarea'),
    ).toBeNull();
  });

  it("keeps every $match case unchanged when another case is changed or one is added", async () => {
    const seen: NodeFormData[] = [];
    const c = await render(
      { value: { $from: "response.kind" }, cases: matchCases },
      (next) => seen.push(next),
    );
    const add = [...c.querySelectorAll("button")].find((b) =>
      /add/i.test(b.textContent ?? ""),
    )!;
    await act(async () => add.click());
    const next = seen.at(-1)!;
    expect((next.cases as unknown[]).slice(0, 4)).toEqual(matchCases);
    expect((next.cases as unknown[]).length).toBe(5);
  });
});
