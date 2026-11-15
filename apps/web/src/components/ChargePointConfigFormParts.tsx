import { useTranslation } from "react-i18next";
import React, { useState, useRef, useEffect } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The small uppercase label over each field, like the console's key figures.
// `dark:` twin because the shared Label sets its own dark colour.
export const LABEL_CLASS =
  "mb-1.5 block text-[11px] font-normal uppercase leading-none tracking-[0.06em] text-cx-faint dark:text-cx-faint";
// Fields flow into as many 160px+ columns as the container fits, so the same
// form works in the 520px side panel, on the page and in the dialog.
export const FIELD_GRID_CLASS =
  "grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3";
export const HINT_CLASS = "mt-1 text-xs text-cx-muted";
export const ERROR_CLASS = "mt-1 text-xs text-cx-rose";

export const Field: React.FC<{
  id: string;
  label: React.ReactNode;
  /** Takes the whole row (URLs, PEM blocks). */
  wide?: boolean;
  children: React.ReactNode;
}> = ({ id, label, wide, children }) => (
  <div className={cn("min-w-0", wide && "col-span-full")}>
    <Label htmlFor={id} className={LABEL_CLASS}>
      {label}
    </Label>
    {children}
  </div>
);

export const Section: React.FC<{
  title: string;
  children: React.ReactNode;
}> = ({ title, children }) => (
  <section>
    <h3 className="mb-2 text-[13px] font-semibold text-cx-fg">{title}</h3>
    {children}
  </section>
);

/**
 * The SOAP callback URL is the one value the operator has to carry over to
 * the CSMS by hand, so the effective one gets a copy button. When the daemon
 * derived it from a tunnel, say so: a free-tier ngrok URL changes between
 * runs, and the CSMS entry has to follow it.
 */
export const SoapCallbackUrlRow: React.FC<{
  url: string;
  /** Where a derived URL came from; null for an explicit one. */
  note: string | null;
}> = ({ url, note }) => {
  const { t } = useTranslation();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const copy = async () => {
    try {
      // Absent on plain-http origins other than localhost; the URL stays
      // selectable as text, so say so instead of failing silently.
      await navigator.clipboard.writeText(url);
      setCopyState("copied");
    } catch (error) {
      console.error("Failed to copy the SOAP callback URL", error);
      setCopyState("failed");
    }
    setTimeout(() => setCopyState("idle"), 1500);
  };
  return (
    <div className="col-span-full">
      <span className={LABEL_CLASS}>
        {t("settings.form.effectiveCallbackUrl")}
      </span>
      <div className="flex items-start gap-2">
        <span className="break-all font-mono text-[13px] text-cx-fg">
          {url}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => void copy()}
          aria-label={t("settings.form.copySoapCallbackAria")}
        >
          {copyState === "copied"
            ? t("settings.common.copied")
            : copyState === "failed"
              ? t("settings.form.copyFailed")
              : t("settings.common.copy")}
        </Button>
      </div>
      {note && <p className={HINT_CLASS}>{note}</p>}
    </div>
  );
};

/**
 * The URL the charge point will dial, composed from the WebSocket URL and the
 * Basic Auth settings: a display, never an input, so the value has one place
 * to be edited. Copy puts it on the clipboard; without the clipboard API
 * (plain-http origins other than localhost) the button does nothing.
 */
export const EffectiveWsUrlRow: React.FC<{ url: string }> = ({ url }) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    if (!navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(url);
    } catch (error) {
      console.error("Failed to copy the effective WebSocket URL", error);
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Field id="effectiveWsURL" label={t("settings.form.effectiveWsUrl")} wide>
      <div className="flex items-center gap-2">
        <Input
          id="effectiveWsURL"
          type="text"
          readOnly
          value={url}
          className="font-mono"
          spellCheck={false}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => void copy()}
          aria-label={t("settings.form.copyWsAria")}
        >
          {copied ? t("settings.common.copied") : t("settings.common.copy")}
        </Button>
      </div>
      <p className={HINT_CLASS}>{t("settings.form.effectiveWsUrlHint")}</p>
    </Field>
  );
};

/**
 * A derived callback URL belongs to the daemon's current base, not to the
 * charge point: editing it as a value would send it back explicit and freeze
 * one run's tunnel origin into the row. The form keeps the field empty and
 * shows the derivation as its placeholder instead.
 */
