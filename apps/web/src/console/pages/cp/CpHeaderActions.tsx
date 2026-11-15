import React from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  Maximize2,
  MoreHorizontal,
  Settings,
  Tag,
  Trash2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface CpHeaderActionsProps {
  cpId: string;
  isPanel: boolean;
  canSetLabels: boolean;
  labels: unknown;
  isLabelsOpen: boolean;
  labelsCardId: string;
  setIsLabelsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  isConfigOpen: boolean;
  configCardId: string;
  setIsConfigOpen: React.Dispatch<React.SetStateAction<boolean>>;
  isConnected: boolean;
  isConnectPending: boolean;
  handleToggleConnect: () => Promise<void>;
  isDeletePending: boolean;
  handleDelete: () => Promise<void>;
  fullPageHref: string;
  closePanel: () => void;
}

/** The charge point header's buttons: Labels, Config, Connect, the menu and
 *  (in the side panel) expand and close. */
export const CpHeaderActions: React.FC<CpHeaderActionsProps> = ({
  cpId,
  isPanel,
  canSetLabels,
  labels,
  isLabelsOpen,
  labelsCardId,
  setIsLabelsOpen,
  isConfigOpen,
  configCardId,
  setIsConfigOpen,
  isConnected,
  isConnectPending,
  handleToggleConnect,
  isDeletePending,
  handleDelete,
  fullPageHref,
  closePanel,
}) => {
  const { t } = useTranslation();
  return (
    <>
      {canSetLabels && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={labels === undefined}
          title={
            labels === undefined
              ? t("cp.page.labelsUnknown")
              : t("cp.page.editLabelsTitle")
          }
          aria-expanded={isLabelsOpen}
          aria-controls={isLabelsOpen ? labelsCardId : undefined}
          onClick={() => setIsLabelsOpen((open) => !open)}
          className={cn(
            isLabelsOpen &&
              "border-cx-accent bg-cx-sel text-cx-accent hover:bg-cx-sel hover:text-cx-accent",
          )}
        >
          <Tag className="h-3.5 w-3.5" />
          {t("cp.page.labels")}
        </Button>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-expanded={isConfigOpen}
        aria-controls={isConfigOpen ? configCardId : undefined}
        onClick={() => setIsConfigOpen((open) => !open)}
        className={cn(
          isConfigOpen &&
            "border-cx-accent bg-cx-sel text-cx-accent hover:bg-cx-sel hover:text-cx-accent",
        )}
      >
        <Settings className="h-3.5 w-3.5" />
        {t("cp.page.config")}
      </Button>
      <Button
        type="button"
        variant={isConnected ? "destructive" : "success"}
        size="sm"
        disabled={isConnectPending}
        onClick={() => void handleToggleConnect()}
      >
        {isConnected ? t("cp.page.disconnect") : t("cp.page.connect")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="px-2"
            aria-label={t("cp.page.more")}
            title={t("cp.page.more")}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link to={`/scenarios?tab=library&cp=${encodeURIComponent(cpId)}`}>
              {t("cp.page.scenarios")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={isDeletePending}
            className="text-cx-rose focus:text-cx-rose"
            onSelect={() => void handleDelete()}
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            {t("cp.page.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {isPanel && (
        <>
          <Button
            asChild
            variant="outline"
            size="sm"
            className="px-2"
            title={t("cp.page.openFullPage")}
          >
            <Link
              to={fullPageHref}
              state={{ from: "/" }}
              aria-label={t("cp.page.openFullPage")}
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </Link>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="px-2"
            aria-label={t("cp.page.closePanel")}
            title={t("cp.page.closeTitle")}
            onClick={closePanel}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </>
      )}
    </>
  );
};
