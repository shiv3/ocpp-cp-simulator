import { useTranslation } from "react-i18next";
import React, { useState } from "react";

import { Button } from "@/components/ui/button";
import { FIELD_LABELS } from "@/components/vehicle/vehicleChoice";
import { VehicleCatalogError } from "@ocpp-cp-simulator/core/cp/domain/vehicle/VehicleCatalog";
import { describeError } from "../../pages/cp/connectorActions";
import {
  markRemovedUpstream,
  refreshFromCatalog,
  type RefreshChange,
} from "@ocpp-cp-simulator/core/cp/domain/vehicle/importProfile";
import {
  EDITABLE_SPEC_FIELDS as EDITABLE,
  effectiveSpecs,
  missingFields,
  type EditableSpecField,
  type VehicleProfile,
} from "@ocpp-cp-simulator/core/cp/domain/vehicle/VehicleProfile";
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
import { t, type MessageKey } from "@/i18n";

/**
 * Settings → Vehicle profiles (#458): the saved vehicles a connector, the
 * default EV settings or a scenario can take, with where each comes from.
 */
const VehicleProfilesCard: React.FC<{ now?: () => string }> = ({
  now = () => new Date().toISOString(),
}) => {
  const { t } = useTranslation();
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
          <h2 className="text-lg font-semibold text-cx-fg">
            {t("consoleShared.vehicle.title")}
          </h2>
          <p className="mt-1 text-sm text-cx-muted">
            {t("consoleShared.vehicle.description")}
          </p>
        </div>
        {store.supported && (
          <Button size="sm" onClick={() => setImporting(true)}>
            {t("consoleShared.vehicle.importButton")}
          </Button>
        )}
      </div>

      {!store.supported ? (
        <p className="text-sm text-cx-muted">
          {t("consoleShared.vehicle.unsupported")}
        </p>
      ) : store.error && !store.isKnown ? (
        <div
          role="alert"
          className="flex items-center gap-2 text-sm text-cx-rose"
        >
          {t("consoleShared.vehicle.readError", { error: store.error })}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void store.reload()}
          >
            {t("consoleShared.vehicle.retry")}
          </Button>
        </div>
      ) : !store.isKnown ? (
        <p className="text-sm text-cx-muted">
          {t("consoleShared.vehicle.loading")}
        </p>
      ) : store.profiles.length === 0 ? (
        <p className="text-sm text-cx-muted">
          {t("consoleShared.vehicle.empty")}
        </p>
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
  const { t } = useTranslation();
  const [mode, setMode] = useState<RowMode>({ kind: "view" });
  const [message, setMessage] = useState<{
    text: string;
    error: boolean;
  } | null>(null);
  const specs = effectiveSpecs(profile);
  const missingText = t("consoleShared.vehicle.missing");
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
              ? t("consoleShared.vehicle.curveGone")
              : t("consoleShared.vehicle.recordGone"),
          error: true,
        });
        return;
      }
      if (result.upToDate) {
        setMode({ kind: "view" });
        setMessage({
          text: t("consoleShared.vehicle.upToDate"),
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
            text: t("consoleShared.vehicle.removedUpstream"),
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
            {t("consoleShared.vehicle.specsLine", {
              battery: specs.usableBatteryKwh ?? missingText,
              ac: specs.acMaxKw ?? missingText,
              phases: specs.acPhases
                ? t("consoleShared.vehicle.phases", { count: specs.acPhases })
                : "",
              dc: specs.dcMaxKw ?? missingText,
              edited:
                Object.keys(profile.overrides).length > 0
                  ? t("consoleShared.vehicle.editedSuffix")
                  : "",
            })}
          </span>
          {origin ? (
            <span className="text-xs text-cx-muted">
              {t("consoleShared.vehicle.originSpecs", {
                source: origin.sourceId,
              })}
              {origin.curveId
                ? ` · ${t("consoleShared.vehicle.originCurve", {
                    source: origin.curveSourceId ?? "",
                    quality: origin.curveQuality?.toLowerCase() ?? "",
                  })}`
                : ` · ${t("consoleShared.vehicle.originNoCurve")}`}
              {origin.datasetVersion ? ` · ${origin.datasetVersion}` : ""}
              {origin.removedUpstream &&
                ` · ${t("consoleShared.vehicle.originRemoved")}`}
            </span>
          ) : (
            <span className="text-xs text-cx-muted">
              {t("consoleShared.vehicle.madeByHand")}
            </span>
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
                  {t("consoleShared.vehicle.notUsable", {
                    type,
                    fields: missing[type]
                      .map((f) => FIELD_LABELS[f])
                      .join(", "),
                  })}
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
            {t("consoleShared.vehicle.edit")}
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
              {mode.kind === "refreshing"
                ? t("consoleShared.vehicle.refreshing")
                : t("consoleShared.vehicle.refresh")}
            </Button>
          )}
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setMode({ kind: "delete" })}
          >
            {t("consoleShared.vehicle.delete")}
          </Button>
        </div>
      </div>

      {origin && (
        <details className="mt-1.5 text-xs text-cx-muted">
          <summary className="cursor-pointer">
            {t("consoleShared.vehicle.attribution")}
          </summary>
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
          message={t("consoleShared.vehicle.deleteConfirm", {
            name: profile.name,
          })}
          confirmLabel={t("consoleShared.vehicle.delete")}
          cancelLabel={t("consoleShared.vehicle.keep")}
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
            {t("consoleShared.vehicle.changed")}
          </p>
          <ul
            aria-label={t("consoleShared.vehicle.refreshChanges")}
            className="my-1 list-disc pl-4 text-xs"
          >
            {mode.changes.map((change) => (
              <li key={change.field}>{describeChange(change)}</li>
            ))}
          </ul>
          <p className="text-xs text-cx-muted">
            {t("consoleShared.vehicle.editsKept")}
          </p>
          <InlineConfirm
            className="mt-2"
            message={t("consoleShared.vehicle.replaceQuestion")}
            confirmLabel={t("consoleShared.vehicle.replace")}
            cancelLabel={t("consoleShared.vehicle.keepCurrent")}
            onCancel={() => setMode({ kind: "view" })}
            onConfirm={() => {
              const next = mode.next;
              setMode({ kind: "view" });
              void act(async () => {
                await onSave(next);
                setMessage({
                  text: t("consoleShared.vehicle.refreshed"),
                  error: false,
                });
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

const CHANGE_LABEL_KEYS: Partial<Record<RefreshChange["field"], MessageKey>> = {
  acConnectors: "consoleShared.vehicle.change.acConnectors",
  dcConnectors: "consoleShared.vehicle.change.dcConnectors",
  variantId: "consoleShared.vehicle.change.variantId",
  datasetVersion: "consoleShared.vehicle.change.datasetVersion",
  dcCurve: "consoleShared.vehicle.change.dcCurve",
  licenses: "consoleShared.vehicle.change.licenses",
  backInCatalog: "consoleShared.vehicle.change.backInCatalog",
  provider: "consoleShared.vehicle.change.provider",
  makeName: "consoleShared.vehicle.change.makeName",
  modelName: "consoleShared.vehicle.change.modelName",
  variantName: "consoleShared.vehicle.change.variantName",
  sourceId: "consoleShared.vehicle.change.sourceId",
  sourceRecordKey: "consoleShared.vehicle.change.sourceRecordKey",
  sourceUrl: "consoleShared.vehicle.change.sourceUrl",
  curveId: "consoleShared.vehicle.change.curveId",
  curveSourceId: "consoleShared.vehicle.change.curveSourceId",
  curveQuality: "consoleShared.vehicle.change.curveQuality",
  qualityBasis: "consoleShared.vehicle.change.qualityBasis",
  observations: "consoleShared.vehicle.change.observations",
};

function showChangeValue(v: unknown): string {
  if (v == null) return t("consoleShared.vehicle.missing");
  if (Array.isArray(v)) return v.join(", ") || t("consoleShared.vehicle.none");
  return String(v);
}

function describeChange(change: RefreshChange): string {
  const labelKey = CHANGE_LABEL_KEYS[change.field];
  const label = labelKey
    ? t(labelKey)
    : FIELD_LABELS[change.field as keyof typeof FIELD_LABELS];
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
  const { t } = useTranslation();
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
        {t("consoleShared.vehicle.name")}
        <input
          aria-label={t("consoleShared.vehicle.profileName")}
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
                ? t("consoleShared.vehicle.missing")
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
            {t("consoleShared.vehicle.mustBeNumber", {
              field: FIELD_LABELS[invalid],
            })}
          </span>
        )}
        {Object.keys(profile.overrides).length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onSave({ ...profile, overrides: {} })}
          >
            {t("consoleShared.vehicle.resetToImported")}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={onCancel}>
          {t("consoleShared.vehicle.cancel")}
        </Button>
        <Button
          size="sm"
          disabled={!name.trim() || invalid !== undefined}
          onClick={save}
        >
          {t("consoleShared.vehicle.save")}
        </Button>
      </div>
    </div>
  );
};

export default VehicleProfilesCard;
