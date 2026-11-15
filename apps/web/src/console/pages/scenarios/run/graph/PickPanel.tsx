import React from "react";
import { useTranslation } from "react-i18next";

import type { TreeGraphGeometry } from "../../../../lib/treeGraphLayout";
import { nodeTitle } from "../stepVisuals";
import type { Pick, PickTarget } from "./graphShared";

const PickPanel: React.FC<{
  pick: Pick;
  pickTargets: Map<string, PickTarget>;
  pickNotice: string | null;
  cards: TreeGraphGeometry["cards"];
  numbers: ReadonlyMap<string, number | string>;
  cancelPick: () => void;
  commitPick: (id: string) => void;
  setHoverId: React.Dispatch<React.SetStateAction<string | null>>;
}> = ({
  pick,
  pickTargets,
  pickNotice,
  cards,
  numbers,
  cancelPick,
  commitPick,
  setHoverId,
}) => {
  const { t } = useTranslation();
  return (
    <div
      role="group"
      data-pick-panel=""
      aria-label={t(
        pick.kind === "loop"
          ? "scenarioRun.pick.title"
          : "scenarioRun.pick.titleLane",
        { lane: pick.kind === "lane" ? pick.lane : "" },
      )}
      className="mb-1.5 rounded-[10px] border border-cx-accent/40 bg-cx-accent/5 px-3 py-2 text-xs"
    >
      <div className="flex items-center gap-2">
        <span className="flex-1 font-medium text-cx-fg">
          {t(
            pick.kind === "loop"
              ? "scenarioRun.pick.title"
              : "scenarioRun.pick.titleLane",
            { lane: pick.kind === "lane" ? pick.lane : "" },
          )}
        </span>
        <button
          type="button"
          onClick={cancelPick}
          className="rounded border border-cx-border-strong px-2 py-0.5 text-cx-fg2 hover:bg-cx-sub"
        >
          {t("scenarioRun.pick.cancel")}
        </button>
      </div>
      <p className="mt-0.5 text-cx-muted">
        {pickNotice ??
          t(
            pick.kind === "loop"
              ? "scenarioRun.pick.hint"
              : "scenarioRun.pick.hintLane",
          )}
      </p>
      <ul
        aria-label={t("scenarioRun.pick.listLabel")}
        className="mt-1.5 flex flex-wrap gap-1.5"
      >
        {[...pickTargets.entries()].map(([id, target]) => {
          const step = cards.find((c) => c.node.id === id)?.node;
          if (!step) return null;
          return (
            <li key={id}>
              <button
                type="button"
                data-pick-target={id}
                disabled={!target.cap.ok}
                title={target.cap.ok ? undefined : t(target.cap.reason)}
                onClick={() => commitPick(id)}
                onFocus={() => setHoverId(id)}
                onMouseEnter={() => setHoverId(id)}
                onBlur={() => setHoverId((h) => (h === id ? null : h))}
                className="rounded-md border border-cx-border-strong bg-cx-card px-2 py-1 text-cx-fg2 hover:border-cx-accent focus-visible:border-cx-accent disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t("scenarioRun.pick.target", {
                  n: numbers.get(id) ?? "",
                  title: nodeTitle(step),
                })}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default PickPanel;
