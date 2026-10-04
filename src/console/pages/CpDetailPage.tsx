import React, { useCallback } from "react";
import { useParams, useSearchParams } from "react-router-dom";

import CpDetailContent from "./cp/CpDetailContent";

/**
 * The full charge point page (`/cp/:cpId`). The body lives in
 * `CpDetailContent`, shared with the Charge Points list's side panel; this
 * wrapper only keeps the selected connector in the URL (`?connector=`).
 */
const CpDetailPage: React.FC = () => {
  const { cpId = "" } = useParams<{ cpId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get("connector");
  const selectedConnectorId =
    raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;

  const onSelectConnector = useCallback(
    (id: number) => {
      const next = new URLSearchParams(searchParams);
      next.set("connector", String(id));
      // Choosing a connector is not a navigation worth a history entry.
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  return (
    <CpDetailContent
      cpId={cpId}
      variant="page"
      selectedConnectorId={selectedConnectorId}
      onSelectConnector={onSelectConnector}
    />
  );
};

export default CpDetailPage;
