// Golden cases for the built-in scenario templates: each template is run by a
// real ScenarioExecutor on a real ChargePoint, and the "CSMS operator" the
// template's README describes is played by the fake CSMS.
import { ScenarioExecutor } from "../../cp/application/scenario/ScenarioExecutor";
import { createScenarioExecutorCallbacks } from "../../cp/application/scenario/ScenarioRuntime";
import type {
  ScenarioDefinition,
  ScenarioEvents,
} from "../../cp/application/scenario/ScenarioTypes";
import { EventEmitter } from "../../cp/shared/EventEmitter";
import { OCPPStatus } from "../../cp/domain/types/OcppTypes";
import { scenarioTemplates } from "../../utils/scenarioTemplates";
import type { GoldenCase } from "./cases";
import type { Rig } from "./rig";

const PAST = "2020-01-01T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";

/** How long after a wait node starts the fake CSMS sends the call it waits
 *  for. It keeps the call clear of the 5 s meter ticks the templates run, so
 *  that "call before tick" does not hinge on a few milliseconds. */
const OPERATOR_DELAY_MS = 700;

interface NodeLike {
  readonly id: string;
  readonly type: string;
  readonly data: Record<string, unknown>;
}

/**
 * Built-in templates that cannot run to completion unattended, with the
 * reason. They are recorded for a fixed window (see {@link WINDOWED_MS}) and
 * then stopped, so the frames up to that point are still pinned.
 */
export const NOT_UNATTENDED: Readonly<Record<string, string>> = {
  "status-triggered-actions":
    "loops forever (a heartbeat every 10 s) until it is stopped",
  "full-charging-cycle":
    "its Auto MeterValue node runs until 25000 Wh or 300 s, about five minutes",
  "essential-cp-behavior":
    "its Auto MeterValue node (stopMode evSettings) never ends on its own, so the RemoteStop wait after it is unreachable",
  "smart-charging":
    "its Auto MeterValue node runs until 30000 Wh (300 s), and the wait for Finishing comes after it",
  "multi-status-monitor":
    "its Charging branch ends in an Auto MeterValue node that runs until 20000 Wh (200 s)",
};

/** How long each of those is run before it is stopped. The windows end well
 *  clear of the 5 s and 10 s meter ticks. */
const WINDOWED_MS: Readonly<Record<string, number>> = {
  "status-triggered-actions": 1500,
  "full-charging-cycle": 7500,
  "essential-cp-behavior": 6000,
  "smart-charging": 3500,
  "multi-status-monitor": 3000,
};

type Operator = (rig: Rig, node: NodeLike) => Promise<void> | void;

/** Payload the fake CSMS sends for a csmsCallTrigger, by template then action. */
function callPayload(
  rig: Rig,
  templateId: string,
  action: string,
  nth: number,
): unknown {
  const specific: Record<string, unknown> = {
    "cert16-tc013-hard-reset:Reset": { type: "Hard" },
    "cert16-tc014-soft-reset:Reset": { type: "Soft" },
    "cert16-tc019-get-configuration-key:GetConfiguration": {
      key: ["HeartbeatInterval"],
    },
    "cert16-tc031-unlock-unknown-connector:UnlockConnector": {
      connectorId: 99,
    },
    "cert16-tc043-3-send-local-list-failed:SendLocalList": {
      listVersion: 1,
      updateType: "Full",
      localAuthorizationList: [],
    },
    "cert16-tc043-5-send-local-list-differential:SendLocalList#1": {
      listVersion: 2,
      updateType: "Differential",
      localAuthorizationList: [
        { idTag: "LOCAL-2", idTagInfo: { status: "Accepted" } },
      ],
    },
    "cert16-tc052-cancel-reservation-rejected:CancelReservation": {
      reservationId: 4242,
    },
    "cert16-tc055-trigger-message-rejected:TriggerMessage": {
      requestedMessage: "Heartbeat",
    },
    "cert16-tc056-central-smart-charging-txdefault:SetChargingProfile": {
      connectorId: 1,
      csChargingProfiles: {
        chargingProfileId: 56,
        stackLevel: 0,
        chargingProfilePurpose: "TxDefaultProfile",
        chargingProfileKind: "Absolute",
        chargingSchedule: {
          chargingRateUnit: "W",
          chargingSchedulePeriod: [{ startPeriod: 0, limit: 7000 }],
        },
      },
    },
    "cert16-tc057-central-smart-charging-txprofile:SetChargingProfile": {
      connectorId: 1,
      csChargingProfiles: {
        chargingProfileId: 57,
        transactionId: 1,
        stackLevel: 1,
        chargingProfilePurpose: "TxProfile",
        chargingProfileKind: "Absolute",
        chargingSchedule: {
          chargingRateUnit: "W",
          chargingSchedulePeriod: [{ startPeriod: 0, limit: 5000 }],
        },
      },
    },
  };
  const generic: Record<string, unknown> = {
    Reset: { type: "Soft" },
    GetConfiguration: {},
    ChangeConfiguration: { key: "MeterValueSampleInterval", value: "30" },
    RemoteStartTransaction: { idTag: "CSMS-RS", connectorId: 1 },
    RemoteStopTransaction: { transactionId: rig.transactionId(1) },
    GetLocalListVersion: {},
    SendLocalList: {
      listVersion: 1,
      updateType: "Full",
      localAuthorizationList: [
        { idTag: "LOCAL-1", idTagInfo: { status: "Accepted" } },
      ],
    },
    UpdateFirmware: {
      location: "https://fw.example.test/fw.bin",
      retrieveDate: PAST,
    },
    GetDiagnostics: { location: rig.uploadUrl() },
    ReserveNow: {
      connectorId: 1,
      expiryDate: FUTURE,
      idTag: "RES-1",
      reservationId: 1,
    },
    CancelReservation: { reservationId: 1 },
    TriggerMessage: { requestedMessage: "StatusNotification", connectorId: 1 },
    UnlockConnector: { connectorId: 1 },
    SetChargingProfile: {
      connectorId: 1,
      csChargingProfiles: {
        chargingProfileId: 1,
        stackLevel: 0,
        chargingProfilePurpose: "TxDefaultProfile",
        chargingProfileKind: "Absolute",
        chargingSchedule: {
          chargingRateUnit: "W",
          chargingSchedulePeriod: [{ startPeriod: 0, limit: 7000 }],
        },
      },
    },
    GetCompositeSchedule: { connectorId: 1, duration: 600 },
    ClearChargingProfile: { id: 1 },
    ClearCache: {},
    DataTransfer: { vendorId: "com.example" },
  };
  const key = `${templateId}:${action}`;
  if (`${key}#${nth}` in specific) return specific[`${key}#${nth}`];
  if (key in specific) return specific[key];
  if (action in generic) return generic[action];
  throw new Error(
    `golden scenarios: no payload for ${action} in ${templateId}`,
  );
}

function operatorFor(templateId: string): Operator {
  const nth = new Map<string, number>();
  return async (rig, node) => {
    const send = async (action: string, payload: unknown) => {
      await new Promise((r) => setTimeout(r, OPERATOR_DELAY_MS));
      await rig.csms.call(action, payload);
    };
    switch (node.type) {
      case "csmsCallTrigger": {
        const action = String(node.data.action);
        const n = nth.get(action) ?? 0;
        nth.set(action, n + 1);
        await send(action, callPayload(rig, templateId, action, n));
        return;
      }
      case "remoteStartTrigger":
        await send(
          "RemoteStartTransaction",
          callPayload(rig, templateId, "RemoteStartTransaction", 0),
        );
        return;
      case "remoteStopTrigger":
        await send(
          "RemoteStopTransaction",
          callPayload(rig, templateId, "RemoteStopTransaction", 0),
        );
        return;
      case "reservationTrigger":
        await send("ReserveNow", callPayload(rig, templateId, "ReserveNow", 0));
        return;
      case "unlockOutcome":
        await send(
          "UnlockConnector",
          callPayload(rig, templateId, "UnlockConnector", 0),
        );
        return;
      default:
        return;
    }
  };
}

/** Per-template extra CSMS-side or EV-side steps run once the run started. */
const SIDE_STEPS: Readonly<Record<string, (rig: Rig) => Promise<void>>> = {
  // These three wait for the connector to reach a status; the EV side
  // (plug-in, a local start, a fault) is what the operator does by hand.
  "multi-status-monitor": async (rig) => {
    await new Promise((r) => setTimeout(r, 400));
    rig.plugIn();
    await new Promise((r) => setTimeout(r, 400));
    await rig.cp.startTransaction("MSM-1", 1);
    await new Promise((r) => setTimeout(r, 400));
    rig.cp.updateConnectorStatus(1, OCPPStatus.Faulted);
    await new Promise((r) => setTimeout(r, 400));
  },
  "smart-charging": async (rig) => {
    await new Promise((r) => setTimeout(r, 400));
    rig.plugIn();
    await new Promise((r) => setTimeout(r, 400));
    await rig.cp.startTransaction("SC-1", 1);
    await new Promise((r) => setTimeout(r, 700));
    rig.cp.stopTransaction(1);
  },
};

async function runTemplate(rig: Rig, templateId: string): Promise<void> {
  const template = scenarioTemplates.find((t) => t.id === templateId);
  if (!template) throw new Error(`unknown template ${templateId}`);
  const cp = rig.cp;
  const connector = cp.getConnector(1);
  if (!connector) throw new Error("connector 1 missing");
  const def: ScenarioDefinition = template.createScenario(cp.id, 1);
  const callbacks = createScenarioExecutorCallbacks({
    chargePoint: cp,
    connector,
  });
  const originalStart = callbacks.onStartTransaction;
  callbacks.onStartTransaction = async (...args) => {
    const outcome = await originalStart?.(...args);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const tx = connector.transaction;
      if (
        (tx?.id ?? 0) > 0 ||
        (typeof tx?.cpTransactionId === "string" &&
          tx.cpTransactionId.length > 0)
      )
        break;
      await new Promise((r) => setTimeout(r, 10));
    }
    return outcome as never;
  };
  const events = new EventEmitter<ScenarioEvents>();
  let finished: (error?: unknown) => void = () => undefined;
  const done = new Promise<void>((resolve, reject) => {
    finished = (error) => (error ? reject(error) : resolve());
  });
  events.on("execution.completed", () => finished());
  events.on("execution.error", (info) =>
    finished(new Error(String(JSON.stringify(info)))),
  );
  const operator = operatorFor(templateId);
  let chain: Promise<void> = Promise.resolve();
  const seen = new Set<string>();
  events.on("node.execute", (data) => {
    const { nodeId } = data as { nodeId?: string };
    const node = (def.nodes as unknown as NodeLike[]).find(
      (n) => n.id === nodeId,
    );
    if (!node || seen.has(node.id)) return;
    seen.add(node.id);
    chain = chain.then(() => operator(rig, node));
  });
  const executor = new ScenarioExecutor(def, callbacks, events);
  const side = SIDE_STEPS[templateId]?.(rig);
  const running = executor.start();
  const windowMs = WINDOWED_MS[templateId];
  try {
    if (windowMs !== undefined) {
      await new Promise((r) => setTimeout(r, windowMs));
    } else {
      await Promise.race([
        done,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`scenario ${templateId} did not finish`)),
            80_000,
          ),
        ),
      ]);
    }
    await side;
    await chain;
  } finally {
    executor.stop();
    await running.catch(() => undefined);
  }
  await rig.csms.settle(400);
}

export const scenarioCases: GoldenCase[] = scenarioTemplates.map((t) => ({
  name: `16-scenario-${t.id}`,
  version: "1.6",
  run: (rig) => runTemplate(rig, t.id),
}));
