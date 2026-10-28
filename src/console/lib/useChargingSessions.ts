import { useCallback, useEffect, useRef, useState } from "react";

import type { ChargingSessionPage } from "../../cp/domain/persistence/ChargingSessionRepository";
import type { ChargingSession } from "../../cp/domain/session/ChargingSession";
import { useDataContext } from "../../data/providers/DataProvider";
import { CHARGING_SESSIONS_PAGE_DEFAULT } from "../../protocol";

const EMPTY_PAGE: ChargingSessionPage = { sessions: [], total: 0 };

/** Newest first, like `sessions.list`, and no more than one page. */
function withSession(
  page: ChargingSessionPage,
  session: ChargingSession,
): ChargingSessionPage {
  const known = page.sessions.some((s) => s.sessionId === session.sessionId);
  const sessions = known
    ? page.sessions.map((s) =>
        s.sessionId === session.sessionId ? session : s,
      )
    : [session, ...page.sessions];
  sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return {
    sessions: sessions.slice(0, CHARGING_SESSIONS_PAGE_DEFAULT),
    total: known ? page.total : page.total + 1,
  };
}

export interface UseChargingSessionsResult {
  page: ChargingSessionPage;
  isLoading: boolean;
  error: string | null;
  /** False when the service has no session method (a test double). Against
   *  a daemon older than #447 the read fails and `error` says so. */
  supported: boolean;
  refresh: () => Promise<void>;
}

/**
 * A charge point's newest charging sessions (#447, `sessions.list`). Reads
 * one page on mount and when `cpId` changes, then applies each session the
 * charge point pushes (`charging-session`): a known one is replaced in place,
 * a new one is added at the top.
 */
export function useChargingSessions(cpId: string): UseChargingSessionsResult {
  const { chargePointService } = useDataContext();
  const supported =
    typeof chargePointService.listChargingSessions === "function";

  const [page, setPage] = useState<ChargingSessionPage>(EMPTY_PAGE);
  const [isLoading, setIsLoading] = useState(supported);
  const [error, setError] = useState<string | null>(null);
  // A slower answer for another charge point (or one landing after unmount)
  // must not overwrite the current one.
  const requestIdRef = useRef(0);
  // Sessions pushed while a read is in flight, re-applied to its answer. The
  // charge point stores a session before pushing it, so the last push of a
  // session is never older than what the read returns.
  const pushedDuringReadRef = useRef<Map<string, ChargingSession> | null>(null);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!supported) {
      setPage(EMPTY_PAGE);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    const pushed = new Map<string, ChargingSession>();
    pushedDuringReadRef.current = pushed;
    try {
      const result = await chargePointService.listChargingSessions!(cpId, {
        limit: CHARGING_SESSIONS_PAGE_DEFAULT,
      });
      if (requestId !== requestIdRef.current) return;
      let next = result;
      for (const session of pushed.values()) next = withSession(next, session);
      setPage(next);
      setError(null);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (pushedDuringReadRef.current === pushed) {
        pushedDuringReadRef.current = null;
      }
      if (requestId === requestIdRef.current) setIsLoading(false);
    }
  }, [chargePointService, cpId, supported]);

  useEffect(() => {
    void refresh();
    return () => {
      requestIdRef.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    if (!supported) return undefined;
    return chargePointService.subscribe(cpId, (event) => {
      if (event.type !== "charging-session" || event.session.cpId !== cpId) {
        return;
      }
      pushedDuringReadRef.current?.set(event.session.sessionId, event.session);
      setPage((current) => withSession(current, event.session));
    });
  }, [chargePointService, cpId, supported]);

  return { page, isLoading, error, supported, refresh };
}
