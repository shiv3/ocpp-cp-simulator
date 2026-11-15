import { useTranslation } from "react-i18next";
import React, { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { FIELD_LABELS, FIELD_UNITS } from "@/components/vehicle/vehicleChoice";
import type {
  CatalogCurve,
  CatalogVariant,
} from "@ocpp-cp-simulator/core/cp/domain/vehicle/VehicleCatalog";
import { profileFromCatalog } from "@ocpp-cp-simulator/core/cp/domain/vehicle/importProfile";
import {
  availableCurrentTypes,
  EDITABLE_SPEC_FIELDS as EDITABLE,
  type EditableSpecField,
  type VehicleProfile,
} from "@ocpp-cp-simulator/core/cp/domain/vehicle/VehicleProfile";
import { cn } from "@/lib/utils";

import { FILTER_INPUT_CLASS } from "../filterStyles";
import CurvePreview from "./CurvePreview";
import { NO_CURVE } from "./importVehicleConsts";
import { t as translate, type MessageKey, type TFunction } from "@/i18n";

const shown = (value: number | null) =>
  value == null ? translate("consoleShared.vehicle.missing") : String(value);

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

export const VariantForm: React.FC<{
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

export const CurveOption: React.FC<{
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
