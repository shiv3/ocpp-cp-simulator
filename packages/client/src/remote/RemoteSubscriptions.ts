import type {
  ChargePointEvent,
  ChargePointSnapshot,
} from "../interfaces/ChargePointService";
import type { ScenarioDefinition } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import type { HistoryOptions } from "@ocpp-cp-simulator/core/cp/domain/services/StateSnapshot";
import type {
  EventEnvelope,
  Params,
  Result,
  RpcMethod,
  SubscribeResult,
  WireSimulatorConfig,
} from "@ocpp-cp-simulator/contracts/index";
import { mapServerEventToChargePointEvent } from "./mapServerEvent";
import {
  cpListItemToSnapshot,
  snapshotToEvents,
  toChargePointSnapshot,
} from "./snapshotMapping";
import type { RemoteRegistrySubscriptionEvent } from "./RemoteChargePointService";

type CpEventEnvelope = Extract<EventEnvelope, { kind: "cp" }>;
type RegistryEventEnvelope = Extract<EventEnvelope, { kind: "registry" }>;
type ConfigEventEnvelope = Extract<EventEnvelope, { kind: "config" }>;
type ScenarioDefinitionsEventEnvelope = Extract<
  EventEnvelope,
  { kind: "scenario-definitions" }
>;

const CONFIG_EVENTS_SCOPE = "config";
const SCENARIO_DEFINITIONS_EVENTS_SCOPE = "scenario-definitions";

interface ActiveSubscription {
  handlers: Set<(event: ChargePointEvent) => void>;
  ready: boolean;
  queued: CpEventEnvelope[];
}

interface ActiveRegistrySubscription {
  handlers: Set<(event: RemoteRegistrySubscriptionEvent) => void>;
  ready: boolean;
  queued: RegistryEventEnvelope[];
}

interface ActiveConfigSubscription {
  handlers: Set<(config: WireSimulatorConfig | null) => void>;
  ready: boolean;
  queued: ConfigEventEnvelope[];
  current: WireSimulatorConfig | null;
}

interface ActiveScenarioDefinitionsSubscription {
  cpId: string;
  connectorId: number | null;
  handlers: Set<(definitions: ScenarioDefinition[]) => void>;
  ready: boolean;
  queued: ScenarioDefinitionsEventEnvelope[];
  current: ScenarioDefinition[];
}

export interface ScenarioStatusRequest {
  cpId: string;
  connector: number;
  scenarioId: string;
}

/** What the subscription collaborator needs from `RemoteChargePointService`. */
export interface RemoteSubscriptionsHost {
  rpc<M extends RpcMethod>(
    method: M,
    params: Params<M>,
    cpId?: string,
  ): Promise<Result<M>>;
  loadConfig(): Promise<WireSimulatorConfig | null>;
  listScenarioDefinitions(
    cpId: string,
    connectorId: number | null,
  ): Promise<ScenarioDefinition[]>;
  readonly activeStateHistory: Map<string, HistoryOptions | undefined>;
  readonly activeScenarioStatus: Map<string, ScenarioStatusRequest>;
}

export class RemoteSubscriptions {
  readonly subs = new Map<string, ActiveSubscription>();
  readonly snapshotCache = new Map<string, ChargePointSnapshot>();
  readonly registryCache = new Map<string, ChargePointSnapshot>();
  private readonly scenarioDefinitionSubs = new Map<
    string,
    ActiveScenarioDefinitionsSubscription
  >();
  private registrySub: ActiveRegistrySubscription | null = null;
  private configSub: ActiveConfigSubscription | null = null;
  private configScopeSubscribe: Promise<void> | null = null;
  private scenarioDefinitionsScopeSubscribe: Promise<void> | null = null;
  private reconnectSerial = 0;

  constructor(private readonly host: RemoteSubscriptionsHost) {}

  dispose(): void {
    this.subs.clear();
    this.registrySub = null;
    this.configSub = null;
    this.configScopeSubscribe = null;
    this.scenarioDefinitionSubs.clear();
    this.scenarioDefinitionsScopeSubscribe = null;
  }

  subscribeScenarioDefinitions(
    id: string,
    connectorId: number | null,
    handler: (definitions: ScenarioDefinition[]) => void,
  ): () => void {
    const key = scenarioDefinitionsKey(id, connectorId);
    let sub = this.scenarioDefinitionSubs.get(key);
    if (!sub) {
      sub = {
        cpId: id,
        connectorId,
        handlers: new Set(),
        ready: false,
        queued: [],
        current: [],
      };
      this.scenarioDefinitionSubs.set(key, sub);
      void this.refreshScenarioDefinitionsSubscription(key, sub);
    }

    sub.handlers.add(handler);
    if (sub.ready) {
      const definitions = [...sub.current];
      queueMicrotask(() => {
        if (!this.scenarioDefinitionSubs.get(key)?.handlers.has(handler)) {
          return;
        }
        handler(definitions);
      });
    }

    return () => {
      const current = this.scenarioDefinitionSubs.get(key);
      if (!current) return;
      current.handlers.delete(handler);
      if (current.handlers.size === 0) {
        this.scenarioDefinitionSubs.delete(key);
        if (this.scenarioDefinitionSubs.size === 0) {
          this.scenarioDefinitionsScopeSubscribe = null;
          void this.host
            .rpc("events.unsubscribe", {
              scope: SCENARIO_DEFINITIONS_EVENTS_SCOPE,
            })
            .catch(() => {});
        }
      }
    };
  }

  subscribe(
    id: string,
    handler: (event: ChargePointEvent) => void,
  ): () => void {
    let sub = this.subs.get(id);
    if (!sub) {
      sub = { handlers: new Set(), ready: false, queued: [] };
      this.subs.set(id, sub);
      void this.subscribeScope(id).catch((err) => {
        this.emitSubscriptionError(id, err);
      });
    }

    sub.handlers.add(handler);
    const cached = this.snapshotCache.get(id);
    if (sub.ready && cached) {
      queueMicrotask(() => {
        if (!this.subs.get(id)?.handlers.has(handler)) return;
        this.emitSnapshotToHandler(handler, cached);
      });
    }

    return () => {
      const current = this.subs.get(id);
      if (!current) return;
      current.handlers.delete(handler);
      if (current.handlers.size === 0) {
        this.subs.delete(id);
        void this.host.rpc("events.unsubscribe", { scope: id }).catch(() => {});
      }
    };
  }

  subscribeRegistry(
    handler: (event: RemoteRegistrySubscriptionEvent) => void,
  ): () => void {
    if (!this.registrySub) {
      this.registrySub = { handlers: new Set(), ready: false, queued: [] };
      void this.subscribeScope("registry").catch((err) => {
        console.error(
          "[RemoteChargePointService] registry subscribe failed",
          err,
        );
      });
    }

    this.registrySub.handlers.add(handler);
    if (this.registrySub.ready) {
      const cps = [...this.registryCache.values()];
      queueMicrotask(() => {
        if (!this.registrySub?.handlers.has(handler)) return;
        handler({ type: "snapshot", cps });
      });
    }

    return () => {
      const current = this.registrySub;
      if (!current) return;
      current.handlers.delete(handler);
      if (current.handlers.size === 0) {
        this.registrySub = null;
        void this.host
          .rpc("events.unsubscribe", { scope: "registry" })
          .catch(() => {});
      }
    };
  }

  subscribeConfig(
    handler: (config: WireSimulatorConfig | null) => void,
  ): () => void {
    let sub = this.configSub;
    if (!sub) {
      sub = {
        handlers: new Set(),
        ready: false,
        queued: [],
        current: null,
      };
      this.configSub = sub;
      void this.refreshConfigSubscription(sub);
    }

    sub.handlers.add(handler);
    if (sub.ready) {
      const config = sub.current;
      queueMicrotask(() => {
        if (!this.configSub?.handlers.has(handler)) return;
        handler(config);
      });
    }

    return () => {
      const current = this.configSub;
      if (!current) return;
      current.handlers.delete(handler);
      if (current.handlers.size === 0) {
        this.configSub = null;
        this.configScopeSubscribe = null;
        void this.host
          .rpc("events.unsubscribe", {
            scope: CONFIG_EVENTS_SCOPE,
          })
          .catch(() => {});
      }
    };
  }

  markSubscriptionsNotReady(): void {
    for (const sub of this.subs.values()) {
      sub.ready = false;
      sub.queued = [];
    }
    if (this.registrySub) {
      this.registrySub.ready = false;
      this.registrySub.queued = [];
    }
    if (this.configSub) {
      this.configSub.ready = false;
      this.configSub.queued = [];
    }
    for (const sub of this.scenarioDefinitionSubs.values()) {
      sub.ready = false;
      sub.queued = [];
    }
  }

  scheduleReconnectResync(): void {
    const serial = ++this.reconnectSerial;
    queueMicrotask(() => {
      if (serial !== this.reconnectSerial) return;
      void this.resyncAfterReconnect();
    });
  }

  private async resyncAfterReconnect(): Promise<void> {
    this.markSubscriptionsNotReady();
    const scopes = [
      ...(this.registrySub ? ["registry"] : []),
      ...(this.configSub ? [CONFIG_EVENTS_SCOPE] : []),
      ...(this.scenarioDefinitionSubs.size > 0
        ? [SCENARIO_DEFINITIONS_EVENTS_SCOPE]
        : []),
      ...this.subs.keys(),
    ];
    // Scopes are independent subscriptions; resubscribing to one doesn't
    // depend on another finishing, so run them concurrently instead of
    // paying one polling-transport round trip per scope in series.
    await Promise.all(
      scopes.map((scope) =>
        this.subscribeScope(scope).catch((err) => {
          console.warn(
            `[RemoteChargePointService] reconnect resubscribe failed for ${scope}`,
            err,
          );
        }),
      ),
    );
    await this.refetchActiveNonSnapshotViews();
  }

  private async refetchActiveNonSnapshotViews(): Promise<void> {
    const logFetches = [...this.subs.keys()].map((cpId) =>
      this.host.rpc("logs.get", { cpId }).catch(() => undefined),
    );
    const historyFetches = [...this.host.activeStateHistory.entries()].map(
      ([cpId, options]) =>
        this.host
          .rpc(
            "get_state_history",
            (options ? { options } : {}) as Params<"get_state_history">,
            cpId,
          )
          .catch(() => undefined),
    );
    const scenarioFetches = [...this.host.activeScenarioStatus.values()].map(
      (req) =>
        this.host
          .rpc(
            "scenario_status",
            {
              connector: req.connector,
              scenarioId: req.scenarioId,
            },
            req.cpId,
          )
          .catch(() => undefined),
    );
    const configFetch = this.configSub
      ? this.refreshConfigSubscription(this.configSub)
      : Promise.resolve();
    const scenarioDefinitionFetches = [
      ...this.scenarioDefinitionSubs.entries(),
    ].map(([key, sub]) =>
      this.refreshScenarioDefinitionsSubscription(key, sub),
    );
    await Promise.all([
      ...logFetches,
      ...historyFetches,
      ...scenarioFetches,
      configFetch,
      ...scenarioDefinitionFetches,
    ]);
  }

  private ensureConfigEventsSubscribed(): Promise<void> {
    if (!this.configScopeSubscribe) {
      this.configScopeSubscribe = this.subscribeScope(
        CONFIG_EVENTS_SCOPE,
      ).catch((err) => {
        console.warn(
          "[RemoteChargePointService] config event subscribe failed",
          err,
        );
      });
    }
    return this.configScopeSubscribe;
  }

  private ensureScenarioDefinitionsEventsSubscribed(): Promise<void> {
    if (!this.scenarioDefinitionsScopeSubscribe) {
      this.scenarioDefinitionsScopeSubscribe = this.subscribeScope(
        SCENARIO_DEFINITIONS_EVENTS_SCOPE,
      ).catch((err) => {
        console.warn(
          "[RemoteChargePointService] scenario definitions event subscribe failed",
          err,
        );
      });
    }
    return this.scenarioDefinitionsScopeSubscribe;
  }

  private async refreshConfigSubscription(
    sub: ActiveConfigSubscription,
  ): Promise<void> {
    try {
      await this.ensureConfigEventsSubscribed();
      const config = await this.host.loadConfig();
      if (this.configSub !== sub) return;
      this.applyConfigValue(sub, config);
      this.flushConfigQueue(sub);
    } catch (err) {
      console.warn("[RemoteChargePointService] config subscribe failed", err);
    }
  }

  private async refreshScenarioDefinitionsSubscription(
    key: string,
    sub: ActiveScenarioDefinitionsSubscription,
  ): Promise<void> {
    try {
      await this.ensureScenarioDefinitionsEventsSubscribed();
      const definitions = await this.host.listScenarioDefinitions(
        sub.cpId,
        sub.connectorId,
      );
      if (this.scenarioDefinitionSubs.get(key) !== sub) return;
      this.applyScenarioDefinitionsValue(sub, definitions);
      this.flushScenarioDefinitionsQueue(key, sub);
    } catch (err) {
      console.warn(
        "[RemoteChargePointService] scenario definitions subscribe failed",
        err,
      );
    }
  }

  private async subscribeScope(scope: string): Promise<void> {
    const result = await this.host.rpc("events.subscribe", { scope });
    this.applySubscribeResult(scope, result);
  }

  private applySubscribeResult(scope: string, result: SubscribeResult): void {
    const registrySnapshots = result.snapshot.cps.map(cpListItemToSnapshot);
    this.replaceRegistryCache(registrySnapshots);

    for (const [cpId, status] of Object.entries(result.snapshot.perCp)) {
      this.snapshotCache.set(cpId, toChargePointSnapshot(status));
    }

    if (scope === "registry") {
      const registry = this.registrySub;
      if (!registry) return;
      registry.ready = true;
      registry.handlers.forEach((handler) => {
        this.safeRegistryHandler(handler, {
          type: "snapshot",
          cps: [...this.registryCache.values()],
        });
      });
      this.flushRegistryQueue(registry);
      return;
    }

    if (
      scope === CONFIG_EVENTS_SCOPE ||
      scope === SCENARIO_DEFINITIONS_EVENTS_SCOPE
    ) {
      return;
    }

    const sub = this.subs.get(scope);
    if (!sub) return;
    sub.ready = true;
    const snapshot = this.snapshotCache.get(scope);
    if (snapshot) {
      sub.handlers.forEach((handler) => {
        this.emitSnapshotToHandler(handler, snapshot);
      });
    }
    this.flushCpQueue(scope, sub);
  }

  replaceRegistryCache(snapshots: ChargePointSnapshot[]): void {
    this.registryCache.clear();
    for (const snapshot of snapshots) {
      this.registryCache.set(snapshot.id, snapshot);
    }
  }

  readonly handleEnvelope = (envelope: EventEnvelope): void => {
    if (envelope.kind === "cp") {
      const sub = this.subs.get(envelope.cpId);
      if (!sub) return;
      if (!sub.ready) {
        sub.queued.push(envelope);
        return;
      }
      this.deliverCpEnvelope(envelope, sub);
      return;
    }

    if (envelope.kind === "config") {
      const sub = this.configSub;
      if (!sub) return;
      if (!sub.ready) {
        sub.queued.push(envelope);
        return;
      }
      this.deliverConfigEnvelope(envelope, sub);
      return;
    }

    if (envelope.kind === "scenario-definitions") {
      const key = scenarioDefinitionsKey(envelope.cpId, envelope.connectorId);
      const sub = this.scenarioDefinitionSubs.get(key);
      if (!sub) return;
      if (!sub.ready) {
        sub.queued.push(envelope);
        return;
      }
      this.deliverScenarioDefinitionsEnvelope(envelope, sub);
      return;
    }

    if (envelope.kind === "file-reload") {
      // #314: a daemon-side `--watch` reload. The browser has no file view to
      // update, and the fall-through below would otherwise hand this envelope
      // to the registry subscriber, whose shape it is not.
      return;
    }

    const registry = this.registrySub;
    if (!registry) return;
    if (!registry.ready) {
      registry.queued.push(envelope);
      return;
    }
    this.deliverRegistryEnvelope(envelope, registry);
  };

  private flushCpQueue(cpId: string, sub: ActiveSubscription): void {
    const queued = sub.queued;
    sub.queued = [];
    for (const envelope of queued) {
      if (envelope.cpId === cpId) this.deliverCpEnvelope(envelope, sub);
    }
  }

  private flushRegistryQueue(registry: ActiveRegistrySubscription): void {
    const queued = registry.queued;
    registry.queued = [];
    queued.forEach((envelope) => {
      this.deliverRegistryEnvelope(envelope, registry);
    });
  }

  private flushConfigQueue(sub: ActiveConfigSubscription): void {
    const queued = sub.queued;
    sub.queued = [];
    queued.forEach((envelope) => {
      this.deliverConfigEnvelope(envelope, sub);
    });
  }

  private flushScenarioDefinitionsQueue(
    key: string,
    sub: ActiveScenarioDefinitionsSubscription,
  ): void {
    const queued = sub.queued;
    sub.queued = [];
    queued.forEach((envelope) => {
      if (scenarioDefinitionsKey(envelope.cpId, envelope.connectorId) === key) {
        this.deliverScenarioDefinitionsEnvelope(envelope, sub);
      }
    });
  }

  private deliverCpEnvelope(
    envelope: CpEventEnvelope,
    sub: ActiveSubscription,
  ): void {
    const mapped = mapServerEventToChargePointEvent(envelope.evt);
    if (!mapped) return;
    sub.handlers.forEach((handler) => this.safeCpHandler(handler, mapped));
  }

  private deliverConfigEnvelope(
    envelope: ConfigEventEnvelope,
    sub: ActiveConfigSubscription,
  ): void {
    this.applyConfigValue(sub, envelope.config);
  }

  private deliverScenarioDefinitionsEnvelope(
    envelope: ScenarioDefinitionsEventEnvelope,
    sub: ActiveScenarioDefinitionsSubscription,
  ): void {
    this.applyScenarioDefinitionsValue(
      sub,
      envelope.definitions as unknown as ScenarioDefinition[],
    );
  }

  private deliverRegistryEnvelope(
    envelope: RegistryEventEnvelope,
    registry: ActiveRegistrySubscription,
  ): void {
    if (envelope.change === "reset") {
      this.registryCache.clear();
      registry.handlers.forEach((handler) => {
        this.safeRegistryHandler(handler, {
          type: "change",
          change: "reset",
        });
      });
      return;
    }

    const cp = envelope.cp ? cpListItemToSnapshot(envelope.cp) : undefined;
    if (cp) {
      if (envelope.change === "removed") {
        this.registryCache.delete(cp.id);
      } else {
        this.registryCache.set(cp.id, cp);
      }
    }

    registry.handlers.forEach((handler) => {
      this.safeRegistryHandler(handler, {
        type: "change",
        change: envelope.change,
        cp,
      });
    });
  }

  private applyConfigValue(
    sub: ActiveConfigSubscription,
    config: WireSimulatorConfig | null,
  ): void {
    sub.ready = true;
    sub.current = config;
    sub.handlers.forEach((handler) => {
      this.safeConfigHandler(handler, config);
    });
  }

  private applyScenarioDefinitionsValue(
    sub: ActiveScenarioDefinitionsSubscription,
    definitions: ScenarioDefinition[],
  ): void {
    sub.ready = true;
    sub.current = [...definitions];
    sub.handlers.forEach((handler) => {
      this.safeScenarioDefinitionsHandler(handler, [...definitions]);
    });
  }

  private emitSnapshotToHandler(
    handler: (event: ChargePointEvent) => void,
    snapshot: ChargePointSnapshot,
  ): void {
    snapshotToEvents(snapshot).forEach((event) => {
      this.safeCpHandler(handler, event);
    });
  }

  private emitSubscriptionError(id: string, err: unknown): void {
    const sub = this.subs.get(id);
    if (!sub) return;
    const message = err instanceof Error ? err.message : String(err);
    sub.handlers.forEach((handler) => {
      this.safeCpHandler(handler, { type: "error", error: message });
    });
  }

  private safeCpHandler(
    handler: (event: ChargePointEvent) => void,
    event: ChargePointEvent,
  ): void {
    try {
      handler(event);
    } catch (err) {
      console.error("[RemoteChargePointService] handler error", err);
    }
  }

  private safeRegistryHandler(
    handler: (event: RemoteRegistrySubscriptionEvent) => void,
    event: RemoteRegistrySubscriptionEvent,
  ): void {
    try {
      handler(event);
    } catch (err) {
      console.error("[RemoteChargePointService] registry handler error", err);
    }
  }

  private safeConfigHandler(
    handler: (config: WireSimulatorConfig | null) => void,
    config: WireSimulatorConfig | null,
  ): void {
    try {
      handler(config);
    } catch (err) {
      console.error("[RemoteChargePointService] config handler error", err);
    }
  }

  private safeScenarioDefinitionsHandler(
    handler: (definitions: ScenarioDefinition[]) => void,
    definitions: ScenarioDefinition[],
  ): void {
    try {
      handler(definitions);
    } catch (err) {
      console.error(
        "[RemoteChargePointService] scenario definitions handler error",
        err,
      );
    }
  }
}

function scenarioDefinitionsKey(
  cpId: string,
  connectorId: number | null,
): string {
  return `${cpId}\u0000${connectorId ?? "cp"}`;
}
