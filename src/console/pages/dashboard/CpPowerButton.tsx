import React, { useState } from "react";
import { Power } from "lucide-react";

import { cn } from "@/lib/utils";
import { useDataContext } from "../../../data/providers/DataProvider";
import { formatRelativeTime } from "../../lib/formatRelativeTime";

export interface CpPowerButtonProps {
  cpId: string;
  /** Whether the charge point is connected (the button then disconnects). */
  connected: boolean;
  lastHeartbeat: Date | null;
}

/**
 * Icon-only Connect / Disconnect for a charge point's row. It sits inside a
 * clickable row, so its click never reaches the row (no panel opens). The
 * tooltip carries the last Heartbeat, which used to have a line of its own on
 * the card.
 */
const CpPowerButton: React.FC<CpPowerButtonProps> = ({
  cpId,
  connected,
  lastHeartbeat,
}) => {
  const { chargePointService } = useDataContext();
  const [isPending, setIsPending] = useState(false);
  const verb = connected ? "Disconnect" : "Connect";

  const handleClick = async (event: React.MouseEvent) => {
    event.stopPropagation();
    setIsPending(true);
    try {
      if (connected) {
        await chargePointService.disconnect(cpId);
      } else {
        await chargePointService.connect(cpId);
      }
    } catch (err) {
      console.error(`Failed to ${verb.toLowerCase()} ${cpId}`, err);
    } finally {
      setIsPending(false);
    }
  };

  return (
    <button
      type="button"
      onClick={(event) => void handleClick(event)}
      disabled={isPending}
      aria-label={`${verb} ${cpId}`}
      title={`${verb} · heartbeat ${formatRelativeTime(lastHeartbeat)}`}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-md border",
        connected
          ? "border-rose-200 text-rose-700 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-300 dark:hover:bg-rose-950"
          : "border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-900 dark:text-emerald-300 dark:hover:bg-emerald-950",
        isPending && "opacity-50",
      )}
    >
      <Power className="h-4 w-4" />
    </button>
  );
};

export default CpPowerButton;
