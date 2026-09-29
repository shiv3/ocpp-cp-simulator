import { createMachine, transition, guard, reduce, type Service } from "robot3";
import { stateFor } from "./stateFor";

/**
 * Scenario execution mode
 */
export type ScenarioExecutionMode = "oneshot" | "step";

/**
 * Scenario state machine context
 */
export interface ScenarioContext {
  scenarioId: string;
  mode: ScenarioExecutionMode;
  currentNodeId: string | null;
  executedNodes: string[];
  loopCount: number;
  error?: string;
  waitType?: "status" | "remoteStart" | "delay";
}

/**
 * Scenario event type definitions
 */
export type ScenarioEvent =
  | { type: "START"; mode?: ScenarioExecutionMode }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "STOP" }
  | { type: "STEP" }
  | { type: "NODE_COMPLETE"; nodeId: string }
  | { type: "FLOW_COMPLETE" }
  | { type: "ERROR"; error: string }
  | { type: "WAIT_START"; waitType: "status" | "remoteStart" | "delay" }
  | { type: "WAIT_COMPLETE" };

const scenarioState = stateFor<ScenarioEvent["type"]>();

// Guards (transition conditions)
const startMode = (event: ScenarioEvent): ScenarioExecutionMode =>
  event.type === "START" ? (event.mode ?? "oneshot") : "oneshot";
const isStartStepMode = (_ctx: ScenarioContext, event: ScenarioEvent) =>
  startMode(event) === "step";
const isStartOneshotMode = (_ctx: ScenarioContext, event: ScenarioEvent) =>
  startMode(event) === "oneshot";

/**
 * Create Scenario State Machine
 * @param initialContext Initial context
 * @returns Robot3 state machine
 */
export function createScenarioMachine(initialContext: ScenarioContext) {
  return createMachine(
    {
      // Idle state - not executing
      idle: scenarioState(
        transition(
          "START",
          "running",
          guard(isStartOneshotMode),
          reduce((ctx: ScenarioContext, event: ScenarioEvent) => ({
            ...ctx,
            mode: event.type === "START" ? (event.mode ?? "oneshot") : ctx.mode,
            executedNodes: [],
            loopCount: 0,
            currentNodeId: null,
            error: undefined,
          })),
        ),
        transition(
          "START",
          "stepping",
          guard(isStartStepMode),
          reduce((ctx: ScenarioContext, event: ScenarioEvent) => ({
            ...ctx,
            mode: event.type === "START" ? (event.mode ?? "oneshot") : ctx.mode,
            executedNodes: [],
            loopCount: 0,
            currentNodeId: null,
            error: undefined,
          })),
        ),
      ),

      // Running state - actively executing
      running: scenarioState(
        transition("PAUSE", "paused"),
        transition(
          "WAIT_START",
          "waiting",
          reduce((ctx: ScenarioContext, event: ScenarioEvent) => ({
            ...ctx,
            waitType:
              event.type === "WAIT_START" ? event.waitType : ctx.waitType,
          })),
        ),
        transition(
          "NODE_COMPLETE",
          "running",
          reduce((ctx: ScenarioContext, event: ScenarioEvent) => ({
            ...ctx,
            currentNodeId:
              event.type === "NODE_COMPLETE" ? event.nodeId : ctx.currentNodeId,
          })),
        ),
        transition("FLOW_COMPLETE", "completed"),
        transition(
          "ERROR",
          "error",
          reduce((ctx: ScenarioContext, event: ScenarioEvent) => ({
            ...ctx,
            error: event.type === "ERROR" ? event.error : ctx.error,
          })),
        ),
        transition(
          "STOP",
          "idle",
          reduce((ctx: ScenarioContext) => ({
            ...ctx,
            currentNodeId: null,
          })),
        ),
      ),

      // Paused state - temporarily halted
      paused: scenarioState(
        transition("RESUME", "running"),
        transition(
          "ERROR",
          "error",
          reduce((ctx: ScenarioContext, event: ScenarioEvent) => ({
            ...ctx,
            error: event.type === "ERROR" ? event.error : ctx.error,
          })),
        ),
        transition(
          "STOP",
          "idle",
          reduce((ctx: ScenarioContext) => ({
            ...ctx,
            currentNodeId: null,
          })),
        ),
      ),

      // Waiting state - blocked on async operation
      waiting: scenarioState(
        transition("WAIT_COMPLETE", "running"),
        transition(
          "ERROR",
          "error",
          reduce((ctx: ScenarioContext, event: ScenarioEvent) => ({
            ...ctx,
            error: event.type === "ERROR" ? event.error : ctx.error,
          })),
        ),
        transition(
          "STOP",
          "idle",
          reduce((ctx: ScenarioContext) => ({
            ...ctx,
            currentNodeId: null,
            waitType: undefined,
          })),
        ),
      ),

      // Stepping state - waiting for step command
      stepping: scenarioState(
        transition(
          "STEP",
          "stepping",
          reduce((ctx: ScenarioContext) => ({
            ...ctx,
          })),
        ),
        transition(
          "NODE_COMPLETE",
          "stepping",
          reduce((ctx: ScenarioContext, event: ScenarioEvent) => ({
            ...ctx,
            currentNodeId:
              event.type === "NODE_COMPLETE" ? event.nodeId : ctx.currentNodeId,
          })),
        ),
        transition("FLOW_COMPLETE", "completed"),
        transition(
          "ERROR",
          "error",
          reduce((ctx: ScenarioContext, event: ScenarioEvent) => ({
            ...ctx,
            error: event.type === "ERROR" ? event.error : ctx.error,
          })),
        ),
        transition(
          "STOP",
          "idle",
          reduce((ctx: ScenarioContext) => ({
            ...ctx,
            currentNodeId: null,
          })),
        ),
      ),

      // Completed state - successfully finished
      completed: scenarioState(
        transition(
          "START",
          "running",
          guard(isStartOneshotMode),
          reduce((ctx: ScenarioContext, event: ScenarioEvent) => ({
            ...ctx,
            mode: event.type === "START" ? (event.mode ?? "oneshot") : ctx.mode,
            executedNodes: [],
            loopCount: 0,
            currentNodeId: null,
            error: undefined,
          })),
        ),
        transition(
          "START",
          "stepping",
          guard(isStartStepMode),
          reduce((ctx: ScenarioContext, event: ScenarioEvent) => ({
            ...ctx,
            mode: event.type === "START" ? (event.mode ?? "oneshot") : ctx.mode,
            executedNodes: [],
            loopCount: 0,
            currentNodeId: null,
            error: undefined,
          })),
        ),
      ),

      // Error state - error occurred
      error: scenarioState(
        transition(
          "START",
          "running",
          guard(isStartOneshotMode),
          reduce((ctx: ScenarioContext, event: ScenarioEvent) => ({
            ...ctx,
            mode: event.type === "START" ? (event.mode ?? "oneshot") : ctx.mode,
            executedNodes: [],
            loopCount: 0,
            currentNodeId: null,
            error: undefined,
          })),
        ),
        transition(
          "START",
          "stepping",
          guard(isStartStepMode),
          reduce((ctx: ScenarioContext, event: ScenarioEvent) => ({
            ...ctx,
            mode: event.type === "START" ? (event.mode ?? "oneshot") : ctx.mode,
            executedNodes: [],
            loopCount: 0,
            currentNodeId: null,
            error: undefined,
          })),
        ),
        transition(
          "STOP",
          "idle",
          reduce((ctx: ScenarioContext) => ({
            ...ctx,
            currentNodeId: null,
            error: undefined,
          })),
        ),
      ),
    },
    // Initial context. robot3 passes this function the context given to
    // `interpret`, which no caller supplies.
    (): ScenarioContext => ({ ...initialContext }),
  );
}

/** A running (`interpret`ed) machine built by {@link createScenarioMachine}. */
export type ScenarioMachineService = Service<
  ReturnType<typeof createScenarioMachine>
>;

/**
 * Get state name from a Robot3 service
 * @param service Robot3 service
 * @returns State name as string
 */
export function getScenarioStateName(service: {
  machine: { current: string };
}): string {
  return service.machine.current;
}

/**
 * Get context from a Robot3 service
 * @param service Robot3 service
 * @returns Scenario context
 */
export function getScenarioContext(service: {
  context: ScenarioContext;
}): ScenarioContext {
  const context = service.context;
  return {
    scenarioId: context.scenarioId,
    mode: context.mode || "oneshot",
    currentNodeId: context.currentNodeId || null,
    executedNodes: [...(context.executedNodes || [])],
    loopCount: context.loopCount || 0,
    error: context.error,
    waitType: context.waitType,
  };
}
