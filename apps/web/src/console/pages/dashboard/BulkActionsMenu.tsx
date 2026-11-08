import React, { useState } from "react";
import { ChevronDown, Layers } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { t as translate, useT, type MessageKey } from "../../../i18n";
import { useGlobalTagIds } from "@/data/hooks/useGlobalTagIds";
import { useDataContext } from "@/data/providers/DataProvider";
import type { ChargePointService } from "@ocpp-cp-sim/client/interfaces/ChargePointService";

/** What one charge point did: done, failed with an error, or skipped with
 *  the reason it had nothing to do. */
type Outcome =
  | { kind: "done" }
  | { kind: "failed"; error: string }
  | { kind: "skipped"; reason: MessageKey };

interface BulkAction {
  labelKey: MessageKey;
  run: (
    service: ChargePointService,
    cpId: string,
    index: number,
    tagIds: readonly string[],
  ) => Promise<Outcome>;
}

const DONE: Outcome = { kind: "done" };

const ACTIONS: BulkAction[] = [
  {
    labelKey: "dashboard.bulk.connectAll",
    run: async (service, cpId) => {
      await service.connect(cpId);
      return DONE;
    },
  },
  {
    labelKey: "dashboard.bulk.disconnectAll",
    run: async (service, cpId) => {
      await service.disconnect(cpId);
      return DONE;
    },
  },
  {
    labelKey: "dashboard.bulk.heartbeatAll",
    run: async (service, cpId) => {
      await service.sendHeartbeat(cpId);
      return DONE;
    },
  },
  {
    // One TagID per charge point, in order, as the classic UI did: a CSMS may
    // refuse a second concurrent transaction for the same idTag.
    labelKey: "dashboard.bulk.startTxAll",
    run: async (service, cpId, index, tagIds) => {
      const tagId = tagIds[index];
      if (!tagId)
        return { kind: "skipped", reason: "dashboard.bulk.noTagLeft" };
      await service.startTransaction(cpId, 1, tagId);
      return DONE;
    },
  },
  {
    // Read the transactions at click time: the dashboard's list can lag
    // behind one that was just started.
    labelKey: "dashboard.bulk.stopTxAll",
    run: async (service, cpId) => {
      const snapshot = await service.getChargePoint(cpId);
      const running = (snapshot?.connectors ?? []).filter(
        (c) => c.transactionId != null,
      );
      if (running.length === 0) {
        return { kind: "skipped", reason: "dashboard.bulk.noTransaction" };
      }
      await Promise.all(
        running.map((c) => service.stopTransaction(cpId, c.id)),
      );
      return DONE;
    },
  },
];

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function summarize(
  label: string,
  results: ReadonlyArray<{ cpId: string; outcome: Outcome }>,
): string {
  const done = results.filter((r) => r.outcome.kind === "done").length;
  const failed = results.flatMap((r) =>
    r.outcome.kind === "failed" ? [`${r.cpId} (${r.outcome.error})`] : [],
  );
  const skipped = results.flatMap((r) =>
    r.outcome.kind === "skipped"
      ? [`${r.cpId} (${translate(r.outcome.reason)})`]
      : [],
  );
  let message = translate("dashboard.bulk.summary", {
    label,
    done,
    total: results.length,
  });
  if (failed.length > 0)
    message += ` ${translate("dashboard.bulk.failed", { list: failed.join(", ") })}`;
  if (skipped.length > 0)
    message += ` ${translate("dashboard.bulk.skipped", { list: skipped.join(", ") })}`;
  return message;
}

export interface BulkActionsMenuProps {
  cpIds: readonly string[];
  /** Called with the one-line report once an action has run everywhere. */
  onReport: (report: string) => void;
}

/**
 * The dashboard's "All charge points" menu: connect, disconnect, Heartbeat,
 * start or stop a transaction on every charge point at once, the actions of
 * the classic UI's Multi-CP dialog. Each run ends with a one-line report of
 * what every charge point did, handed to `onReport`.
 */
const BulkActionsMenu: React.FC<BulkActionsMenuProps> = ({
  cpIds,
  onReport,
}) => {
  const t = useT();
  const { chargePointService } = useDataContext();
  const { tagIds } = useGlobalTagIds();
  const [isPending, setIsPending] = useState(false);

  const runAction = async (action: BulkAction) => {
    const label = t(action.labelKey);
    setIsPending(true);
    try {
      const results = await Promise.all(
        cpIds.map(async (cpId, index) => {
          try {
            const outcome = await action.run(
              chargePointService,
              cpId,
              index,
              tagIds,
            );
            return { cpId, outcome };
          } catch (err) {
            console.error(`${label} failed for ${cpId}`, err);
            const outcome: Outcome = {
              kind: "failed",
              error: describeError(err),
            };
            return { cpId, outcome };
          }
        }),
      );
      onReport(summarize(label, results));
    } finally {
      setIsPending(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={isPending}>
          <Layers className="h-4 w-4" />
          {t("dashboard.bulk.menu")}
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {ACTIONS.map((action, i) => (
          <React.Fragment key={action.labelKey}>
            {i === 3 && <DropdownMenuSeparator />}
            <DropdownMenuItem onClick={() => void runAction(action)}>
              {t(action.labelKey)}
            </DropdownMenuItem>
          </React.Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default BulkActionsMenu;
