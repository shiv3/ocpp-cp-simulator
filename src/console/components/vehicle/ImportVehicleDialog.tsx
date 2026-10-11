import React, { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { FIELD_LABELS } from "@/components/vehicle/vehicleChoice";
import type {
  CatalogCurve,
  CatalogMake,
  CatalogModel,
  CatalogPage,
  CatalogVariant,
  CatalogVariantSummary,
  VehicleCatalog,
} from "@/cp/domain/vehicle/VehicleCatalog";
import { profileFromCatalog } from "@/cp/domain/vehicle/importProfile";
import {
  availableCurrentTypes,
  type EditableSpecField,
  type VehicleProfile,
} from "@/cp/domain/vehicle/VehicleProfile";
import { cn } from "@/lib/utils";

import { FILTER_INPUT_CLASS, FILTER_SELECT_CLASS } from "../filterStyles";
import {
  describeCatalogError,
  OED_KEY_HELP_URL,
  useVehicleCatalog,
  type CatalogAccess,
} from "../../lib/vehicleCatalog";
import CurvePreview from "./CurvePreview";

export interface ImportVehicleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Stores the new profile; the dialog closes once it resolves. */
  onSave: (profile: VehicleProfile) => Promise<unknown>;
  /** Test seam for the new profile's id and import time. */
  newId?: () => string;
  now?: () => string;
}

const EDITABLE: readonly EditableSpecField[] = [
  "usableBatteryKwh",
  "acMaxKw",
  "acPhases",
  "dcMaxKw",
];

const UNITS: Record<EditableSpecField, string> = {
  usableBatteryKwh: "kWh",
  acMaxKw: "kW",
  acPhases: "",
  dcMaxKw: "kW",
};

const shown = (value: number | null) =>
  value == null ? "missing" : String(value);

/**
 * Import a vehicle from Open EV Directory into a saved profile (#458).
 *
 * Nothing is chosen for the user: the source record whose specs are kept and
 * the curve (or none) are both explicit picks, every curve shows its source
 * and how much that source says about it, and a value the source does not
 * give stays empty until the user fills it in.
 */
const ImportVehicleDialog: React.FC<ImportVehicleDialogProps> = (props) => (
  <Dialog open={props.open} onOpenChange={props.onOpenChange}>
    <DialogContent className="flex max-h-[calc(100vh-32px)] w-[min(880px,calc(100vw-32px))] max-w-none flex-col gap-0 overflow-hidden border-cx-border-strong bg-cx-card p-0 text-cx-fg sm:rounded-xl">
      <div className="border-b border-cx-border py-3 pl-4 pr-12">
        <DialogTitle className="text-[15px] font-semibold tracking-normal">
          Import a vehicle from Open EV Directory
        </DialogTitle>
        <DialogDescription className="mt-0.5 text-[12.5px] text-cx-muted">
          The profile is saved in the simulator; simulations never call the
          catalog.
        </DialogDescription>
      </div>
      {props.open && <ImportBody {...props} />}
    </DialogContent>
  </Dialog>
);

const ImportBody: React.FC<ImportVehicleDialogProps> = ({
  onOpenChange,
  onSave,
  newId = () => `vp_${crypto.randomUUID()}`,
  now = () => new Date().toISOString(),
}) => {
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

  const run = async <T,>(call: (c: VehicleCatalog) => Promise<T>) => {
    if (!catalog) return null;
    setBusy(true);
    setError(null);
    try {
      return await call(catalog);
    } catch (err) {
      setError(describeCatalogError(err, access.mode));
      return null;
    } finally {
      setBusy(false);
    }
  };

  // The makes, once a catalog is reachable; a failure is shown, the search
  // by model name still works without them.
  useEffect(() => {
    if (!catalog) return;
    let cancelled = false;
    catalog.listMakes().then(
      (list) => {
        if (!cancelled) setMakes(list);
      },
      (err: unknown) => {
        if (!cancelled) setError(describeCatalogError(err, access.mode));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [catalog, access.mode]);

  const search = async (page = 0) => {
    const result = await run((c) =>
      c.searchModels({ makeId: makeId || undefined, model: query, page }),
    );
    if (result) {
      setModels(result);
      setModel(null);
      setVariants(null);
      setVariant(null);
    }
  };

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
        <section aria-label="Search" className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.06em] text-cx-faint">
            Make
            <select
              aria-label="Make"
              value={makeId}
              onChange={(e) => setMakeId(e.target.value)}
              className={cn(FILTER_SELECT_CLASS, "min-w-[180px] normal-case")}
            >
              <option value="">Any make</option>
              {(makes ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-1 flex-col gap-1 text-[11px] uppercase tracking-[0.06em] text-cx-faint">
            Model
            <input
              aria-label="Model"
              value={query}
              placeholder="e.g. ID.7"
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
            Search
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
          label="Models"
          page={models}
          empty="No model matches."
          onPage={(p) => void search(p)}
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
              <span className="text-cx-muted">· {m.variantCount} variants</span>
            </button>
          )}
        />
      )}

      {model && variants && !variant && (
        <PickList
          label={`Variants of ${model.makeName} ${model.name}`}
          page={variants}
          empty="No variant."
          onPage={(p) => void openModel(model, p)}
          render={(v) => (
            <button
              type="button"
              onClick={() => void openVariant(v.id)}
              className="w-full rounded-md px-2 py-1 text-left hover:bg-cx-sub"
            >
              {v.name}{" "}
              <span className="text-cx-muted">
                · sources {v.sources.join(", ")} · {v.chargingCurveCount} curve
                {v.chargingCurveCount === 1 ? "" : "s"}
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
          onSave={async (profileInput) => {
            setBusy(true);
            setError(null);
            try {
              await onSave(profileInput);
              onOpenChange(false);
            } catch (err) {
              setError(
                `The profile was not saved: ${err instanceof Error ? err.message : String(err)}`,
              );
            } finally {
              setBusy(false);
            }
          }}
          newId={newId}
          now={now}
        />
      )}
    </div>
  );
};

/** Where the catalog is, and the key in Local mode. */
const CatalogAccessPanel: React.FC<{ access: CatalogAccess }> = ({
  access,
}) => {
  const [keyDraft, setKeyDraft] = useState("");
  if (access.mode === "remote") {
    if (access.configured === false) {
      return (
        <p
          role="status"
          className="rounded-md border border-cx-border bg-cx-sub px-3 py-2"
        >
          The daemon has no Open EV Directory URL. Start it with{" "}
          <code>--oed-base-url</code> (or <code>OED_BASE_URL</code>) and your
          key in <code>OED_API_KEY</code> to import vehicles.
        </p>
      );
    }
    return (
      <p className="text-[12.5px] text-cx-muted">
        Searched through the daemon
        {access.authenticated === false
          ? ", which has no API key: the catalog may refuse it."
          : ", with its API key; the key never reaches this page."}
      </p>
    );
  }
  return (
    <section
      aria-label="Open EV Directory access"
      className="flex flex-col gap-2"
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.06em] text-cx-faint">
          API URL
          <input
            aria-label="Open EV Directory URL"
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
          Your API key
          <span className="flex gap-1.5 normal-case tracking-normal">
            <input
              aria-label="Open EV Directory API key"
              type="password"
              autoComplete="off"
              value={keyDraft}
              placeholder={access.hasKey ? "Set for this tab" : "evd_live_…"}
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
              Use
            </Button>
            {access.hasKey && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => access.setApiKey(null)}
              >
                Forget
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
        Browser-only mode calls the catalog from this page. Your key is kept in
        this tab's memory only — never stored or exported — and anyone using
        this browser could read it. Get a personal key from{" "}
        <a
          href={OED_KEY_HELP_URL}
          target="_blank"
          rel="noreferrer"
          className="text-cx-accent underline"
        >
          Open EV Directory
        </a>
        . If the API does not accept calls from this page, import through the
        daemon instead.
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
            Previous
          </Button>
          Page {page.page + 1} of {page.totalPages}
          <Button
            size="sm"
            variant="ghost"
            disabled={page.page + 1 >= page.totalPages}
            onClick={() => onPage(page.page + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </section>
  );
}

const NO_CURVE = "__none__";

const VariantForm: React.FC<{
  variant: CatalogVariant;
  busy: boolean;
  onBack: () => void;
  onCancel: () => void;
  onSave: (profile: VehicleProfile) => Promise<void>;
  newId: () => string;
  now: () => string;
}> = ({ variant, busy, onBack, onCancel, onSave, newId, now }) => {
  const [recordKey, setRecordKey] = useState<string | null>(null);
  // No curve is preselected, "no curve" included: the user says which.
  const [curveChoice, setCurveChoice] = useState<string | null>(null);
  const [name, setName] = useState(`${variant.makeName} ${variant.name}`);
  const [filled, setFilled] = useState<
    Partial<Record<EditableSpecField, string>>
  >({});

  const record = variant.sourceRecords.find((r) => r.key === recordKey) ?? null;
  const draft = (() => {
    if (!record || curveChoice === null) return null;
    const result = profileFromCatalog(
      variant,
      {
        sourceRecordKey: record.key,
        curveId: curveChoice === NO_CURVE ? null : curveChoice,
      },
      { id: "draft", now: "draft", name },
    );
    if (!result.ok) return null;
    const overrides: VehicleProfile["overrides"] = {};
    for (const field of EDITABLE) {
      const value = Number(filled[field]);
      if (filled[field]?.trim() && Number.isFinite(value) && value >= 0) {
        overrides[field] = value;
      }
    }
    return { ...result.profile, overrides };
  })();
  const usableTypes = draft ? availableCurrentTypes(draft) : [];
  const capacityKnown =
    draft != null &&
    (draft.overrides.usableBatteryKwh ?? draft.specs.usableBatteryKwh) != null;
  const blocker = !record
    ? "Choose the source record whose specs to keep."
    : curveChoice === null
      ? "Choose a curve, or no curve."
      : !name.trim()
        ? "Give the profile a name."
        : !capacityKnown
          ? "The source gives no usable battery capacity: fill it in."
          : usableTypes.length === 0
            ? "Fill in an AC or a DC maximum power."
            : null;

  return (
    <section aria-label="Variant" className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          ← Back
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
          Specs — from which source?
        </legend>
        <p className="text-xs text-cx-muted">
          Sources are kept apart and may disagree; the catalog does not pick
          one, and neither does the simulator.
        </p>
        {variant.sourceRecords.map((r) => (
          <label
            key={r.key}
            className="flex items-start gap-2 rounded-md border border-cx-border px-2.5 py-2"
          >
            <input
              type="radio"
              name="source-record"
              aria-label={`Specs from ${r.sourceId}`}
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
                battery {shown(r.specs.usableBatteryKwh)} kWh · AC{" "}
                {shown(r.specs.acMaxKw)} kW, {shown(r.specs.acPhases)} ph · DC{" "}
                {shown(r.specs.dcMaxKw)} kW
              </span>
              <span className="text-xs text-cx-faint">
                {[...r.specs.acConnectors, ...r.specs.dcConnectors].join(
                  ", ",
                ) || "no connector type"}{" "}
                · {r.license.name}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-[11px] uppercase tracking-[0.06em] text-cx-faint">
          DC charging curve
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
            aria-label="No curve"
            checked={curveChoice === NO_CURVE}
            onChange={() => setCurveChoice(NO_CURVE)}
          />
          No curve — charge flat at the maximum power
          {variant.curves.length === 0 && (
            <span className="text-cx-muted"> (no source publishes one)</span>
          )}
        </label>
      </fieldset>

      {record && (
        <fieldset className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-x-3.5 gap-y-2.5">
          <legend className="mb-1 text-[11px] uppercase tracking-[0.06em] text-cx-faint">
            Profile
          </legend>
          <label className="col-span-full flex flex-col gap-1 text-[11px] uppercase tracking-[0.06em] text-cx-faint">
            Name
            <input
              aria-label="Profile name"
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
              {FIELD_LABELS[field]} — missing
              <span className="flex items-center gap-1.5 normal-case tracking-normal">
                <input
                  type="number"
                  min={0}
                  aria-label={`Missing ${FIELD_LABELS[field]}`}
                  value={filled[field] ?? ""}
                  onChange={(e) =>
                    setFilled((prev) => ({ ...prev, [field]: e.target.value }))
                  }
                  className={cn(FILTER_INPUT_CLASS, "min-w-0 flex-1 font-mono")}
                />
                {UNITS[field] && (
                  <span className="text-xs text-cx-muted">{UNITS[field]}</span>
                )}
              </span>
            </label>
          ))}
        </fieldset>
      )}

      {draft?.origin && (
        <div className="rounded-md border border-cx-border bg-cx-sub px-3 py-2 text-xs text-cx-fg2">
          <p className="mb-1 font-medium text-cx-fg">
            Attribution kept with the profile
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
          Cancel
        </Button>
        <Button
          disabled={busy || blocker !== null || !draft}
          onClick={() => {
            if (!draft) return;
            const at = now();
            void onSave({
              ...draft,
              id: newId(),
              name: name.trim(),
              createdAt: at,
              updatedAt: at,
              origin: draft.origin ? { ...draft.origin, importedAt: at } : null,
            });
          }}
        >
          Save profile
        </Button>
      </div>
    </section>
  );
};

const QUALITY_TEXT: Record<CatalogCurve["quality"], string> = {
  MEASURED: "measured",
  DERIVED: "derived from measurements",
  ESTIMATED: "estimated",
  UNKNOWN: "origin unknown",
};

const CurveOption: React.FC<{
  curve: CatalogCurve;
  checked: boolean;
  onChange: () => void;
}> = ({ curve, checked, onChange }) => {
  const socs = curve.points.map((p) => p.socPercent);
  const peak = Math.max(0, ...curve.points.map((p) => p.powerKw));
  return (
    <label className="flex items-start gap-2 rounded-md border border-cx-border px-2.5 py-2">
      <input
        type="radio"
        name="curve"
        aria-label={`Curve from ${curve.sourceId}`}
        checked={checked}
        onChange={onChange}
        className="mt-1"
      />
      <span className="flex flex-1 flex-col gap-0.5">
        <span className="font-medium">
          {curve.sourceId}{" "}
          <span className="font-normal text-cx-muted">
            · {QUALITY_TEXT[curve.quality]} · {curve.points.length} points
            {socs.length > 0 &&
              ` · ${Math.min(...socs)}–${Math.max(...socs)} % · peak ${peak} kW`}
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
