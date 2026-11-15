import { useTranslation } from "react-i18next";
import React from "react";
import { Plus } from "lucide-react";

/** The hover zone between two boxes of a lane: a small `+` that opens the
 *  step picker for that place (as the old step list's insert slot). */
const InsertZone: React.FC<{ label: string; onOpen: () => void }> = ({
  label,
  onOpen,
}) => {
  const { t } = useTranslation();
  return (
    <li className="group/insert relative h-1.5">
      <div className="absolute inset-x-0 -top-[5px] z-10 flex h-4 items-center justify-center">
        <button
          type="button"
          aria-label={label}
          title={t("scenarioRun.insertStepHere")}
          onClick={onOpen}
          className="flex h-4 w-4 items-center justify-center rounded-full border border-cx-border-strong bg-cx-card text-cx-muted opacity-0 hover:border-cx-accent hover:text-cx-accent focus-visible:opacity-100 group-hover/insert:opacity-100"
        >
          <Plus className="h-3 w-3" />
        </button>
      </div>
    </li>
  );
};

export default InsertZone;
