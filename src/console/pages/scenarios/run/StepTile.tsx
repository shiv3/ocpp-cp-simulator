import React from "react";

import { cn } from "@/lib/utils";
import type { ScenarioNode } from "../../../../cp/application/scenario/ScenarioTypes";
import { tileFor } from "./stepVisuals";

/** The type tile: a 28px square in the step category's colour. */
const StepTile: React.FC<{ node: ScenarioNode }> = ({ node }) => {
  const { icon: Icon, className } = tileFor(node);
  return (
    <span
      aria-hidden
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
        className,
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
};

export default StepTile;
