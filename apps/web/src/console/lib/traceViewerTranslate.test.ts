import { afterAll, describe, expect, it } from "vitest";
import { defaultStrings } from "@open-ocpp-trace/viewer-react";

import i18n, { setLocale } from "../../i18n";
import {
  TRANSLATED_VIEWER_KEYS,
  createViewerTranslate,
} from "./traceViewerTranslate";

/** The dotted keys of every leaf of the viewer's strings. */
function leafKeys(node: object, prefix = ""): string[] {
  return Object.entries(node).flatMap(([key, value]) =>
    typeof value === "object" && value !== null
      ? leafKeys(value as object, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

describe("createViewerTranslate", () => {
  const translate = createViewerTranslate(i18n.t.bind(i18n));

  afterAll(async () => {
    await setLocale("en");
  });

  it("only maps keys the viewer has", () => {
    const leaves = new Set(leafKeys(defaultStrings));
    expect(TRANSLATED_VIEWER_KEYS.filter((key) => !leaves.has(key))).toEqual(
      [],
    );
  });

  it("has an English string for every mapped key", () => {
    const missing = [
      ...TRANSLATED_VIEWER_KEYS.filter((key) => key !== "gap"),
      "gapDropped",
      "toolbar.exportedSkipped",
    ].filter(
      (key) => !i18n.exists(`dashboard.logs.trace.viewer.${key}`, { count: 2 }),
    );
    expect(missing).toEqual([]);
  });

  it("translates a plain leaf and leaves the others to the viewer", () => {
    expect(translate("columns.chargePoint", {})).toBe("Charge point");
    expect(translate("inspector.markers.redacted", {})).toBeUndefined();
  });

  it("passes the named parameters, with plurals by count", () => {
    expect(translate("toolbar.pending", { count: 1 })).toBe("1 pending");
    expect(translate("filter.clearGroup", { legend: "Actions" })).toBe(
      "Clear Actions",
    );
    expect(translate("toolbar.exported", { count: 2, skipped: 0 })).toBe(
      "Exported 2 records",
    );
    expect(translate("toolbar.exported", { count: 1, skipped: 3 })).toBe(
      "Exported 1 record (3 skipped)",
    );
  });

  it("names a dropped gap, and leaves a counted gap to the viewer", () => {
    expect(translate("gap", { missedCount: null, reason: "dropped" })).toBe(
      "Gap: log lines dropped from the buffer",
    );
    expect(
      translate("gap", { missedCount: 4, reason: "dropped" }),
    ).toBeUndefined();
  });

  it("follows the console language", async () => {
    await setLocale("fr");
    expect(translate("columns.chargePoint", {})).toBe("Borne");
    expect(translate("toolbar.pending", { count: 3 })).toBe("3 en attente");
  });
});
