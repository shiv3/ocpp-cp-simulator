import { useCallback, useEffect, useState } from "react";

import { canSubscribeRegistry } from "@/data/hooks/useChargePoints";
import type { ChargePointSnapshot } from "@/data/interfaces/ChargePointService";
import { useDataContext } from "@/data/providers/DataProvider";
import type { Labels } from "@/protocol";

/**
 * A daemon charge point's current labels (#446), kept current by the registry
 * push (#471) so a relabel made from this page, another tab, the RPC or MCP
 * shows up without a refresh.
 *
 * `labels` is `undefined` while they are unknown — loading, a failed read, a
 * snapshot without config, Local mode (no labels) — which is not the same as
 * `{}`: an editor must not offer to replace what it could not read.
 * `markSaved` records a map the daemon acknowledged, so the page shows it even
 * when the push does not arrive (a failed registry subscription).
 */
export function useChargePointLabels(cpId: string): {
  labels: Labels | undefined;
  markSaved: (labels: Labels) => void;
} {
  const { mode, chargePointService } = useDataContext();
  // Keyed by cpId so a navigation never shows the previous charge point's.
  const [known, setKnown] = useState<{ cpId: string; labels: Labels } | null>(
    null,
  );

  useEffect(() => {
    if (mode !== "remote" || !cpId) return;
    let cancelled = false;
    // A push is newer than a read still in flight: once one arrived, the read
    // must not put the older labels back.
    let pushed = false;
    const accept = (cp: ChargePointSnapshot | null | undefined) => {
      if (cancelled || !cp?.config) return;
      setKnown({ cpId, labels: cp.config.labels ?? {} });
    };

    chargePointService
      .getChargePoint(cpId)
      .then((cp) => {
        if (!pushed) accept(cp);
      })
      // A failed read leaves the labels unknown; the page logs the failure.
      .catch(() => {});

    const unsubscribe = canSubscribeRegistry(chargePointService)
      ? chargePointService.subscribeRegistry((event) => {
          const cp =
            event.type === "snapshot"
              ? event.cps.find((c) => c.id === cpId)
              : event.cp?.id === cpId
                ? event.cp
                : undefined;
          if (!cp?.config) return;
          pushed = true;
          accept(cp);
        })
      : undefined;

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [mode, cpId, chargePointService]);

  const markSaved = useCallback(
    (labels: Labels) => setKnown({ cpId, labels }),
    [cpId],
  );

  return {
    labels: known?.cpId === cpId ? known.labels : undefined,
    markSaved,
  };
}
