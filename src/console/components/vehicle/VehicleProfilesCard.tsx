import React, { useState } from "react";

import { Button } from "@/components/ui/button";
import { FIELD_LABELS } from "@/components/vehicle/vehicleChoice";
import { VehicleCatalogError } from "@/cp/domain/vehicle/VehicleCatalog";
import { describeError } from "../../pages/cp/connectorActions";
import {
  markRemovedUpstream,
  refreshFromCatalog,
  type RefreshChange,
} from "@/cp/domain/vehicle/importProfile";
import {
  EDITABLE_SPEC_FIELDS as EDITABLE,
  effectiveSpecs,
  missingFields,
  type EditableSpecField,
  type VehicleProfile,
} from "@/cp/domain/vehicle/VehicleProfile";
import { useVehicleProfiles } from "@/data/hooks/useVehicleProfiles";
import { cn } from "@/lib/utils";

import { FILTER_INPUT_CLASS } from "../filterStyles";
import InlineConfirm from "../InlineConfirm";
import {
  catalogNotConfiguredMessage,
  describeCatalogError,
  useVehicleCatalog,
  type CatalogAccess,
} from "../../lib/vehicleCatalog";
import CurvePreview from "./CurvePreview";
import ImportVehicleDialog from "./ImportVehicleDialog";

/**
 * Settings → Vehicle profiles (#458): the saved vehicles a connector, the
 * default EV settings or a scenario can take, with where each comes from.
 */
const VehicleProfilesCard: React.FC<{ now?: () => string }> = ({
  now = () => new Date().toISOString(),
}) => {
  const store = useVehicleProfiles();
  // Read once for every row: each Refresh uses the same catalog.
  const access = useVehicleCatalog();
  const [importing, setImporting] = useState(false);

  return (
    <div
      id="vehicle-profiles"
      className="rounded-[10px] border border-cx-border bg-cx-card p-6 shadow-[0_1px_2px_rgba(20,20,30,0.05)] dark:shadow-none"
    >
      <div className="mb-4 flex items-start gap-3">
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-cx-fg">Vehicle profiles</h2>
          <p className="mt-1 text-sm text-cx-muted">
            Reusable vehicles for connectors, the default EV and scenarios.
            Import one from Open EV Directory; it is stored here and works
            offline afterwards. Your edits are kept when you refresh it.
          </p>
        </div>
        {store.supported && (
          <Button size="sm" onClick={() => setImporting(true)}>
            Import from Open EV Directory
          </Button>
        )}
      </div>

      {!store.supported ? (
        <p className="text-sm text-cx-muted">
          This console cannot store vehicle profiles.
        </p>
      ) : store.error && !store.isKnown ? (
        <div
          role="alert"
          className="flex items-center gap-2 text-sm text-cx-rose"
        >
          Vehicle profiles could not be read: {store.error}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void store.reload()}
          >
            Retry
          </Button>
        </div>
      ) : !store.isKnown ? (
        <p className="text-sm text-cx-muted">Loading…</p>
      ) : store.profiles.length === 0 ? (
        <p className="text-sm text-cx-muted">No saved vehicle profile yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {store.profiles.map((profile) => (
            <ProfileRow
              key={profile.id}
              profile={profile}
              access={access}
              onSave={store.save}
              onDelete={store.remove}
              now={now}
            />
          ))}
        </ul>
      )}

      <ImportVehicleDialog
        open={importing}
        onOpenChange={setImporting}
        onSave={store.save}
        now={now}
      />
    </div>
  );
};

type RowMode =
  | { kind: "view" }
  | { kind: "edit" }
  | { kind: "delete" }
  | { kind: "refreshing" }
  | { kind: "review"; next: VehicleProfile; changes: RefreshChange[] };

const ProfileRow: React.FC<{
  profile: VehicleProfile;
  access: CatalogAccess;
  onSave: (p: VehicleProfile) => Promise<unknown>;
  onDelete: (id: string) => Promise<void>;
  now: () => string;
}> = ({ profile, access, onSave, onDelete, now }) => {
  const [mode, setMode] = useState<RowMode>({ kind: "view" });
  const [message, setMessage] = useState<{
    text: string;
    error: boolean;
  } | null>(null);
  const specs = effectiveSpecs(profile);
  const origin = profile.origin;
  const missing = {
    AC: missingFields(profile, "AC"),
    DC: missingFields(profile, "DC"),
  };

  /** Runs a write; reports a failure and says whether it succeeded. */
  const act = async (work: () => Promise<void>): Promise<boolean> => {
    setMessage(null);
    try {
      await work();
      return true;
    } catch (err) {
      setMessage({
        text: describeError(err),
        error: true,
      });
      return false;
    }
  };

  const refresh = async () => {
    if (!origin) return;
    if (!access.catalog) {
      setMessage({
        text: catalogNotConfiguredMessage(access.mode),
        error: true,
      });
      return;
    }
    setMode({ kind: "refreshing" });
    setMessage(null);
    try {
      const variant = await access.catalog.getVariant(origin.variantId);
      const result = refreshFromCatalog(profile, variant, now());
      if (!result.ok) {
        setMode({ kind: "view" });
        setMessage({
          text:
            result.reason === "curve_not_found"
              ? "The imported curve is no longer published; the profile is unchanged."
              : "The imported source record is no longer published; the profile is unchanged.",
          error: true,
        });
        return;
      }
      if (result.upToDate) {
        setMode({ kind: "view" });
        setMessage({
          text: "Up to date with Open EV Directory.",
          error: false,
        });
        return;
      }
      setMode({
        kind: "review",
        next: result.profile,
        changes: result.changes,
      });
    } catch (err) {
      setMode({ kind: "view" });
      if (err instanceof VehicleCatalogError && err.kind === "not_found") {
        const flagged = await act(() =>
          onSave(markRemovedUpstream(profile, now())).then(() => {}),
        );
        if (flagged) {
          setMessage({
            text: "Open EV Directory no longer has this vehicle; the profile is kept as it is.",
            error: true,
          });
        }
        return;
      }
      setMessage({ text: describeCatalogError(err, access.mode), error: true });
    }
  };

  return (
    <li className="rounded-md border border-cx-border px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-medium text-cx-fg">{profile.name}</span>
          <span className="font-mono text-xs text-cx-fg2">
            battery {specs.usableBatteryKwh ?? "missing"} kWh · AC{" "}
            {specs.acMaxKw ?? "missing"} kW
            {specs.acPhases ? `, ${specs.acPhases} ph` : ""} · DC{" "}
            {specs.dcMaxKw ?? "missing"} kW
            {Object.keys(profile.overrides).length > 0 && " · edited"}
          </span>
          {origin ? (
            <span className="text-xs text-cx-muted">
              Open EV Directory · specs from {origin.sourceId}
              {origin.curveId
                ? ` · curve from ${origin.curveSourceId}, ${origin.curveQuality?.toLowerCase()}`
                : " · no curve"}
              {origin.datasetVersion ? ` · ${origin.datasetVersion}` : ""}
              {origin.removedUpstream && " · no longer in the catalog"}
            </span>
          ) : (
            <span className="text-xs text-cx-muted">Made by hand</span>
          )}
          {origin && origin.observations.length > 0 && (
            <span className="text-xs text-cx-amber">
              {origin.observations.join(", ")}
            </span>
          )}
          {(["DC", "AC"] as const).map(
            (type) =>
              missing[type].length > 0 && (
                <span key={type} className="text-xs text-cx-amber">
                  Not usable for {type}:{" "}
                  {missing[type].map((f) => FIELD_LABELS[f]).join(", ")} missing
                </span>
              ),
          )}
        </div>
        {profile.dcCurve && profile.dcCurve.length > 0 && (
          <CurvePreview points={profile.dcCurve} />
        )}
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setMode({ kind: "edit" })}
          >
            Edit
          </Button>
          {/* Still offered for a vehicle the catalog dropped: a later
              refresh that finds it again clears the flag. */}
          {origin && (
            <Button
              size="sm"
              variant="outline"
              disabled={mode.kind === "refreshing"}
              onClick={() => void refresh()}
            >
              {mode.kind === "refreshing" ? "Refreshing…" : "Refresh"}
            </Button>
          )}
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setMode({ kind: "delete" })}
          >
            Delete
          </Button>
        </div>
      </div>

      {origin && (
        <details className="mt-1.5 text-xs text-cx-muted">
          <summary className="cursor-pointer">Attribution</summary>
          {origin.licenses.map((l) => (
            <p key={`${l.sourceId}:${l.id}`} className="mt-1">
              {l.attribution}
            </p>
          ))}
        </details>
      )}

      {mode.kind === "delete" && (
        <InlineConfirm
          className="mt-2"
          danger
          message={`Delete ${profile.name}? Connectors and scenarios keep the values they took from it.`}
          confirmLabel="Delete"
          cancelLabel="Keep"
          onCancel={() => setMode({ kind: "view" })}
          onConfirm={() => {
            setMode({ kind: "view" });
            void act(() => onDelete(profile.id));
          }}
        />
      )}

      {mode.kind === "review" && (
        <div className="mt-2 rounded-md border border-cx-border bg-cx-sub px-3 py-2">
          <p className="font-medium text-cx-fg">
            Open EV Directory has changed:
          </p>
          <ul
            aria-label="Refresh changes"
            className="my-1 list-disc pl-4 text-xs"
          >
            {mode.changes.map((change) => (
              <li key={change.field}>{describeChange(change)}</li>
            ))}
          </ul>
          <p className="text-xs text-cx-muted">
            Your edits are kept either way.
          </p>
          <InlineConfirm
            className="mt-2"
            message="Replace the imported values?"
            confirmLabel="Replace"
            cancelLabel="Keep current"
            onCancel={() => setMode({ kind: "view" })}
            onConfirm={() => {
              const next = mode.next;
              setMode({ kind: "view" });
              void act(async () => {
                await onSave(next);
                setMessage({ text: "Refreshed.", error: false });
              });
            }}
          />
        </div>
      )}

      {mode.kind === "edit" && (
        <EditForm
          profile={profile}
          onCancel={() => setMode({ kind: "view" })}
          onSave={(next) => {
            setMode({ kind: "view" });
            void act(async () => {
              await onSave({ ...next, updatedAt: now() });
            });
          }}
        />
      )}

      {message && (
        <p
          role={message.error ? "alert" : "status"}
          className={cn(
            "mt-1.5 text-xs",
            message.error ? "text-cx-rose" : "text-cx-emerald",
          )}
        >
          {message.text}
        </p>
      )}
    </li>
  );
};

const CHANGE_LABELS: Record<RefreshChange["field"], string> = {
  ...FIELD_LABELS,
  acConnectors: "AC connectors",
  dcConnectors: "DC connectors",
  variantId: "Variant id",
  datasetVersion: "Dataset version",
  dcCurve: "The DC curve",
  licenses: "The licenses or their attribution",
  backInCatalog: "Back in the catalog after being removed",
  provider: "Provider",
  makeName: "Make name",
  modelName: "Model name",
  variantName: "Variant name",
  sourceId: "Source",
  sourceRecordKey: "Source record",
  sourceUrl: "Source URL",
  curveId: "Curve id",
  curveSourceId: "Curve source",
  curveQuality: "Curve quality",
  qualityBasis: "Curve quality basis",
  observations: "Curve observations",
};

function showChangeValue(v: unknown): string {
  if (v == null) return "missing";
  if (Array.isArray(v)) return v.join(", ") || "none";
  return String(v);
}

function describeChange(change: RefreshChange): string {
  const label = CHANGE_LABELS[change.field];
  if (!("before" in change)) return label;
  return `${label}: ${showChangeValue(change.before)} → ${showChangeValue(change.after)}`;
}

/**
 * The user's edits. A field left empty goes back to the imported value (or
 * stays missing when the source gives none); a value equal to the imported
 * one is not stored as an edit.
 */
const EditForm: React.FC<{
  profile: VehicleProfile;
  onCancel: () => void;
  onSave: (profile: VehicleProfile) => void;
}> = ({ profile, onCancel, onSave }) => {
  const [name, setName] = useState(profile.name);
  const [values, setValues] = useState<Record<EditableSpecField, string>>(
    () => {
      const specs = effectiveSpecs(profile);
      return Object.fromEntries(
        EDITABLE.map((f) => [f, specs[f] == null ? "" : String(specs[f])]),
      ) as Record<EditableSpecField, string>;
    },
  );
  const invalid = EDITABLE.find((f) => {
    const text = values[f].trim();
    return text !== "" && !(Number.isFinite(Number(text)) && Number(text) >= 0);
  });

  const save = () => {
    const overrides: VehicleProfile["overrides"] = {};
    for (const field of EDITABLE) {
      const text = values[field].trim();
      if (text === "") continue;
      const value = Number(text);
      if (value !== profile.specs[field]) overrides[field] = value;
    }
    onSave({ ...profile, name: name.trim(), overrides });
  };

  return (
    <div className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-x-3 gap-y-2 rounded-md border border-cx-border bg-cx-sub p-3">
      <label className="col-span-full flex flex-col gap-1 text-[11px] uppercase tracking-[0.06em] text-cx-faint">
        Name
        <input
          aria-label="Profile name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={cn(FILTER_INPUT_CLASS, "normal-case tracking-normal")}
        />
      </label>
      {EDITABLE.map((field) => (
        <label
          key={field}
          className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.06em] text-cx-faint"
        >
          {FIELD_LABELS[field]}
          <input
            type="number"
            min={0}
            aria-label={FIELD_LABELS[field]}
            value={values[field]}
            placeholder={
              profile.specs[field] == null
                ? "missing"
                : String(profile.specs[field])
            }
            onChange={(e) =>
              setValues((prev) => ({ ...prev, [field]: e.target.value }))
            }
            className={cn(
              FILTER_INPUT_CLASS,
              "font-mono normal-case tracking-normal",
            )}
          />
        </label>
      ))}
      <div className="col-span-full flex items-center justify-end gap-2">
        {invalid && (
          <span className="mr-auto text-xs text-cx-rose">
            {FIELD_LABELS[invalid]} must be a number, 0 or more.
          </span>
        )}
        {Object.keys(profile.overrides).length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onSave({ ...profile, overrides: {} })}
          >
            Reset to imported values
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!name.trim() || invalid !== undefined}
          onClick={save}
        >
          Save
        </Button>
      </div>
    </div>
  );
};

export default VehicleProfilesCard;
