import { Server as SocketIoServer } from "socket.io";

import type { CLIChargePointService } from "../service";
import {
  eventEnvelopeSchema,
  eventToWire,
  registryCpToWire,
  statusToWire,
} from "../../protocol";
import type { CPRegistry } from "./CPRegistry";
import type { EventBus, EventEnvelope as BusEventEnvelope } from "./eventBus";

type FullCp = Parameters<typeof registryCpToWire>[0];

export interface RegistryEventBridge {
  emitReset(): void;
  close(): void;
}

export function createRegistryEventBridge(
  io: SocketIoServer,
  deps: { registry: CPRegistry; bus: EventBus },
): RegistryEventBridge {
  const lastSummaryByCp = new Map<string, string>();

  const unsubscribeRegistry = deps.registry.onRegistryMembership((event) => {
    const cp = cpForWire(event.cpId, event.service);
    if (event.change === "added") {
      lastSummaryByCp.set(event.cpId, summaryJson(event.service.getStatus()));
    } else {
      lastSummaryByCp.delete(event.cpId);
    }
    emitRegistry(io, event.change, cp);
  });

  const unsubscribeBus = deps.bus.subscribe("*", (env) => {
    emitCp(io, env);
    maybeEmitUpdated(io, deps.registry, lastSummaryByCp, env.cpId);
  });

  return {
    emitReset() {
      lastSummaryByCp.clear();
      emitRegistry(io, "reset");
    },
    close() {
      unsubscribeBus();
      unsubscribeRegistry();
      lastSummaryByCp.clear();
    },
  };
}

function maybeEmitUpdated(
  io: SocketIoServer,
  registry: CPRegistry,
  lastSummaryByCp: Map<string, string>,
  cpId: string,
): void {
  const service = registry.get(cpId);
  if (!service) {
    lastSummaryByCp.delete(cpId);
    return;
  }

  const next = summaryJson(service.getStatus());
  if (lastSummaryByCp.get(cpId) === next) return;

  lastSummaryByCp.set(cpId, next);
  emitRegistry(io, "updated", cpForWire(cpId, service));
}

function emitCp(io: SocketIoServer, env: BusEventEnvelope): void {
  const envelope = eventEnvelopeSchema.parse({
    kind: "cp",
    cpId: env.cpId,
    evt: eventToWire(env.evt),
  });
  io.to(env.cpId).to("*").emit("event", envelope);
}

function emitRegistry(
  io: SocketIoServer,
  change: "added" | "removed" | "updated" | "reset",
  cp?: FullCp,
): void {
  const envelope = eventEnvelopeSchema.parse({
    kind: "registry",
    change,
    ...(cp ? { cp: registryCpToWire(cp) } : {}),
  });
  io.to("registry").to("*").emit("event", envelope);
}

function cpForWire(cpId: string, service: CLIChargePointService): FullCp {
  const status = service.getStatus();
  const init = service.getInit();
  return {
    id: cpId,
    status: status.status,
    config: status.config ?? {
      wsUrl: init.wsUrl,
      connectors: init.connectors,
      vendor: init.vendor,
      model: init.model,
      basicAuth: init.basicAuth,
      ocppVersion: init.ocppVersion,
      bootNotification: init.bootNotification ?? null,
    },
  };
}

function summaryJson(
  status: ReturnType<CLIChargePointService["getStatus"]>,
): string {
  const wire = statusToWire(status);
  const connectors = wire.connectors
    .map((connector) => ({
      id: connector.id,
      status: connector.status,
    }))
    .sort((a, b) => a.id - b.id);

  return JSON.stringify({
    status: wire.status,
    connectorCount: connectors.length,
    connectors,
  });
}
