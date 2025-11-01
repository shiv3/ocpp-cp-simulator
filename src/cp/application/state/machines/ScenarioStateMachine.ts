import { createMachine, state, transition, guard, reduce } from "robot3";

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
  | { type: "START"; mode: ScenarioExecutionMode }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "STOP" }
  | { type: "STEP" }
  | { type: "NODE_COMPLETE"; nodeId: string }
  | { type: "FLOW_COMPLETE" }
  | { type: "ERROR"; error: string }
  | { type: "WAIT_START"; waitType: "status" | "remoteStart" | "delay" }
  | { type: "WAIT_COMPLETE" };

// Guards (transition conditions)
const isStepMode = (ctx: ScenarioContext) => ctx.mode === "step";
const isOneshotMode = (ctx: ScenarioContext) => ctx.mode === "oneshot";

/**
 * Create Scenario State Machine
 * @param initialContext Initial context
 * @returns Robot3 state machine
 */
export function createScenarioMachine(initialContext: ScenarioContext) {
  return createMachine(
    {
      // Idle state - not executing
      idle: state(
        transition(
          "START",
          "running",
          guard(isOneshotMode),
          reduce((ctx: ScenarioContext, event: ScenarioEvent) => ({
            ...ctx,
            mode: event.type === "START" ? event.mode : ctx.mode,
            executedNodes: [],
            loopCount: 0,
            currentNodeId: null,
            error: undefined,
          })),
        ),
        transition(
          "START",
          "stepping",
          guard(isStepMode),
          reduce((ctx: ScenarioContext, event: ScenarioEvent) => ({
            ...ctx,
            mode: event.type === "START" ? event.mode : ctx.mode,
            executedNodes: [],
            loopCount: 0,
            currentNodeId: null,
            error: undefined,
          })),
        ),
      ),

      // Running state - actively executing
      running: state(
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
      paused: state(
        transition("RESUME", "running"),
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
      waiting: state(
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
      stepping: state(
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
      completed: state(
        transition(
          "START",
          "running",
          guard(isOneshotMode),
          reduce((ctx: ScenarioContext, event: ScenarioEvent) => ({
            ...ctx,
            mode: event.type === "START" ? event.mode : ctx.mode,
            executedNodes: [],
            loopCount: 0,
            currentNodeId: null,
            error: undefined,
          })),
        ),
        transition(
          "START",
          "stepping",
          guard(isStepMode),
          reduce((ctx: ScenarioContext, event: ScenarioEvent) => ({
            ...ctx,
            mode: event.type === "START" ? event.mode : ctx.mode,
            executedNodes: [],
            loopCount: 0,
            currentNodeId: null,
            error: undefined,
          })),
        ),
      ),

      // Error state - error occurred
      error: state(
        transition(
          "START",
          "running",
          guard(isOneshotMode),
          reduce((ctx: ScenarioContext, event: ScenarioEvent) => ({
            ...ctx,
            mode: event.type === "START" ? event.mode : ctx.mode,
            executedNodes: [],
            loopCount: 0,
            currentNodeId: null,
            error: undefined,
          })),
        ),
        transition(
          "START",
          "stepping",
          guard(isStepMode),
          reduce((ctx: ScenarioContext, event: ScenarioEvent) => ({
            ...ctx,
            mode: event.type === "START" ? event.mode : ctx.mode,
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
    // Initial context
    (initialState) => ({
      ...initialContext,
      current: initialState,
    }),
  );
}

/**
 * Get state name from machine state
 * @param machineState Robot3 machine state
 * @returns State name as string
 */
export function getScenarioStateName(machineState: { name: string }): string {
  return machineState.name;
}

/**
 * Get context from machine state
 * @param machineState Robot3 machine state
 * @returns Scenario context
 */
export function getScenarioContext(machineState: {
  context: ScenarioContext;
}): ScenarioContext {
  return {
    scenarioId: machineState.context.scenarioId,
    mode: machineState.context.mode || "oneshot",
    currentNodeId: machineState.context.currentNodeId || null,
    executedNodes: machineState.context.executedNodes || [],
    loopCount: machineState.context.loopCount || 0,
    error: machineState.context.error,
    waitType: machineState.context.waitType,
  };
}
