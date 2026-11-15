import React from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import type { LibraryEditorUser } from "./editorTypes";

/** The connectors using the Library scenario being edited. */
export const LibraryUsedBy: React.FC<{ users: LibraryEditorUser[] }> = ({
  users,
}) => {
  const { t } = useTranslation();
  return (
    <div
      data-testid="library-used-by"
      className="mb-4 flex flex-wrap items-center gap-1.5"
    >
      <span className="mr-1 text-[11px] font-medium uppercase tracking-wide text-cx-muted">
        {t("scenarios.editor.usedBy")}
      </span>
      {users.length === 0 ? (
        <span className="text-sm text-cx-muted">
          {t("scenarios.editor.noConnectorUses")}
        </span>
      ) : (
        users.map((user) => (
          <Link
            key={`${user.cpId}:${user.connectorId ?? "cp"}`}
            to={
              user.connectorId === null
                ? `/cp/${encodeURIComponent(user.cpId)}`
                : `/cp/${encodeURIComponent(user.cpId)}?connector=${user.connectorId}`
            }
            title={user.running ? t("scenarios.editor.running") : undefined}
            className="inline-flex items-center gap-1.5 rounded-md border border-cx-border bg-cx-card px-2 py-0.5 font-mono text-xs text-cx-fg2 hover:border-cx-border-strong hover:text-cx-fg"
          >
            {user.running && (
              <span
                aria-label={t("scenarios.editor.running")}
                className="h-[7px] w-[7px] rounded-full bg-cx-blue"
              />
            )}
            {user.cpId}
            {user.connectorId === null
              ? ` · ${t("scenarios.editor.chargePoint")}`
              : ` #${user.connectorId}`}
          </Link>
        ))
      )}
    </div>
  );
};
