import { useCallback } from "react";
import { atom, useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";

import { useDataContext } from "../providers/DataProvider";
import { useConfig } from "./useConfig";

/**
 * Global RFID Tag IDs are managed at the simulator level, not per-CP — the
 * same tag profiles are reused across every charge point. Local mode stores
 * them in `config.Experimental.TagIDs` (so they ride along with the rest of
 * the saved local config); remote mode keeps them in a small localStorage
 * key that the daemon never sees (the daemon doesn't have an opinion on
 * which tags the UI hands to startTransaction). The jotai atom makes the
 * remote-mode list reactive across components in the same tab without
 * needing a custom event bus.
 */

const REMOTE_TAG_IDS_KEY = "ocpp-cp.remote.tagIds";

const remoteTagIdsBackedAtom = atomWithStorage<string[]>(
  REMOTE_TAG_IDS_KEY,
  [],
  undefined,
  { getOnInit: true },
);

/** Sanitizes whatever localStorage returns into a `string[]` — older builds
 *  wrote non-array JSON and we don't want to crash the page on that. */
const remoteTagIdsAtom = atom(
  (get) => {
    const v = get(remoteTagIdsBackedAtom);
    return Array.isArray(v)
      ? v.filter((s): s is string => typeof s === "string")
      : [];
  },
  (_get, set, next: string[]) => set(remoteTagIdsBackedAtom, next),
);

export interface UseGlobalTagIdsResult {
  tagIds: string[];
  setTagIds: (next: string[]) => Promise<void>;
}

export function useGlobalTagIds(): UseGlobalTagIdsResult {
  const { mode } = useDataContext();
  const { config, setConfig } = useConfig();
  const [remoteTagIds, setRemoteTagIds] = useAtom(remoteTagIdsAtom);

  const localTagIds = config?.Experimental?.TagIDs ?? [];

  const setLocalTagIds = useCallback(
    async (next: string[]): Promise<void> => {
      const base = config;
      const prevExperimental = base?.Experimental;
      const nextExperimental = {
        ChargePointIDs: prevExperimental?.ChargePointIDs ?? [],
        TagIDs: next,
      };
      if (!base) {
        // No saved config yet — synthesize a minimal one so the user can set
        // tags before adding any CP. The empty wsURL/CP id is fine; they get
        // populated when the user creates a CP.
        await setConfig({
          wsURL: "",
          ChargePointID: "",
          connectorNumber: 1,
          tagID: next[0] ?? "",
          ocppVersion: "OCPP-1.6J",
          basicAuthSettings: { enabled: false, username: "", password: "" },
          autoMeterValueSetting: { enabled: false, interval: 0, value: 0 },
          Experimental: nextExperimental,
          BootNotification: null,
        });
        return;
      }
      await setConfig({ ...base, Experimental: nextExperimental });
    },
    [config, setConfig],
  );

  const setRemote = useCallback(
    async (next: string[]): Promise<void> => {
      setRemoteTagIds(next);
    },
    [setRemoteTagIds],
  );

  if (mode === "remote") {
    return { tagIds: remoteTagIds, setTagIds: setRemote };
  }
  return { tagIds: localTagIds, setTagIds: setLocalTagIds };
}
