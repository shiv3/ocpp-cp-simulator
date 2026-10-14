import React, { useRef } from "react";

import { cn } from "@/lib/utils";

import {
  statusDotClass,
  type StatusPillStatus,
} from "../../components/statusColor";

export interface ConnectorTabsProps {
  connectors: ReadonlyArray<{ id: number; status: StatusPillStatus }>;
  /** The connector whose card is shown below the tabs. */
  selectedId: number | null;
  onSelect: (id: number) => void;
  /** `id` of the tabpanel these tabs control (for `aria-controls`). */
  panelId?: string;
}

/**
 * One tab per connector (`#1`, `#2`, …) with a dot in the connector's status
 * color, in the console's segmented strip. Only the selected tab is in the tab
 * order; the arrow keys, Home and End move the selection, as in a native
 * tablist. Which card shows is the caller's call — this is just the strip.
 */
const ConnectorTabs: React.FC<ConnectorTabsProps> = ({
  connectors,
  selectedId,
  onSelect,
  panelId,
}) => {
  const tabRefs = useRef(new Map<number, HTMLButtonElement>());

  const move = (event: React.KeyboardEvent) => {
    const index = connectors.findIndex((c) => c.id === selectedId);
    let next: number;
    switch (event.key) {
      case "ArrowRight":
        next = (index + 1) % connectors.length;
        break;
      case "ArrowLeft":
        next = (index - 1 + connectors.length) % connectors.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = connectors.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = connectors[next];
    onSelect(target.id);
    tabRefs.current.get(target.id)?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Connectors"
      onKeyDown={move}
      className="inline-flex max-w-full flex-wrap gap-0.5 rounded-[9px] bg-cx-sub p-[3px]"
    >
      {connectors.map((connector) => {
        const selected = connector.id === selectedId;
        return (
          <button
            key={connector.id}
            ref={(el) => {
              if (el) tabRefs.current.set(connector.id, el);
              else tabRefs.current.delete(connector.id);
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            title={`Connector ${connector.id} · ${connector.status}`}
            onClick={() => onSelect(connector.id)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-[7px] px-3 py-1 font-mono text-[13px] font-medium text-cx-muted hover:text-cx-fg",
              selected &&
                "bg-cx-card text-cx-fg shadow-[0_0_0_1px_var(--cx-border-strong)]",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "h-[7px] w-[7px] rounded-full",
                statusDotClass(connector.status),
              )}
            />
            #{connector.id}
          </button>
        );
      })}
    </div>
  );
};

export default ConnectorTabs;
