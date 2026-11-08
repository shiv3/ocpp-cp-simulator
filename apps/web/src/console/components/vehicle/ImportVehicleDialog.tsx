import { useTranslation } from "react-i18next";
import React, { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { FIELD_LABELS, FIELD_UNITS } from "@/components/vehicle/vehicleChoice";
import type {
  CatalogCurve,
  CatalogMake,
  CatalogModel,
  CatalogModelQuery,
  CatalogPage,
  CatalogVariant,
  CatalogVariantSummary,
  VehicleCatalog,
} from "@ocpp-cp-simulator/core/cp/domain/vehicle/VehicleCatalog";
import { profileFromCatalog } from "@ocpp-cp-simulator/core/cp/domain/vehicle/importProfile";
import {
  availableCurrentTypes,
  EDITABLE_SPEC_FIELDS as EDITABLE,
  type EditableSpecField,
  type VehicleProfile,
} from "@ocpp-cp-simulator/core/cp/domain/vehicle/VehicleProfile";
import { cn } from "@/lib/utils";

import { FILTER_INPUT_CLASS, FILTER_SELECT_CLASS } from "../filterStyles";
import {
  describeCatalogError,
  OED_KEY_HELP_URL,
  useVehicleCatalog,
  type CatalogAccess,
} from "../../lib/vehicleCatalog";
import { describeError } from "../../pages/cp/connectorActions";
import CurvePreview from "./CurvePreview";
import { t as translate, type MessageKey, type TFunction } from "@/i18n";

export interface ImportVehicleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Stores the new profile; the dialog closes once it resolves. */
  onSave: (profile: VehicleProfile) => Promise<unknown>;
  /** Test seam for the new profile's id and import time. */
  newId?: () => string;
  now?: () => string;
}

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

const shown = (value: number | null) =>
  value == null ? translate("consoleShared.vehicle.missing") : String(value);

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

/** Where the catalog is, and the key in Local mode. */
const CatalogAccessPanel: React.FC<{ access: CatalogAccess }> = ({
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

function PickList<T extends { id: string }>({
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

const NO_CURVE = "__none__";

/**
 * The values typed for what the picked record lacks, as its inputs show; a
 * value typed for another record the user then left is not kept.
 */
function filledOverrides(
  picked: VehicleProfile,
  filled: Partial<Record<EditableSpecField, string>>,
): VehicleProfile["overrides"] {
  const overrides: VehicleProfile["overrides"] = {};
  for (const field of EDITABLE) {
    if (picked.specs[field] != null) continue;
    const value = Number(filled[field]);
    if (filled[field]?.trim() && Number.isFinite(value) && value >= 0) {
      overrides[field] = value;
    }
  }
  return overrides;
}

/** What still stops the import, or null when it can be saved. */
function blockerOf(
  t: TFunction,
  recordPicked: boolean,
  curvePicked: boolean,
  draft: VehicleProfile | null,
): string | null {
  if (!recordPicked) return t("consoleShared.import.blockRecord");
  if (!curvePicked) return t("consoleShared.import.blockCurve");
  if (!draft) return null;
  if (!draft.name) return t("consoleShared.import.blockName");
  const capacity =
    draft.overrides.usableBatteryKwh ?? draft.specs.usableBatteryKwh;
  if (capacity == null) {
    return t("consoleShared.import.blockCapacity");
  }
  if (availableCurrentTypes(draft).length === 0) {
    return t("consoleShared.import.blockPower");
  }
  return null;
}

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

const VariantForm: React.FC<{
  variant: CatalogVariant;
  busy: boolean;
  onBack: () => void;
  onCancel: () => void;
  /** Receives the draft; the caller stamps its id and import time. */
  onSave: (draft: VehicleProfile) => Promise<void>;
}> = ({ variant, busy, onBack, onCancel, onSave }) => {
  const { t } = useTranslation();
  const [recordKey, setRecordKey] = useState<string | null>(null);
  // No curve is preselected, "no curve" included: the user says which.
  const [curveChoice, setCurveChoice] = useState<string | null>(null);
  const [name, setName] = useState(`${variant.makeName} ${variant.name}`);
  const [filled, setFilled] = useState<
    Partial<Record<EditableSpecField, string>>
  >({});

  const record = variant.sourceRecords.find((r) => r.key === recordKey) ?? null;
  // The picked record and curve, rebuilt only when the pick changes; the name
  // and the filled-in values go on top.
  const picked = useMemo(() => {
    if (!record || curveChoice === null) return null;
    const result = profileFromCatalog(
      variant,
      {
        sourceRecordKey: record.key,
        curveId: curveChoice === NO_CURVE ? null : curveChoice,
      },
      { id: "draft", now: "draft" },
    );
    return result.ok ? result.profile : null;
  }, [variant, record, curveChoice]);
  const draft: VehicleProfile | null = picked && {
    ...picked,
    name: name.trim(),
    overrides: filledOverrides(picked, filled),
  };
  const blocker = blockerOf(t, record !== null, curveChoice !== null, draft);

  return (
    <section
      aria-label={t("consoleShared.import.variant")}
      className="flex flex-col gap-4"
    >
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          {t("consoleShared.import.back")}
        </Button>
        <h3 className="text-[15px] font-semibold">
          {variant.makeName} {variant.name}
        </h3>
        {variant.datasetVersion && (
          <span className="font-mono text-xs text-cx-faint">
            {variant.datasetVersion}
          </span>
        )}
      </div>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-[11px] uppercase tracking-[0.06em] text-cx-faint">
          {t("consoleShared.import.specsSource")}
        </legend>
        <p className="text-xs text-cx-muted">
          {t("consoleShared.import.specsNote")}
        </p>
        {variant.sourceRecords.map((r) => (
          <label
            key={r.key}
            className="flex items-start gap-2 rounded-md border border-cx-border px-2.5 py-2"
          >
            <input
              type="radio"
              name="source-record"
              aria-label={t("consoleShared.import.specsFrom", {
                source: r.sourceId,
              })}
              checked={recordKey === r.key}
              onChange={() => setRecordKey(r.key)}
              className="mt-1"
            />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">
                {r.sourceId}{" "}
                <span className="font-normal text-cx-muted">
                  · {r.makeName} {r.modelName} {r.variantName}
                  {r.year != null ? ` · ${r.year}` : ""}
                </span>
              </span>
              <span className="font-mono text-xs text-cx-fg2">
                {t("consoleShared.import.recordSpecs", {
                  battery: shown(r.specs.usableBatteryKwh),
                  ac: shown(r.specs.acMaxKw),
                  phases: shown(r.specs.acPhases),
                  dc: shown(r.specs.dcMaxKw),
                })}
              </span>
              <span className="text-xs text-cx-faint">
                {[...r.specs.acConnectors, ...r.specs.dcConnectors].join(
                  ", ",
                ) || t("consoleShared.import.noConnector")}{" "}
                · {r.license.name}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-[11px] uppercase tracking-[0.06em] text-cx-faint">
          {t("consoleShared.import.dcCurve")}
        </legend>
        {variant.curves.map((c) => (
          <CurveOption
            key={c.id}
            curve={c}
            checked={curveChoice === c.id}
            onChange={() => setCurveChoice(c.id)}
          />
        ))}
        <label className="flex items-center gap-2 rounded-md border border-cx-border px-2.5 py-2">
          <input
            type="radio"
            name="curve"
            aria-label={t("consoleShared.import.noCurveLabel")}
            checked={curveChoice === NO_CURVE}
            onChange={() => setCurveChoice(NO_CURVE)}
          />
          {t("consoleShared.import.noCurveOption")}
          {variant.curves.length === 0 && (
            <span className="text-cx-muted">
              {" "}
              {t("consoleShared.import.noSourceCurve")}
            </span>
          )}
        </label>
      </fieldset>

      {record && (
        <fieldset className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-x-3.5 gap-y-2.5">
          <legend className="mb-1 text-[11px] uppercase tracking-[0.06em] text-cx-faint">
            {t("consoleShared.import.profile")}
          </legend>
          <label className="col-span-full flex flex-col gap-1 text-[11px] uppercase tracking-[0.06em] text-cx-faint">
            {t("consoleShared.vehicle.name")}
            <input
              aria-label={t("consoleShared.vehicle.profileName")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={cn(FILTER_INPUT_CLASS, "normal-case tracking-normal")}
            />
          </label>
          {EDITABLE.filter((f) => record.specs[f] == null).map((field) => (
            <label
              key={field}
              className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.06em] text-cx-amber"
            >
              {t("consoleShared.import.missingSuffix", {
                field: FIELD_LABELS[field],
              })}
              <span className="flex items-center gap-1.5 normal-case tracking-normal">
                <input
                  type="number"
                  min={0}
                  aria-label={t("consoleShared.import.missingField", {
                    field: FIELD_LABELS[field],
                  })}
                  value={filled[field] ?? ""}
                  onChange={(e) =>
                    setFilled((prev) => ({ ...prev, [field]: e.target.value }))
                  }
                  className={cn(FILTER_INPUT_CLASS, "min-w-0 flex-1 font-mono")}
                />
                {FIELD_UNITS[field] && (
                  <span className="text-xs text-cx-muted">
                    {FIELD_UNITS[field]}
                  </span>
                )}
              </span>
            </label>
          ))}
        </fieldset>
      )}

      {draft?.origin && (
        <div className="rounded-md border border-cx-border bg-cx-sub px-3 py-2 text-xs text-cx-fg2">
          <p className="mb-1 font-medium text-cx-fg">
            {t("consoleShared.import.attributionKept")}
          </p>
          {draft.origin.licenses.map((l) => (
            <p key={`${l.sourceId}:${l.id}`}>{l.attribution}</p>
          ))}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        {blocker && (
          <span className="mr-auto text-xs text-cx-muted">{blocker}</span>
        )}
        <Button variant="outline" onClick={onCancel}>
          {t("consoleShared.import.cancel")}
        </Button>
        <Button
          disabled={busy || blocker !== null || !draft}
          onClick={() => {
            if (draft) void onSave(draft);
          }}
        >
          {t("consoleShared.import.saveProfile")}
        </Button>
      </div>
    </section>
  );
};

const QUALITY_KEYS: Record<CatalogCurve["quality"], MessageKey> = {
  MEASURED: "consoleShared.import.quality.MEASURED",
  DERIVED: "consoleShared.import.quality.DERIVED",
  ESTIMATED: "consoleShared.import.quality.ESTIMATED",
  UNKNOWN: "consoleShared.import.quality.UNKNOWN",
};

const CurveOption: React.FC<{
  curve: CatalogCurve;
  checked: boolean;
  onChange: () => void;
}> = ({ curve, checked, onChange }) => {
  const { t } = useTranslation();
  const socs = curve.points.map((p) => p.socPercent);
  const peak = Math.max(0, ...curve.points.map((p) => p.powerKw));
  return (
    <label className="flex items-start gap-2 rounded-md border border-cx-border px-2.5 py-2">
      <input
        type="radio"
        name="curve"
        aria-label={t("consoleShared.import.curveFrom", {
          source: curve.sourceId,
        })}
        checked={checked}
        onChange={onChange}
        className="mt-1"
      />
      <span className="flex flex-1 flex-col gap-0.5">
        <span className="font-medium">
          {curve.sourceId}{" "}
          <span className="font-normal text-cx-muted">
            ·{" "}
            {t("consoleShared.import.curveSummary", {
              quality: t(QUALITY_KEYS[curve.quality]),
              count: curve.points.length,
            })}
            {socs.length > 0 &&
              ` · ${t("consoleShared.import.curveRange", {
                min: Math.min(...socs),
                max: Math.max(...socs),
                peak,
              })}`}
          </span>
        </span>
        <span className="text-xs text-cx-faint">{curve.qualityBasis}</span>
        {curve.observations.length > 0 && (
          <span className="text-xs text-cx-amber">
            {curve.observations.join(", ")}
          </span>
        )}
      </span>
      <CurvePreview points={curve.points} />
    </label>
  );
};

export default ImportVehicleDialog;
