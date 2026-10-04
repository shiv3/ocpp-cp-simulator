import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { cn } from "@/lib/utils";

const STORAGE_KEY = "ocpp-cp.console.panel-width";
const MIN_WIDTH = 360;
/** Room the page keeps beside the panel when the operator drags it wide. */
const MIN_PAGE_WIDTH = 320;
const KEY_STEP = 32;
/** Used until the operator resizes; follows the viewport like the CSS says. */
const DEFAULT_WIDTH_CSS = "min(680px, 48vw)";

function clampWidth(width: number): number {
  // innerWidth is 0 in jsdom: there is no viewport to leave room in.
  const max =
    window.innerWidth > 0
      ? Math.max(MIN_WIDTH, window.innerWidth - MIN_PAGE_WIDTH)
      : Infinity;
  return Math.round(Math.min(Math.max(width, MIN_WIDTH), max));
}

function defaultWidth(): number {
  return clampWidth(Math.min(680, window.innerWidth * 0.48));
}

function readStoredWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) ? clampWidth(value) : null;
  } catch {
    return null;
  }
}

export interface SidePanelProps {
  open: boolean;
  onClose(): void;
  /** Accessible name of the panel (`aria-label`). */
  label: string;
  children: React.ReactNode;
}

/**
 * A resizable panel pinned to the right edge of the window, beside the page
 * (from 1100 px up; below that it covers the page). Generic on purpose: the
 * caller owns what is inside — including a close button — and what `open`
 * means. Esc calls `onClose` unless something else already handled the key
 * (a Radix dialog inside the panel keeps its own Esc).
 */
const SidePanel: React.FC<SidePanelProps> = ({
  open,
  onClose,
  label,
  children,
}) => {
  // null = nothing stored and not resized yet: the CSS default applies.
  const [width, setWidth] = useState<number | null>(readStoredWidth);
  const dragging = useRef(false);

  const widthCss = width === null ? DEFAULT_WIDTH_CSS : `${width}px`;

  // The page's own margin (src/index.css) reads the width from the root, as
  // the panel and the page are siblings in the DOM.
  useLayoutEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    root.setAttribute("data-side-panel", "");
    root.style.setProperty("--console-panel-width", widthCss);
    return () => {
      root.removeAttribute("data-side-panel");
      root.style.removeProperty("--console-panel-width");
    };
  }, [open, widthCss]);

  useEffect(() => {
    if (width === null) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, String(width));
    } catch {
      // storage unavailable (private window): the width just isn't kept
    }
  }, [width]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const onHandleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const delta = event.key === "ArrowLeft" ? KEY_STEP : -KEY_STEP;
      setWidth(clampWidth((width ?? defaultWidth()) + delta));
    },
    [width],
  );

  if (!open) return null;

  return (
    <aside
      aria-label={label}
      style={{ "--console-panel-width": widthCss } as React.CSSProperties}
      className="fixed inset-y-0 right-0 z-30 flex w-full flex-col border-l border-gray-200 bg-gray-100 shadow-2xl min-[1100px]:w-[var(--console-panel-width)] dark:border-gray-800 dark:bg-gray-900"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize side panel"
        aria-valuenow={width ?? defaultWidth()}
        aria-valuemin={MIN_WIDTH}
        tabIndex={0}
        onKeyDown={onHandleKeyDown}
        onPointerDown={(event) => {
          dragging.current = true;
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (dragging.current) {
            setWidth(clampWidth(window.innerWidth - event.clientX));
          }
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
        // Hidden below 1100 px, where the panel is full width and has no
        // edge to drag.
        className={cn(
          "absolute inset-y-0 -left-1 z-10 hidden w-2 cursor-col-resize touch-none min-[1100px]:block",
          "hover:bg-blue-500/40 focus-visible:bg-blue-500/60 focus-visible:outline-none",
        )}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </aside>
  );
};

export default SidePanel;
