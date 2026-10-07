import React from "react";
import { useSearchParams } from "react-router-dom";

import ScenarioEditorContent from "./scenarios/edit/ScenarioEditorContent";

/**
 * The per-connector scenario editor (`/scenarios/edit?cp=&connector=&id=`):
 * a definition stored in one charge point's scope, edited in place. A Library
 * scenario is edited inline on the Library tab instead, with the same
 * content.
 */
const ScenarioEditPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const cpId = searchParams.get("cp") ?? "";
  const connectorParam = searchParams.get("connector") ?? "";
  const connectorId = connectorParam === "" ? null : Number(connectorParam);
  const scenarioId = searchParams.get("id") ?? "";

  return (
    <div className="p-6">
      <ScenarioEditorContent
        cpId={cpId}
        connectorId={connectorId}
        scenarioId={scenarioId}
      />
    </div>
  );
};

export default ScenarioEditPage;
