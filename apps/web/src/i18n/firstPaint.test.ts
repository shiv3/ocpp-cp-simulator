import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18N_FIRST_PAINT_WAIT_MS, awaitI18nFirstPaint } from "./firstPaint";

/** A stand-in for the language load: the locale on screen starts as English
 * and flips when the "chunk" arrives, as i18next does on `languageChanged`. */
function fakeLoad() {
  const state = { locale: "en" };
  let finish!: () => void;
  let fail!: (e: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    finish = () => {
      state.locale = "ja";
      resolve();
    };
    fail = reject;
  });
  return { state, ready, finish, fail };
}

async function paint(ready: Promise<unknown>) {
  const painted = { at: null as string | null };
  const done = awaitI18nFirstPaint(ready).then(() => {
    painted.at = "painted";
  });
  return { painted, done };
}

describe("awaitI18nFirstPaint (#899)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for a chunk that arrives before the bound: first paint translated", async () => {
    const load = fakeLoad();
    const { done } = await paint(load.ready);
    await vi.advanceTimersByTimeAsync(I18N_FIRST_PAINT_WAIT_MS - 1);
    load.finish();
    await done;
    expect(load.state.locale).toBe("ja");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renders in English past the bound, the language switches when the chunk arrives", async () => {
    const load = fakeLoad();
    const { painted, done } = await paint(load.ready);
    await vi.advanceTimersByTimeAsync(I18N_FIRST_PAINT_WAIT_MS - 1);
    expect(painted.at).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(painted.at).toBe("painted");
    expect(load.state.locale).toBe("en");
    load.finish();
    expect(load.state.locale).toBe("ja");
  });

  it("does not hang on a chunk that never settles", async () => {
    const { painted, done } = await paint(new Promise<void>(() => {}));
    await vi.advanceTimersByTimeAsync(I18N_FIRST_PAINT_WAIT_MS);
    await done;
    expect(painted.at).toBe("painted");
  });

  it("does not reject when the load fails", async () => {
    const load = fakeLoad();
    const { done } = await paint(load.ready);
    load.fail(new Error("chunk failed"));
    await expect(done).resolves.toBeUndefined();
  });
});
