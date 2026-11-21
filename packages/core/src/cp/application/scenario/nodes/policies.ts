import type {
  CertQuirksNodeData,
  InboundPolicyNodeData,
  ResponseOverrideNodeData,
} from "../ScenarioTypes";
import type { NodeRunContext } from "./context";

/**
 * Issue #110: pre-arm a one-shot `{ status }` response override. #1090: any
 * other `mode` (a CALLERROR, a raw payload or frame, a CALLRESULTERROR, a
 * delay, silence) and `times` / `persistent` arm through the same node.
 */
export async function executeResponseOverride(
  ctx: NodeRunContext,
  data: ResponseOverrideNodeData,
): Promise<void> {
  const plain =
    (data.mode === undefined || data.mode === "status") &&
    data.times === undefined &&
    data.persistent === undefined &&
    data.delayMs === undefined &&
    typeof data.status === "string";
  if (plain) {
    if (!ctx.callbacks.onArmResponseOverride) {
      ctx.callbacks.log?.(
        "ResponseOverride: no onArmResponseOverride callback wired",
        "warn",
      );
      return;
    }
    ctx.callbacks.onArmResponseOverride(data.action, data.status as string);
  } else {
    if (!ctx.callbacks.onSetResponseOverride) {
      ctx.callbacks.log?.(
        "ResponseOverride: no onSetResponseOverride callback wired",
        "warn",
      );
      return;
    }
    const { action, mode, status, errorCode, errorDescription, errorDetails } =
      data;
    ctx.callbacks.onSetResponseOverride({
      action,
      ...(mode === undefined ? {} : { mode }),
      ...(status === undefined ? {} : { status }),
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(errorDescription === undefined ? {} : { errorDescription }),
      ...(errorDetails === undefined ? {} : { errorDetails }),
      ...(data.payload === undefined ? {} : { payload: data.payload }),
      ...(data.frame === undefined ? {} : { frame: data.frame }),
      ...(data.delayMs === undefined ? {} : { delayMs: data.delayMs }),
      ...(data.times === undefined ? {} : { times: data.times }),
      ...(data.persistent === undefined ? {} : { persistent: data.persistent }),
    });
  }
  // Issue #110: track this action so we can clear it when the run ends.
  if (!ctx.armedOverrideActions.includes(data.action)) {
    ctx.armedOverrideActions.push(data.action);
  }
  ctx.callbacks.log?.(
    `Armed response override: ${data.action} → ${data.mode ?? "status"}${
      data.status !== undefined ? ` ${data.status}` : ""
    }`,
    "info",
  );
}

/** Issue #247: set or clear an inbound call policy. */
export async function executeInboundPolicy(
  ctx: NodeRunContext,
  data: InboundPolicyNodeData,
): Promise<void> {
  if (data.policy === "answer") {
    // Clear the policy for this action.
    if (!ctx.callbacks.onClearInboundPolicy) {
      ctx.callbacks.log?.(
        "InboundPolicy: no onClearInboundPolicy callback wired",
        "warn",
      );
      return;
    }
    ctx.callbacks.onClearInboundPolicy(data.action);
    ctx.callbacks.log?.(`Cleared inbound policy: ${data.action}`, "info");
  } else if (data.policy === "callerror" || data.policy === "ignore") {
    // Arm a new policy.
    if (!ctx.callbacks.onSetInboundPolicy) {
      ctx.callbacks.log?.(
        "InboundPolicy: no onSetInboundPolicy callback wired",
        "warn",
      );
      return;
    }
    ctx.callbacks.onSetInboundPolicy(
      data.action,
      data.policy,
      data.errorCode,
      data.errorDescription,
    );
    // Track this action so we can clear it when the run ends.
    if (!ctx.armedInboundPolicyActions.includes(data.action)) {
      ctx.armedInboundPolicyActions.push(data.action);
    }
    const policyDesc =
      data.policy === "callerror"
        ? `callerror(${data.errorCode ?? "NotImplemented"})`
        : "ignore";
    ctx.callbacks.log?.(
      `Armed inbound policy: ${data.action} → ${policyDesc}`,
      "info",
    );
  }
}

/** Issue #247 Phase 3: set or clear certificate quirks. */
export async function executeCertQuirks(
  ctx: NodeRunContext,
  data: CertQuirksNodeData,
): Promise<void> {
  if (data.mode === "clear") {
    // Clear all quirks.
    if (!ctx.callbacks.onClearCertificateQuirks) {
      ctx.callbacks.log?.(
        "CertQuirks: no onClearCertificateQuirks callback wired",
        "warn",
      );
      return;
    }
    ctx.callbacks.onClearCertificateQuirks();
    ctx.callbacks.log?.("Cleared certificate quirks", "info");
  } else if (data.mode === "set") {
    // Build quirks from preset (if any) + explicit overrides.
    const quirks: Record<string, unknown> = {};

    // Start with preset if specified
    if (data.preset === "octt") {
      quirks.csrKeyAlgorithm = "RSA";
      quirks.csrPemLineEndings = "crlf";
      quirks.requiredCertificateSignatureAlgorithms = ["RSASSA-PKCS1-v1_5"];
      quirks.hiddenConfigurationKeys = ["CpoName"];
    }

    // Apply explicit field overrides
    if (data.csrKeyAlgorithm !== undefined) {
      quirks.csrKeyAlgorithm = data.csrKeyAlgorithm;
    }
    if (data.csrPemLineEndings !== undefined) {
      quirks.csrPemLineEndings = data.csrPemLineEndings;
    }
    if (data.requiredCertificateSignatureAlgorithms !== undefined) {
      quirks.requiredCertificateSignatureAlgorithms =
        data.requiredCertificateSignatureAlgorithms;
    }
    if (data.hiddenConfigurationKeys !== undefined) {
      quirks.hiddenConfigurationKeys = data.hiddenConfigurationKeys;
    }

    if (!ctx.callbacks.onSetCertificateQuirks) {
      ctx.callbacks.log?.(
        "CertQuirks: no onSetCertificateQuirks callback wired",
        "warn",
      );
      return;
    }

    ctx.callbacks.onSetCertificateQuirks(
      quirks as Parameters<
        NonNullable<typeof ctx.callbacks.onSetCertificateQuirks>
      >[0],
    );
    ctx.markCertificateQuirksArmed();

    const presetDesc = data.preset ? ` (preset: ${data.preset})` : "";
    ctx.callbacks.log?.(
      `Armed certificate quirks${presetDesc}: ${JSON.stringify(quirks)}`,
      "info",
    );
  }
}
