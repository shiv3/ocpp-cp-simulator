import { useTranslation } from "react-i18next";
import React, { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  CatalogMake,
  CatalogModel,
  CatalogModelQuery,
  CatalogPage,
  CatalogVariant,
  CatalogVariantSummary,
  VehicleCatalog,
} from "@ocpp-cp-simulator/core/cp/domain/vehicle/VehicleCatalog";
import { type VehicleProfile } from "@ocpp-cp-simulator/core/cp/domain/vehicle/VehicleProfile";
import { cn } from "@/lib/utils";

import { FILTER_INPUT_CLASS, FILTER_SELECT_CLASS } from "../filterStyles";
import {
  describeCatalogError,
  useVehicleCatalog,
} from "../../lib/vehicleCatalog";
import { describeError } from "../../pages/cp/connectorActions";
import { CatalogAccessPanel, PickList } from "./ImportVehicleCatalogParts";
import { VariantForm } from "./ImportVehicleVariantForm";

export interface ImportVehicleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Stores the new profile; the dialog closes once it resolves. */
  onSave: (profile: VehicleProfile) => Promise<unknown>;
  /** Test seam for the new profile's id and import time. */
  newId?: () => string;
  now?: () => string;
}

/**
 * Import a vehicle from Open EV Directory into a saved profile (#458).
 *
 * Nothing is chosen for the user: the source record whose specs are kept and
 * the curve (or none) are both explicit picks, every curve shows its source
 * and how much that source says about it, and a value the source does not
 * give stays empty until the user fills it in.
 */
const ImportVehicleDialog: React.FC<ImportVehicleDialogProps> = (props) => {
  const { t } = useTranslation();
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="flex max-h-[calc(100vh-32px)] w-[min(880px,calc(100vw-32px))] max-w-none flex-col gap-0 overflow-hidden border-cx-border-strong bg-cx-card p-0 text-cx-fg sm:rounded-xl">
        <div className="border-b border-cx-border py-3 pl-4 pr-12">
          <DialogTitle className="text-[15px] font-semibold tracking-normal">
            {t("consoleShared.import.title")}
          </DialogTitle>
          <DialogDescription className="mt-0.5 text-[12.5px] text-cx-muted">
            {t("consoleShared.import.subtitle")}
          </DialogDescription>
        </div>
        {props.open && <ImportBody {...props} />}
      </DialogContent>
    </Dialog>
  );
};

const ImportBody: React.FC<ImportVehicleDialogProps> = ({
  onOpenChange,
  onSave,
  newId = newVehicleProfileId,
  now = () => new Date().toISOString(),
}) => {
  const { t } = useTranslation();
  const access = useVehicleCatalog();
  const catalog = access.catalog;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [makes, setMakes] = useState<CatalogMake[] | null>(null);
  const [makeId, setMakeId] = useState("");
  const [query, setQuery] = useState("");
  const [models, setModels] = useState<CatalogPage<CatalogModel> | null>(null);
  const [model, setModel] = useState<CatalogModel | null>(null);
  const [variants, setVariants] =
    useState<CatalogPage<CatalogVariantSummary> | null>(null);
  const [variant, setVariant] = useState<CatalogVariant | null>(null);

  // Only the latest request may update the dialog: a slower answer to an
  // earlier click (another model, another variant) is dropped.
  const latest = useRef(0);
  const run = async <T,>(call: (c: VehicleCatalog) => Promise<T>) => {
    if (!catalog) return null;
    const request = ++latest.current;
    setBusy(true);
    setError(null);
    try {
      const result = await call(catalog);
      return request === latest.current ? result : null;
    } catch (err) {
      if (request === latest.current) {
        setError(describeCatalogError(err, access.mode));
      }
      return null;
    } finally {
      if (request === latest.current) setBusy(false);
    }
  };

  // The makes, once a catalog is reachable; a failure is shown, the search
  // by model name still works without them.
  useEffect(() => {
    if (!catalog) return;
    let cancelled = false;
    makesOf(catalog).then(
      (list) => {
        if (cancelled) return;
        setMakes(list);
        // A key typed after a refused first attempt: the refusal is over.
        setError(null);
      },
      (err: unknown) => {
        if (!cancelled) setError(describeCatalogError(err, access.mode));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [catalog, access.mode]);

  // The search the shown models answer, so paging stays on it even after
  // the Make or Model field is edited.
  const [searched, setSearched] = useState<CatalogModelQuery | null>(null);
  const searchModels = async (searchQuery: CatalogModelQuery) => {
    const result = await run((c) => c.searchModels(searchQuery));
    if (result) {
      setSearched(searchQuery);
      setModels(result);
      setModel(null);
      setVariants(null);
      setVariant(null);
    }
  };
  const search = () =>
    searchModels({ makeId: makeId || undefined, model: query, page: 0 });

  const openModel = async (m: CatalogModel, page = 0) => {
    const result = await run((c) => c.listVariants(m.id, page));
    if (result) {
      setModel(m);
      setVariants(result);
      setVariant(null);
    }
  };

  const openVariant = async (id: string) => {
    const result = await run((c) => c.getVariant(id));
    if (result) setVariant(result);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-[18px] pb-[18px] pt-4 text-[13px]">
      <CatalogAccessPanel access={access} />

      {catalog && (
        <section
          aria-label={t("consoleShared.import.search")}
          className="flex flex-wrap items-end gap-2"
        >
          <label className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.06em] text-cx-faint">
            {t("consoleShared.import.make")}
            <select
              aria-label={t("consoleShared.import.make")}
              value={makeId}
              onChange={(e) => setMakeId(e.target.value)}
              className={cn(FILTER_SELECT_CLASS, "min-w-[180px] normal-case")}
            >
              <option value="">{t("consoleShared.import.anyMake")}</option>
              {(makes ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-1 flex-col gap-1 text-[11px] uppercase tracking-[0.06em] text-cx-faint">
            {t("consoleShared.import.model")}
            <input
              aria-label={t("consoleShared.import.model")}
              value={query}
              placeholder={t("consoleShared.import.modelPlaceholder")}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void search();
              }}
              className={cn(FILTER_INPUT_CLASS, "normal-case tracking-normal")}
            />
          </label>
          <Button
            size="sm"
            onClick={() => void search()}
            disabled={busy || (!makeId && !query.trim())}
          >
            {t("consoleShared.import.search")}
          </Button>
        </section>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-md border border-cx-rose/40 bg-cx-rose/10 px-3 py-2 text-cx-rose"
        >
          {error}
        </p>
      )}

      {models && !variant && (
        <PickList
          label={t("consoleShared.import.models")}
          page={models}
          empty={t("consoleShared.import.noModel")}
          onPage={(p) => {
            if (searched) void searchModels({ ...searched, page: p });
          }}
          render={(m) => (
            <button
              type="button"
              onClick={() => void openModel(m)}
              aria-pressed={model?.id === m.id}
              className={cn(
                "w-full rounded-md px-2 py-1 text-left hover:bg-cx-sub",
                model?.id === m.id && "bg-cx-sub",
              )}
            >
              {m.makeName} {m.name}{" "}
              <span className="text-cx-muted">
                ·{" "}
                {t("consoleShared.import.variantCount", {
                  count: m.variantCount,
                })}
              </span>
            </button>
          )}
        />
      )}

      {model && variants && !variant && (
        <PickList
          label={t("consoleShared.import.variantsOf", {
            make: model.makeName,
            model: model.name,
          })}
          page={variants}
          empty={t("consoleShared.import.noVariant")}
          onPage={(p) => void openModel(model, p)}
          render={(v) => (
            <button
              type="button"
              onClick={() => void openVariant(v.id)}
              className="w-full rounded-md px-2 py-1 text-left hover:bg-cx-sub"
            >
              {v.name}{" "}
              <span className="text-cx-muted">
                ·{" "}
                {t("consoleShared.import.sources", {
                  sources: v.sources.join(", "),
                })}{" "}
                ·{" "}
                {t("consoleShared.import.curve", {
                  count: v.chargingCurveCount,
                })}
              </span>
            </button>
          )}
        />
      )}

      {variant && (
        <VariantForm
          key={variant.id}
          variant={variant}
          busy={busy}
          onBack={() => setVariant(null)}
          onCancel={() => onOpenChange(false)}
          onSave={async (draft) => {
            setBusy(true);
            setError(null);
            try {
              // Stamped here, inside the try: minting the id can throw.
              const at = now();
              await onSave({
                ...draft,
                id: newId(),
                createdAt: at,
                updatedAt: at,
                origin: draft.origin
                  ? { ...draft.origin, importedAt: at }
                  : null,
              });
              onOpenChange(false);
            } catch (err) {
              setError(
                t("consoleShared.import.notSaved", {
                  error: describeError(err),
                }),
              );
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
    </div>
  );
};

/**
 * The catalog's makes, read once per catalog: reopening the dialog does not
 * spend another request of a rate-limited key. A failure is not kept.
 */
const makesCache = new WeakMap<VehicleCatalog, Promise<CatalogMake[]>>();
function makesOf(catalog: VehicleCatalog): Promise<CatalogMake[]> {
  let pending = makesCache.get(catalog);
  if (!pending) {
    pending = catalog.listMakes();
    pending.catch(() => makesCache.delete(catalog));
    makesCache.set(catalog, pending);
  }
  return pending;
}

/**
 * A new profile id. `crypto.randomUUID` exists only in secure contexts
 * (HTTPS, localhost); a daemon's console reached over plain HTTP from another
 * host is not one, so fall back to `getRandomValues`, which every context has.
 */
function newVehicleProfileId(): string {
  if (typeof crypto.randomUUID === "function") {
    return `vp_${crypto.randomUUID()}`;
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `vp_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export default ImportVehicleDialog;
