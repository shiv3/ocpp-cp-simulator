import type { TranslateFunction } from "@open-ocpp-trace/viewer-react";

import type { MessageKey, TFunction } from "../../i18n";

const PREFIX = "dashboard.logs.trace.viewer.";

/**
 * The viewer strings the console translates, by their dotted key in the
 * viewer's `defaultStrings`. The others (inspector markers, delivery and
 * error texts the simulator never produces) keep the viewer's English.
 * `toolbar.exported` and `gap` are function leaves mapped by hand below.
 */
export const TRANSLATED_VIEWER_KEYS: readonly string[] = [
  "listLabel",
  "columns.timestamp",
  "columns.chargePoint",
  "columns.connector",
  "columns.direction",
  "columns.messageType",
  "columns.action",
  "columns.messageId",
  "loading",
  "empty",
  "noMatch",
  "unparsed",
  "jumpToLatest",
  "toolbar.pause",
  "toolbar.pending",
  "toolbar.follow",
  "toolbar.exportSelection",
  "toolbar.exportFiltered",
  "toolbar.exported",
  "gap",
  "inspector.label",
  "inspector.empty",
  "inspector.gone",
  "inspector.fields.messageType",
  "inspector.fields.action",
  "inspector.fields.direction",
  "inspector.fields.messageId",
  "inspector.fields.chargePoint",
  "inspector.fields.connector",
  "inspector.fields.ocppVersion",
  "inspector.fields.transport",
  "inspector.fields.timestamp",
  "inspector.fields.reason",
  "inspector.fields.errorCode",
  "inspector.fields.errorDescription",
  "inspector.fields.source",
  "inspector.blocks.payload",
  "inspector.blocks.raw",
  "inspector.blocks.error",
  "inspector.blocks.meta",
  "inspector.showMore",
  "inspector.copy",
  "inspector.rawHidden",
  "inspector.goToResponse",
  "inspector.goToCall",
  "inspector.noMatchingCall",
  "filter.panelLabel",
  "filter.reset",
  "filter.clear",
  "filter.clearGroup",
  "filter.none",
  "filter.kinds",
  "filter.kindNames.trace",
  "filter.kindNames.unparsed",
  "filter.kindNames.gap",
  "filter.timeRange",
  "filter.from",
  "filter.to",
  "filter.chargePointIds",
  "filter.connectorIds",
  "filter.ocppVersions",
  "filter.directions",
  "filter.messageTypes",
  "filter.actions",
  "filter.sourceIds",
  "filter.messageIds",
  "filter.search",
  "filter.text",
  "filter.searchPayloads",
];

const TRANSLATED = new Set(TRANSLATED_VIEWER_KEYS);

/**
 * Bridges the viewer's `translate` prop to i18next: a viewer key `k` reads
 * `dashboard.logs.trace.viewer.k` with the leaf's named parameters (`count`
 * picks the plural form). Returning `undefined` keeps the viewer's text.
 * Create it again when the language changes: the viewer resolves its
 * strings only when the identity of `translate` changes.
 */
export function createViewerTranslate(t: TFunction): TranslateFunction {
  // The keys are built at run time; the test checks each one exists.
  const text = t as unknown as (
    key: MessageKey | string,
    params?: Readonly<Record<string, unknown>>,
  ) => string;

  return (key, params) => {
    if (!TRANSLATED.has(key)) return undefined;
    switch (key) {
      case "gap":
        // The feed only lists dropped gaps, without a count.
        return params.reason === "dropped" && params.missedCount === null
          ? text(`${PREFIX}gapDropped`)
          : undefined;
      case "toolbar.exported": {
        const skipped = Number(params.skipped ?? 0);
        return skipped > 0
          ? text(`${PREFIX}toolbar.exportedSkipped`, params)
          : text(`${PREFIX}toolbar.exported`, { count: params.count });
      }
      default:
        return text(`${PREFIX}${key}`, params);
    }
  };
}
