import { useEffect, useState } from "react";

/** The current time, refreshed every `intervalMs`: re-renders a component
 *  that shows a relative time ("10s ago") with no event of its own. */
export function useNow(intervalMs = 5_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
