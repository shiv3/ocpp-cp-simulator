// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { useLaneDrag, type LaneDrag } from "./useLaneDrag";

// Three 50px rows, centres at 25 / 75 / 125.
const CENTRES = [25, 75, 125];
const IDS = ["a", "b", "c"];

let root: Root | null = null;
let container: HTMLElement;
let lastDrag: LaneDrag | null = null;
const onDrop = vi.fn();

const Harness: React.FC = () => {
  const { drag, handlers } = useLaneDrag({
    measure: () => CENTRES,
    onDrop,
  });
  lastDrag = drag;
  return (
    <ul>
      {IDS.map((id, index) => (
        <li key={id} data-id={id} {...handlers({ id, lane: "main", index })}>
          {id}
        </li>
      ))}
    </ul>
  );
};

function pointer(type: string, el: Element, clientY: number) {
  act(() => {
    el.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerId: 1,
        clientY,
      }),
    );
  });
}

const row = (id: string) => container.querySelector(`[data-id="${id}"]`)!;

describe("useLaneDrag", () => {
  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    lastDrag = null;
    onDrop.mockReset();
    document.body.innerHTML = "";
  });

  async function render() {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(<Harness />));
  }

  it("does not start a drag until the pointer moved more than 6 px", async () => {
    await render();
    pointer("pointerdown", row("a"), 25);
    pointer("pointermove", row("a"), 31);
    expect(lastDrag).toBeNull();
    pointer("pointerup", row("a"), 31);
    // A click, not a drop.
    expect(onDrop).not.toHaveBeenCalled();

    pointer("pointerdown", row("a"), 25);
    pointer("pointermove", row("a"), 32);
    expect(lastDrag).toMatchObject({ id: "a", from: 0, to: 0, offset: 7 });
  });

  it("tracks the index the item would land at while moving", async () => {
    await render();
    pointer("pointerdown", row("a"), 25);
    pointer("pointermove", row("a"), 60);
    // Centre now at 60: still above b's centre.
    expect(lastDrag?.to).toBe(0);
    pointer("pointermove", row("a"), 90);
    expect(lastDrag?.to).toBe(1);
    pointer("pointermove", row("a"), 200);
    expect(lastDrag?.to).toBe(2);
    // And upward for the last item.
    pointer("pointerup", row("a"), 200);
    pointer("pointerdown", row("c"), 125);
    pointer("pointermove", row("c"), 10);
    expect(lastDrag).toMatchObject({ id: "c", from: 2, to: 0 });
  });

  it("applies the move on release", async () => {
    await render();
    pointer("pointerdown", row("a"), 25);
    pointer("pointermove", row("a"), 100);
    pointer("pointerup", row("a"), 100);
    expect(onDrop).toHaveBeenCalledWith("a", "main", 0, 1);
    expect(lastDrag).toBeNull();
  });

  it("a release where it started is not a move", async () => {
    await render();
    pointer("pointerdown", row("b"), 75);
    pointer("pointermove", row("b"), 90);
    pointer("pointerup", row("b"), 80);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("Escape cancels the drag, and keeps the key from closing a panel", async () => {
    await render();
    const outer = vi.fn((event: KeyboardEvent) => event.defaultPrevented);
    document.addEventListener("keydown", outer);
    pointer("pointerdown", row("a"), 25);
    pointer("pointermove", row("a"), 140);
    expect(lastDrag?.to).toBe(2);

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(lastDrag).toBeNull();
    expect(outer.mock.results[0]?.value).toBe(true);

    pointer("pointerup", row("a"), 140);
    expect(onDrop).not.toHaveBeenCalled();
    document.removeEventListener("keydown", outer);
  });
});
