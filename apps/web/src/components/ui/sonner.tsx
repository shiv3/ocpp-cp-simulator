import * as React from "react";
import { Toaster } from "sonner";
import { useTranslation } from "react-i18next";

import { useDarkMode } from "@/contexts/DarkModeContext";

/**
 * The one toast host of the web console (#937), mounted in `App.tsx` inside
 * `DarkModeProvider`. Post through `notify` (`@/lib/toast`), not through this
 * component.
 *
 * - Theme follows the console's resolved light/dark (`DarkModeContext`).
 * - Colours come from the shadcn tokens (`--popover`, `--border`, ...).
 * - The region label and close button are translated.
 * - Sonner announces toasts through an `aria-live="polite"` region, pauses
 *   timers on hover/focus, closes on Esc when focused, and jumps to the
 *   region with Alt+T; its CSS turns animations off under
 *   `prefers-reduced-motion`.
 */
export const AppToaster: React.FC = () => {
  const { t } = useTranslation();
  const { isDark } = useDarkMode();
  return (
    <Toaster
      theme={isDark ? "dark" : "light"}
      position="bottom-right"
      closeButton
      visibleToasts={5}
      containerAriaLabel={t("common.toast.region")}
      toastOptions={{
        classNames: {
          toast:
            "!border-border !bg-popover !text-popover-foreground !shadow-lg",
          description: "!text-muted-foreground",
        },
      }}
    />
  );
};
