import { useTranslation } from "react-i18next";
import React, { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { WaitControlAction } from "../lib/waitControl";
import { type MessageKey } from "@/i18n";

/** Seconds the "+30 s" control adds to the parked wait's timeout. */
export const WAIT_EXTENSION_SECONDS = 30;

export interface WaitControlsProps {
  /** The parked wait has a timeout to push back (hide "+30 s" otherwise). */
  canExtend: boolean;
  /** Sends the control; `seconds` is set for "extend" only. */
  onControl: (action: WaitControlAction, seconds?: number) => Promise<void>;
  className?: string;
}

const CONTROLS: ReadonlyArray<{
  action: WaitControlAction;
  label: MessageKey;
  title: MessageKey;
}> = [
  {
    action: "extend",
    label: "consoleShared.waitControls.extendLabel",
    title: "consoleShared.waitControls.extendTitle",
  },
  {
    action: "retry",
    label: "consoleShared.waitControls.retry",
    title: "consoleShared.waitControls.retryTitle",
  },
  {
    action: "continue",
    label: "consoleShared.waitControls.continue",
    title: "consoleShared.waitControls.continueTitle",
  },
];

/**
 * Operator controls on a run parked on a wait (#240): push its timeout
 * back, re-arm it with its full timeout, or move on without the awaited
 * event. Shared by the CP page's Active scenarios panel and the run page,
 * which each send the control for the run they show; a failed control is
 * shown inline.
 */
const WaitControls: React.FC<WaitControlsProps> = ({
  canExtend,
  onControl,
  className,
}) => {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(
    async (action: WaitControlAction) => {
      setPending(true);
      setError(null);
      try {
        await onControl(
          action,
          action === "extend" ? WAIT_EXTENSION_SECONDS : undefined,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPending(false);
      }
    },
    [onControl],
  );

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex flex-wrap gap-1">
        {CONTROLS.filter((c) => canExtend || c.action !== "extend").map(
          (control) => (
            <Button
              key={control.action}
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              title={t(control.title, { seconds: WAIT_EXTENSION_SECONDS })}
              onClick={() => void send(control.action)}
              className="h-7 text-xs"
            >
              {t(control.label, { seconds: WAIT_EXTENSION_SECONDS })}
            </Button>
          ),
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-cx-rose">
          {error}
        </p>
      )}
    </div>
  );
};

export default WaitControls;
