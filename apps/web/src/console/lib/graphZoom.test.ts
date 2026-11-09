// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { ZOOM_KEY, clampZoom, fitZoom, readStoredZoom } from "./graphZoom";

describe("graph zoom", () => {
  afterEach(() => {
    try {
      window.localStorage.clear();
    } catch {
      // no storage
    }
  });

  it("fits the whole graph, never enlarging past 100%", () => {
    expect(fitZoom(1000, 400, 500, 1000)).toBe(0.5);
    expect(fitZoom(1000, 2000, 2000, 500)).toBe(0.25);
    expect(fitZoom(300, 200, 900, 900)).toBe(1);
    expect(fitZoom(1000, 1000, 0, 0)).toBe(1);
  });

  it("clamps to the supported range", () => {
    expect(clampZoom(10)).toBe(2);
    expect(clampZoom(0.01)).toBe(0.25);
  });

  it("remembers 'fit' and a number; garbage reads as 100%", () => {
    window.localStorage.setItem(ZOOM_KEY, "fit");
    expect(readStoredZoom()).toBe("fit");
    window.localStorage.setItem(ZOOM_KEY, "1.5");
    expect(readStoredZoom()).toBe(1.5);
    window.localStorage.setItem(ZOOM_KEY, "nope");
    expect(readStoredZoom()).toBe(1);
  });
});
