// Splitting of a 2.x station-initiated report (NotifyEvent, NotifyMonitoringReport)
// into parts linked by `seqNo` / `tbc` (N02.FR.03, FR.09; N07.FR.07, #538).
//
// No configuration variable sizes these parts: the MonitoringCtrlr
// `ItemsPerMessage` / `BytesPerMessage` instances (SetVariableMonitoring,
// ClearVariableMonitoring) bound the CSMS's requests (N04.FR.09, N06.FR.04),
// not the station's reports. The station picks the part size; this one keeps
// every report the simulator realistically builds in a single part.

/** Items (eventData, monitor entries) per report part. */
export const MONITORING_ITEMS_PER_PART = 100;

export interface ReportPart<T> {
  readonly items: readonly [T, ...T[]];
  /** 0 for the first part, then increasing. */
  readonly seqNo: number;
  /** `true` on every part but the last ("to be continued"). */
  readonly tbc: boolean;
}

/** Split a non-empty list into parts of at most `itemsPerPart` items. */
export function splitIntoParts<T>(
  items: readonly [T, ...T[]],
  itemsPerPart: number = MONITORING_ITEMS_PER_PART,
): ReportPart<T>[] {
  if (!Number.isInteger(itemsPerPart) || itemsPerPart < 1) {
    throw new RangeError(`itemsPerPart must be a positive integer`);
  }
  const parts: ReportPart<T>[] = [];
  for (let start = 0; start < items.length; start += itemsPerPart) {
    const chunk = items.slice(start, start + itemsPerPart) as [T, ...T[]];
    parts.push({
      items: chunk,
      seqNo: parts.length,
      tbc: start + itemsPerPart < items.length,
    });
  }
  return parts;
}

/**
 * Split a non-empty list into parts of at most `maxItems` items whose
 * `frameBytes` stays within `maxBytes`. An item that alone exceeds `maxBytes`
 * still goes out, alone: it cannot be divided further.
 *
 * `frameBytes(items, seqNo)` is the size of the whole message that would carry
 * `items`; it is measured as a part that is not the last (`tbc` true), which
 * is never shorter than the last one.
 */
export function splitIntoSizedParts<T>(
  items: readonly [T, ...T[]],
  maxItems: number,
  maxBytes: number,
  frameBytes: (items: readonly T[], seqNo: number) => number,
): ReportPart<T>[] {
  if (!Number.isInteger(maxItems) || maxItems < 1) {
    throw new RangeError(`maxItems must be a positive integer`);
  }
  const chunks: T[][] = [];
  let current: T[] = [];
  for (const item of items) {
    const grown = [...current, item];
    const fits =
      current.length === 0 ||
      (grown.length <= maxItems &&
        frameBytes(grown, chunks.length) <= maxBytes);
    if (fits) {
      current = grown;
    } else {
      chunks.push(current);
      current = [item];
    }
  }
  chunks.push(current);
  return chunks.map((chunk, seqNo) => ({
    items: chunk as unknown as readonly [T, ...T[]],
    seqNo,
    tbc: seqNo < chunks.length - 1,
  }));
}
