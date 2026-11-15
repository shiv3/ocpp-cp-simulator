import { useTranslation } from "react-i18next";
import React, { useState } from "react";

import { Button } from "@/components/ui/button";
import type { CatalogPage } from "@ocpp-cp-simulator/core/cp/domain/vehicle/VehicleCatalog";
import { cn } from "@/lib/utils";

import { FILTER_INPUT_CLASS } from "../filterStyles";
import { OED_KEY_HELP_URL, type CatalogAccess } from "../../lib/vehicleCatalog";

/** Fills `{name}` slots of a message with elements (a <code> or a link). */
function fillSlots(
  text: string,
  slots: Record<string, React.ReactNode>,
): React.ReactNode[] {
  return text.split(/(\{\w+\})/).map((part, index) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    return name !== undefined && name in slots ? (
      <React.Fragment key={index}>{slots[name]}</React.Fragment>
    ) : (
      part
    );
  });
}

/** Where the catalog is, and the key in Local mode. */
export const CatalogAccessPanel: React.FC<{ access: CatalogAccess }> = ({
  access,
}) => {
  const { t } = useTranslation();
  const [keyDraft, setKeyDraft] = useState("");
  if (access.mode === "remote") {
    if (access.configured === false) {
      return (
        <p
          role="status"
          className="rounded-md border border-cx-border bg-cx-sub px-3 py-2"
        >
          {fillSlots(t("consoleShared.import.remoteOff"), {
            flag: <code>--oed-base-url none</code>,
            env: <code>OED_BASE_URL=none</code>,
            flag2: <code>--oed-base-url</code>,
          })}
        </p>
      );
    }
    return (
      <p className="text-[12.5px] text-cx-muted">
        {access.authenticated === false
          ? t("consoleShared.import.viaDaemonAnonymous")
          : t("consoleShared.import.viaDaemonKey")}
      </p>
    );
  }
  return (
    <section
      aria-label={t("consoleShared.import.access")}
      className="flex flex-col gap-2"
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.06em] text-cx-faint">
          {t("consoleShared.import.apiUrl")}
          <input
            aria-label={t("consoleShared.import.urlLabel")}
            defaultValue={access.baseUrl}
            placeholder="https://…"
            onBlur={(e) => access.setBaseUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") access.setBaseUrl(e.currentTarget.value);
            }}
            className={cn(FILTER_INPUT_CLASS, "normal-case tracking-normal")}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.06em] text-cx-faint">
          {t("consoleShared.import.yourKey")}
          <span className="flex gap-1.5 normal-case tracking-normal">
            <input
              aria-label={t("consoleShared.import.keyLabel")}
              type="password"
              autoComplete="off"
              value={keyDraft}
              placeholder={
                access.hasKey ? t("consoleShared.import.keySet") : "evd_live_…"
              }
              onChange={(e) => setKeyDraft(e.target.value)}
              className={cn(FILTER_INPUT_CLASS, "min-w-0 flex-1")}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                access.setApiKey(keyDraft);
                setKeyDraft("");
              }}
              disabled={!keyDraft.trim()}
            >
              {t("consoleShared.import.use")}
            </Button>
            {access.hasKey && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => access.setApiKey(null)}
              >
                {t("consoleShared.import.forget")}
              </Button>
            )}
          </span>
        </label>
      </div>
      {access.baseUrlError && (
        <p role="alert" className="text-xs text-cx-rose">
          {access.baseUrlError}
        </p>
      )}
      <p className="text-xs text-cx-muted">
        {fillSlots(t("consoleShared.import.keyNote"), {
          link: (
            <a
              href={OED_KEY_HELP_URL}
              target="_blank"
              rel="noreferrer"
              className="text-cx-accent underline"
            >
              {t("consoleShared.import.apiKeysLink")}
            </a>
          ),
        })}
      </p>
    </section>
  );
};

export function PickList<T extends { id: string }>({
  label,
  page,
  empty,
  onPage,
  render,
}: {
  label: string;
  page: CatalogPage<T>;
  empty: string;
  onPage: (page: number) => void;
  render: (item: T) => React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section aria-label={label} className="flex flex-col gap-1">
      <h3 className="text-[11px] uppercase tracking-[0.06em] text-cx-faint">
        {label} · {page.totalItems}
      </h3>
      {page.items.length === 0 ? (
        <p className="text-cx-muted">{empty}</p>
      ) : (
        <ul className="max-h-56 overflow-auto rounded-md border border-cx-border">
          {page.items.map((item) => (
            <li key={item.id}>{render(item)}</li>
          ))}
        </ul>
      )}
      {page.totalPages > 1 && (
        <div className="flex items-center gap-2 text-xs text-cx-muted">
          <Button
            size="sm"
            variant="ghost"
            disabled={page.page === 0}
            onClick={() => onPage(page.page - 1)}
          >
            {t("consoleShared.import.previous")}
          </Button>
          {t("consoleShared.import.pageOf", {
            page: page.page + 1,
            total: page.totalPages,
          })}
          <Button
            size="sm"
            variant="ghost"
            disabled={page.page + 1 >= page.totalPages}
            onClick={() => onPage(page.page + 1)}
          >
            {t("consoleShared.import.next")}
          </Button>
        </div>
      )}
    </section>
  );
}
