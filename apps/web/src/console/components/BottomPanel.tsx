import React, { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

import { cn } from "@/lib/utils";

const MIN_HEIGHT = 120;
const DEFAULT_HEIGHT = 320;
const KEY_STEP = 32;
/** Room the content above the panel keeps when the operator drags it tall. */
const MIN_CONTENT_HEIGHT = 160;

/** The tallest the panel may be inside `section`'s parent. */
function maxHeightFor(section: HTMLElement | null): number {
  // clientHeight is 0 in jsdom: there is no layout to leave room in.
  const container = section?.parentElement?.clientHeight || window.innerHeight;
  return container > 0
    ? Math.max(MIN_HEIGHT, container - MIN_CONTENT_HEIGHT)
    : Infinity;
}

function clampHeight(height: number, max: number): number {
  return Math.round(Math.min(Math.max(height, MIN_HEIGHT), max));
}

function readStoredHeight(storageKey: string): number {
  try {
    const raw = window.localStorage.getItem(`${storageKey}.height`);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value)
      ? Math.max(value, MIN_HEIGHT)
      : DEFAULT_HEIGHT;
  } catch {
    return DEFAULT_HEIGHT;
  }
}

function readStoredCollapsed(storageKey: string): boolean {
  try {
    return window.localStorage.getItem(`${storageKey}.collapsed`) === "1";
  } catch {
    return false;
  }
}

export interface BottomPanelTab<T extends string> {
  value: T;
  label: string;
}

export interface BottomPanelProps<T extends string> {
  /** Accessible name of the panel (`aria-label` of the `<section>`). */
  label: string;
  tabs: ReadonlyArray<BottomPanelTab<T>>;
  active: T;
  /** The caller owns the selection (and keeps it in the URL). */
  onSelect: (value: T) => void;
  /** Prefix of the two `localStorage` keys: `.height` and `.collapsed`. */
  storageKey: string;
  /** Accessible name of the tab strip. */
  tabsLabel: string;
  /** Right end of the header bar, before the chevron. */
  toolbar?: React.ReactNode;
  /** The active tab's content. */
  children: React.ReactNode;
}

/**
 * A panel docked to the bottom of its (flex column) parent, like an editor's
 * Panel: a header bar with the tab strip, a toolbar and a chevron that
 * collapses it to that bar, a top edge that drags (or ↑ / ↓ resizes), and a
 * body that scrolls on its own. Height and collapsed state are kept in
 * `localStorage`. Esc is not handled here.
 */
function BottomPanel<T extends string>({
  label,
  tabs,
  active,
  onSelect,
  storageKey,
  tabsLabel,
  toolbar,
  children,
}: BottomPanelProps<T>): React.ReactElement {
  const baseId = useId();
  const bodyId = `${baseId}-body`;
  const tabId = (value: string) => `${baseId}-tab-${value}`;
  const sectionRef = useRef<HTMLElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const dragging = useRef(false);
  const [height, setHeight] = useState(() => readStoredHeight(storageKey));
  const [collapsed, setCollapsed] = useState(() =>
    readStoredCollapsed(storageKey),
  );
  const mounted = useRef(false);

  useEffect(() => {
    // Nothing to write until the operator changes something.
    if (!mounted.current) return;
    try {
      window.localStorage.setItem(`${storageKey}.height`, String(height));
    } catch {
      // storage unavailable (private window): the height just isn't kept
    }
  }, [height, storageKey]);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    try {
      if (collapsed) {
        window.localStorage.setItem(`${storageKey}.collapsed`, "1");
      } else {
        window.localStorage.removeItem(`${storageKey}.collapsed`);
      }
    } catch {
      // storage unavailable: the state just isn't kept
    }
  }, [collapsed, storageKey]);

  const resizeTo = (next: number) =>
    setHeight(clampHeight(next, maxHeightFor(sectionRef.current)));

  const onHandleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    resizeTo(height + (event.key === "ArrowUp" ? KEY_STEP : -KEY_STEP));
  };

  // Arrow keys, Home and End move along the tab strip, as in a native tablist.
  const onTabsKeyDown = (event: React.KeyboardEvent) => {
    const index = tabs.findIndex((item) => item.value === active);
    const last = tabs.length - 1;
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (index - 1 + tabs.length) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    const target = tabs[next].value;
    onSelect(target);
    tabRefs.current.get(target)?.focus();
  };

  const onTabClick = (value: T) => {
    if (value !== active) onSelect(value);
    setCollapsed(false);
  };

  return (
    <section
      ref={sectionRef}
      aria-label={label}
      data-testid="bottom-panel"
      data-collapsed={collapsed ? "true" : "false"}
      style={
        collapsed
          ? undefined
          : {
              height,
              // The content above keeps its room when the window is short.
              maxHeight: `calc(100% - ${MIN_CONTENT_HEIGHT}px)`,
            }
      }
      className="relative flex flex-none flex-col border-t border-cx-border bg-cx-bg"
    >
      {!collapsed && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize panel"
          aria-valuenow={height}
          aria-valuemin={MIN_HEIGHT}
          tabIndex={0}
          onKeyDown={onHandleKeyDown}
          onPointerDown={(event) => {
            dragging.current = true;
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!dragging.current || !sectionRef.current) return;
            resizeTo(
              sectionRef.current.getBoundingClientRect().bottom - event.clientY,
            );
          }}
          onPointerUp={() => {
            dragging.current = false;
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
          className={cn(
            "absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize touch-none",
            "hover:bg-cx-accent/40 focus-visible:bg-cx-accent focus-visible:outline-none",
          )}
        />
      )}

      <div
        onDoubleClick={(event) => {
          if ((event.target as HTMLElement).closest("button, a")) return;
          setCollapsed((value) => !value);
        }}
        className="flex h-9 flex-none items-center gap-4 border-b border-cx-border px-4"
      >
        <div
          role="tablist"
          aria-label={tabsLabel}
          onKeyDown={onTabsKeyDown}
          className="flex h-full min-w-[6rem] flex-1 gap-5 overflow-x-auto"
        >
          {tabs.map((item) => {
            const selected = item.value === active;
            return (
              <button
                key={item.value}
                ref={(el) => {
                  if (el) tabRefs.current.set(item.value, el);
                  else tabRefs.current.delete(item.value);
                }}
                type="button"
                role="tab"
                id={tabId(item.value)}
                aria-selected={selected}
                aria-controls={bodyId}
                tabIndex={selected ? 0 : -1}
                onClick={() => onTabClick(item.value)}
                className={cn(
                  "-mb-px h-full whitespace-nowrap border-b-2 px-0.5 text-[13.5px] font-medium",
                  selected
                    ? "border-cx-accent text-cx-fg"
                    : "border-transparent text-cx-muted hover:text-cx-fg",
                )}
              >
                {item.label}
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {toolbar}
          <button
            type="button"
            aria-label={collapsed ? "Expand panel" : "Collapse panel"}
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            onClick={() => setCollapsed((value) => !value)}
            className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-md text-cx-muted hover:bg-cx-sub hover:text-cx-fg"
          >
            {collapsed ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>

      {/* Kept mounted while collapsed so a log viewer keeps its state. */}
      <div
        role="tabpanel"
        id={bodyId}
        aria-labelledby={tabId(active)}
        hidden={collapsed}
        className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3"
      >
        {children}
      </div>
    </section>
  );
}

export default BottomPanel;
