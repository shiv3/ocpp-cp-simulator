import { useCallback, useEffect, useState } from "react";

/** "fit": the whole graph visible; a number: that scale (1 = 100%). */
export type ZoomMode = "fit" | number;

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 2;
export const ZOOM_STEP = 1.25;
export const ZOOM_KEY = "ocpp-cp.console.graph.zoom";

export const clampZoom = (z: number): number =>
  Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));

export function readStoredZoom(key: string = ZOOM_KEY): ZoomMode {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === "fit") return "fit";
    const n = Number(raw);
    if (raw !== null && Number.isFinite(n) && n > 0) return clampZoom(n);
  } catch {
    // Storage blocked: the default.
  }
  return 1;
}

function storeZoom(mode: ZoomMode, key: string): void {
  try {
    window.localStorage.setItem(key, String(mode));
  } catch {
    // Storage blocked: the zoom just is not remembered.
  }
}

/** The scale that shows a `width` x `height` graph whole in a viewport,
 *  never enlarging past 100%. */
export function fitZoom(
  width: number,
  height: number,
  viewW: number,
  viewH: number,
): number {
  if (width <= 0 || height <= 0 || viewW <= 0) return 1;
  const byWidth = viewW / width;
  const byHeight = viewH > 0 ? viewH / height : byWidth;
  return clampZoom(Math.min(1, byWidth, byHeight));
}

/** The graph's zoom, remembered in localStorage. */
export function useStoredZoom(key: string = ZOOM_KEY): {
  mode: ZoomMode;
  setMode: (mode: ZoomMode) => void;
} {
  const [mode, setModeState] = useState<ZoomMode>(() => readStoredZoom(key));
  const setMode = useCallback(
    (next: ZoomMode) => {
      setModeState(next);
      storeZoom(next, key);
    },
    [key],
  );
  return { mode, setMode };
}

/** The element's content-box size, kept current (jsdom has no observer:
 *  the size stays 0). */
export function useElementSize(
  ref: React.RefObject<HTMLElement | null>,
  /** Changes when the element is (re)mounted. */
  mounted?: unknown,
): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const read = () =>
      setSize((prev) =>
        prev.w === el.clientWidth && prev.h === el.clientHeight
          ? prev
          : { w: el.clientWidth, h: el.clientHeight },
      );
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, mounted]);
  return size;
}
