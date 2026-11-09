import { useCallback, useState } from "react";

const read = (key: string): boolean => {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
};

/** Whether a side panel is collapsed, remembered in localStorage. */
export function useCollapsedPanel(key: string): {
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
} {
  const [collapsed, setState] = useState(() => read(key));
  const setCollapsed = useCallback(
    (next: boolean) => {
      setState(next);
      try {
        if (next) window.localStorage.setItem(key, "1");
        else window.localStorage.removeItem(key);
      } catch {
        // Storage blocked: not remembered.
      }
    },
    [key],
  );
  return { collapsed, setCollapsed };
}

/** The grid the views and a side panel share: the panel beside the views
 *  when there is room (a container query), a thin rail when collapsed. */
export const sidePanelGrid = (collapsed: boolean, breakpoint: "720" | "860") =>
  breakpoint === "860"
    ? collapsed
      ? "@[860px]:grid-cols-[minmax(0,1fr)_2.25rem]"
      : "@[860px]:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]"
    : collapsed
      ? "@[720px]:grid-cols-[minmax(0,1fr)_2.25rem]"
      : "@[720px]:grid-cols-[minmax(0,1fr)_minmax(260px,340px)]";
