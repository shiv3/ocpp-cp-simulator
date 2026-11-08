import React, { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  addSavedDaemon,
  loadSavedDaemons,
  removeSavedDaemon,
  storeSavedDaemons,
  type SavedDaemon,
} from "../../data/savedDaemons";
import { useDataContext } from "../../data/providers/DataProvider";

/**
 * Remote mode (#619): pick the daemon the console talks to among the saved
 * addresses, and save or forget addresses. The page origin's daemon is always
 * listed first and cannot be removed. A switch that fails leaves the previous
 * daemon selected and says why. Renders nothing in Local mode.
 */
const DaemonSwitcher: React.FC = () => {
  const { t } = useTranslation();
  const { mode, serverUrl, originUrl, switchDaemon } = useDataContext();
  const [saved, setSaved] = useState<SavedDaemon[]>(loadSavedDaemons);
  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (mode !== "remote" || !switchDaemon) return null;

  const origin = originUrl ?? serverUrl;
  const labelOf = (d: SavedDaemon) => (d.name ? `${d.name} (${d.url})` : d.url);
  const options: { url: string; label: string }[] = [
    { url: origin, label: t("common.daemon.origin", { url: origin }) },
    ...saved
      .filter((d) => d.url !== origin)
      .map((d) => ({
        url: d.url,
        label: labelOf(d),
      })),
  ];
  const known = options.some((o) => o.url === serverUrl);
  if (!known) options.push({ url: serverUrl, label: serverUrl });

  const doSwitch = async (url: string) => {
    setBusy(true);
    setError(null);
    try {
      await switchDaemon(url);
    } catch {
      setError(t("common.daemon.switchFailed", { url }));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const result = addSavedDaemon(saved, address, name);
    if (!result.ok) {
      setError(
        t(
          result.reason === "invalid"
            ? "common.daemon.invalid"
            : result.reason === "duplicate"
              ? "common.daemon.duplicate"
              : "common.daemon.full",
        ),
      );
      return;
    }
    setSaved(result.list);
    storeSavedDaemons(result.list);
    setAdding(false);
    setAddress("");
    setName("");
    await doSwitch(result.list[result.list.length - 1].url);
  };

  const forget = (url: string) => {
    const next = removeSavedDaemon(saved, url);
    setSaved(next);
    storeSavedDaemons(next);
  };

  return (
    <div data-testid="daemon-switcher" className="mt-2 space-y-1.5">
      <select
        aria-label={t("common.daemon.select")}
        value={serverUrl}
        disabled={busy}
        onChange={(e) => void doSwitch(e.target.value)}
        className="h-8 w-full rounded-[7px] border border-cx-border bg-cx-card px-1.5 text-[12px] text-cx-fg"
      >
        {options.map((o) => (
          <option key={o.url} value={o.url}>
            {o.label}
          </option>
        ))}
      </select>
      {busy && (
        <div role="status" className="text-[11.5px] text-cx-faint">
          {t("common.daemon.switching")}
        </div>
      )}
      {error && (
        <div role="alert" className="text-[11.5px] text-cx-rose">
          {error}
        </div>
      )}
      {adding ? (
        <div className="space-y-1.5">
          <Input
            aria-label={t("common.daemon.addressLabel")}
            placeholder="http://host:9700"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
          <Input
            aria-label={t("common.daemon.nameLabel")}
            placeholder={t("common.daemon.namePlaceholder")}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="flex gap-1.5">
            <Button size="sm" disabled={busy} onClick={() => void save()}>
              {t("common.daemon.saveAndSwitch")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setAdding(false);
                setError(null);
              }}
            >
              {t("common.daemon.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setAdding(true);
              setError(null);
            }}
          >
            {t("common.daemon.add")}
          </Button>
          {serverUrl !== origin && saved.some((d) => d.url === serverUrl) && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                forget(serverUrl);
                void doSwitch(origin);
              }}
            >
              {t("common.daemon.forget")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
};

export default DaemonSwitcher;
