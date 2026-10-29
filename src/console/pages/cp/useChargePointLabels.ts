import { useCallback, useEffect, useState } from "react";

import { canSubscribeRegistry } from "@/data/hooks/useChargePoints";
import type { ChargePointSnapshot } from "@/data/interfaces/ChargePointService";
import { useDataContext } from "@/data/providers/DataProvider";
import type { Labels } from "@/protocol";

/**
 * A daemon charge point's current labels (#446): the page's own snapshot,
 * overridden by the registry push (#471) so a relabel made from this page,
 * another tab, the RPC or MCP shows up without a refresh.
 *
 * `labels` is `undefined` while they are unknown — the snapshot is not loaded,
 * could not be read or carries no config, or Local mode (no labels) — which is
 * not the same as `{}`: an editor must not offer to replace what it could not
 * read. `markSaved` records a map the daemon acknowledged, so the page shows
 * it even when the push does not arrive (a failed registry subscription).
 */
export function useChargePointLabels(
  cpId: string,
  snapshot: ChargePointSnapshot | undefined,
): {
  labels: Labels | undefined;
  markSaved: (labels: Labels) => void;
} {
  const { mode, chargePointService } = useDataContext();
  // A push or a save is newer than the snapshot. Keyed by cpId so a
  // navigation never shows the previous charge point's.
  const [latest, setLatest] = useState<{ cpId: string; labels: Labels } | null>(
    null,
  );

  useEffect(() => {
    if (mode !== "remote" || !canSubscribeRegistry(chargePointService)) {
      return;
    }
    return chargePointService.subscribeRegistry((event) => {
      const cp =
        event.type === "snapshot"
          ? event.cps.find((c) => c.id === cpId)
          : event.cp?.id === cpId
            ? event.cp
            : undefined;
      if (cp?.config) setLatest({ cpId, labels: cp.config.labels ?? {} });
    });
  }, [mode, cpId, chargePointService]);

  const markSaved = useCallback(
    (labels: Labels) => setLatest({ cpId, labels }),
    [cpId],
  );

  let labels: Labels | undefined;
  if (mode === "remote") {
    if (latest?.cpId === cpId) labels = latest.labels;
    else if (snapshot?.id === cpId && snapshot.config) {
      labels = snapshot.config.labels ?? {};
    }
  }
  return { labels, markSaved };
}
