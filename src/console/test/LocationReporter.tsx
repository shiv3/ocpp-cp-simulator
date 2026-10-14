import { useEffect } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

/** What `renderConsole`'s `onLocationChange` reports on every navigation. */
export interface ReportedLocation {
  pathname: string;
  search: string;
  state: unknown;
  /** How the router got here: `PUSH` / `REPLACE` / `POP` (`POP` on mount). */
  type: "PUSH" | "REPLACE" | "POP";
}

/** Renders nothing; tells the test where the MemoryRouter currently is. */
export default function LocationReporter({
  onChange,
}: {
  onChange: (location: ReportedLocation) => void;
}) {
  const location = useLocation();
  const type = useNavigationType();
  useEffect(() => {
    onChange({
      pathname: location.pathname,
      search: location.search,
      state: location.state,
      type,
    });
  }, [location, type, onChange]);
  return null;
}
