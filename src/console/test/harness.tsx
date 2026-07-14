import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { vi } from "vitest";

import { ConsoleRoutes } from "../ConsoleApp";
import { CONSOLE_BASENAME, consolePath } from "../routes";
import { DarkModeProvider } from "../../contexts/DarkModeContext";
import { DataContext } from "../../data/providers/DataProvider";
import type {
  ChargePointService,
  ChargePointSnapshot,
} from "../../data/interfaces/ChargePointService";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...args: any[]) => void;

export interface FakeChargePointServiceHandlers {
  /** Handlers registered via `subscribe(cpId, handler)`, keyed by cpId. */
  subscribe: Map<string, Set<Handler>>;
  /** Handlers registered via `subscribeConfig(handler)` (no key — global). */
  subscribeConfig: Set<Handler>;
  /** Handlers registered via `subscribeRegistry(handler)` (no key — global). */
  subscribeRegistry: Set<Handler>;
  /** Handlers registered via `subscribeScenarioDefinitions(cpId, connectorId, handler)`,
   *  keyed by `scenarioDefinitionsKey(cpId, connectorId)`. */
  subscribeScenarioDefinitions: Map<string, Set<Handler>>;
}

export type FakeChargePointService = ChargePointService & {
  __handlers: FakeChargePointServiceHandlers;
};

/** Composite key used by `__handlers.subscribeScenarioDefinitions` — use this
 *  instead of hand-building the string so the format stays private. */
export function scenarioDefinitionsKey(
  cpId: string,
  connectorId: number | null,
): string {
  return `${cpId}:${connectorId ?? "cp"}`;
}

function registerHandler<K>(
  map: Map<K, Set<Handler>>,
  key: K,
  handler: Handler,
): () => void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(handler);
  return () => set!.delete(handler);
}

/**
 * Builds a fully-stubbed `ChargePointService` for dom tests.
 *
 * - `listChargePoints` resolves `overrides.snapshots ?? []`.
 * - `getChargePoint(id)` finds the matching snapshot (or null).
 * - `subscribe` / `subscribeConfig` / `subscribeRegistry` /
 *   `subscribeScenarioDefinitions` return no-op unsubscribers and record
 *   every handler on `__handlers` so tests can push synthetic events
 *   straight into whatever the component under test subscribed with.
 * - Any other method is lazily backed by `vi.fn(async () => undefined)` on
 *   first access, so a test only has to describe the calls it cares about.
 */
export function createFakeChargePointService(
  overrides?: Partial<ChargePointService> & {
    snapshots?: ChargePointSnapshot[];
  },
): FakeChargePointService {
  const { snapshots, ...rest } = overrides ?? {};
  const handlers: FakeChargePointServiceHandlers = {
    subscribe: new Map(),
    subscribeConfig: new Set(),
    subscribeRegistry: new Set(),
    subscribeScenarioDefinitions: new Map(),
  };

  const base: Record<string, unknown> = {
    listChargePoints: vi.fn(async () => snapshots ?? []),
    getChargePoint: vi.fn(
      async (id: string) => snapshots?.find((s) => s.id === id) ?? null,
    ),
    subscribe: vi.fn((id: string, handler: Handler) =>
      registerHandler(handlers.subscribe, id, handler),
    ),
    subscribeConfig: vi.fn((handler: Handler) => {
      handlers.subscribeConfig.add(handler);
      return () => handlers.subscribeConfig.delete(handler);
    }),
    subscribeRegistry: vi.fn((handler: Handler) => {
      handlers.subscribeRegistry.add(handler);
      return () => handlers.subscribeRegistry.delete(handler);
    }),
    subscribeScenarioDefinitions: vi.fn(
      (id: string, connectorId: number | null, handler: Handler) =>
        registerHandler(
          handlers.subscribeScenarioDefinitions,
          scenarioDefinitionsKey(id, connectorId),
          handler,
        ),
    ),
    ...rest,
  };

  const service = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "__handlers") return handlers;
      if (typeof prop === "symbol" || Reflect.has(target, prop)) {
        return Reflect.get(target, prop, receiver);
      }
      const stub = vi.fn(async () => undefined);
      target[prop] = stub;
      return stub;
    },
  });

  return service as unknown as FakeChargePointService;
}

export interface RenderConsoleResult<S extends ChargePointService> {
  container: HTMLElement;
  root: Root;
  service: S;
}

/**
 * Renders `<ConsoleRoutes/>` inside a `MemoryRouter` + a `DataContext`
 * wired to a fake (or caller-supplied) `ChargePointService`. Also wraps
 * with `DarkModeProvider` since `AppShell` (mounted on every route) renders
 * `ThemeToggle`, which needs it.
 *
 * The console is mounted at `/v3/*` (mirroring `App.tsx`), so `initialPath`
 * is given console-relative (`/`, `/settings`, `/cp/:id`, …) and is
 * prefixed here — matching how the app's in-console links resolve via
 * `consolePath()`.
 */
export async function renderConsole<
  S extends ChargePointService = FakeChargePointService,
>(
  initialPath: string,
  opts?: { service?: S; mode?: "local" | "remote" },
): Promise<RenderConsoleResult<S>> {
  const service = (opts?.service ?? createFakeChargePointService()) as S;
  const mode = opts?.mode ?? "remote";

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[consolePath(initialPath)]}>
        <DarkModeProvider>
          <DataContext.Provider
            value={{
              mode,
              serverUrl: "http://test",
              defaultEvSettings: null,
              setDefaultEvSettings: () => {},
              chargePointService: service,
            }}
          >
            <Routes>
              <Route
                path={`${CONSOLE_BASENAME}/*`}
                element={<ConsoleRoutes />}
              />
            </Routes>
          </DataContext.Provider>
        </DarkModeProvider>
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });

  return { container, root, service };
}
