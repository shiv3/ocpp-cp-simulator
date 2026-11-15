import {
  DIAGNOSTICS_STATUSES,
  FIRMWARE_STATUSES,
  UPLOAD_LOG_STATUSES,
} from "../firmwareLogStatus";
import { z } from "zod";
import { STR_64K } from "../limits";
import { statusWireSchema } from "../events";
import {
  ID_TOKEN_TYPE_VALUES as ID_TOKEN_TYPES,
  METER_READING_CONTEXTS,
  STOP_REASONS,
  TRANSACTION_CHARGING_STATE_VALUES as TRANSACTION_CHARGING_STATES,
  TRANSACTION_EVENT_TRIGGER_REASON_VALUES as TRANSACTION_EVENT_TRIGGER_REASONS,
} from "../transactionVocabulary";
import { OCPPStatus } from "../connectorStatus";
import {
  CONN_POS,
  CONN_NONNEG,
  EMPTY,
  STOP_ON_CLOSE,
  NON_EMPTY_STR,
  SCENARIO_MODES,
  ANY,
  OBJ,
  dataTransferDataSchema,
  authorizationCacheSeedSchema,
  authorizationCacheViewSchema,
  ocppCallOutcomeSchema,
  rawFrameOutcomeSchema,
  BASE64_STR,
  get15118EVCertificateResultSchema,
} from "../schemas/common";

export const CP_COMMAND_METHODS = {
  connect: { params: EMPTY, result: ANY },
  disconnect: { params: z.object(STOP_ON_CLOSE), result: ANY },
  reset: { params: EMPTY, result: ANY },
  status: { params: EMPTY, result: statusWireSchema },
  heartbeat: { params: EMPTY, result: ANY },
  start_heartbeat: {
    params: z.object({ interval: z.number().positive() }),
    result: ANY,
  },
  stop_heartbeat: { params: EMPTY, result: ANY },

  // -- transactions --
  start_transaction: {
    // `tagId` is optional since #299: without one the charge point draws from
    // its idTag pool, and falls back to the historical literal if it has none.
    // `triggerReason` / `chargingState` (#335) shape the OCPP 2.x Started
    // event; OCPP 1.6 ignores them.
    params: z.object({
      connector: CONN_POS,
      tagId: NON_EMPTY_STR.optional(),
      triggerReason: z
        .enum(TRANSACTION_EVENT_TRIGGER_REASONS)
        .optional()
        .describe(
          "OCPP 2.x TransactionEvent(Started) triggerReason; default Authorized",
        ),
      chargingState: z
        .enum(TRANSACTION_CHARGING_STATES)
        .optional()
        .describe(
          "OCPP 2.x TransactionEvent(Started) chargingState; default from the cable: Idle without one, else Charging (#846)",
        ),
      idTokenType: z
        .enum(ID_TOKEN_TYPES)
        .optional()
        .describe(
          "OCPP 2.x IdToken.type sent in the Authorize and TransactionEvent of this transaction; default ISO14443 (#599). Ignored on OCPP 1.6",
        ),
    }),
    result: ANY,
  },
  stop_transaction: {
    // `reason` (#335) accepts both the 1.6 StopTransaction.req and the 2.0.1
    // stoppedReason vocabularies; each encoder reads the value it can spell.
    params: z.object({
      connector: CONN_POS,
      reason: z
        .enum(STOP_REASONS)
        .optional()
        .describe(
          "StopTransaction.req reason (1.6) / TransactionEvent(Ended) stoppedReason (2.x); default Local",
        ),
      triggerReason: z
        .enum(TRANSACTION_EVENT_TRIGGER_REASONS)
        .optional()
        .describe(
          "OCPP 2.x TransactionEvent(Ended) triggerReason; default StopAuthorized",
        ),
    }),
    result: ANY,
  },
  // #335: a driven OCPP 2.x TransactionEvent(Updated). On OCPP 1.6 the charge
  // point logs a warning and sends nothing.
  transaction_event: {
    params: z.object({
      connector: CONN_POS,
      triggerReason: z
        .enum(TRANSACTION_EVENT_TRIGGER_REASONS)
        .describe("TransactionEvent(Updated) triggerReason"),
      chargingState: z
        .enum(TRANSACTION_CHARGING_STATES)
        .optional()
        .describe("transactionInfo.chargingState to report"),
      meterValues: z
        .boolean()
        .optional()
        .describe(
          "Attach the connector's current sampled values (MeterValuesSampledData) to the event",
        ),
      context: z
        .enum(METER_READING_CONTEXTS)
        .optional()
        .describe(
          "sampledValue.context for attached meter values; default Sample.Periodic",
        ),
    }),
    result: ANY,
  },
  authorize: {
    params: z.object({
      tagId: NON_EMPTY_STR.optional(),
      idTokenType: z
        .enum(ID_TOKEN_TYPES)
        .optional()
        .describe(
          "OCPP 2.x IdToken.type of the Authorize.req; default ISO14443 (#599). Ignored on OCPP 1.6",
        ),
    }),
    result: ANY,
  },
  // #348: station-initiated DataTransfer.req. The result is the CSMS's
  // answer, `{ status, data? }`. `data` is a string or an object: a string
  // goes on the wire as-is on every version; an object is passed through on
  // 2.0.1 and JSON-encoded on 1.6 (whose `data` is a string).
  data_transfer: {
    params: z.object({
      vendorId: NON_EMPTY_STR,
      messageId: NON_EMPTY_STR.optional(),
      data: dataTransferDataSchema.optional(),
    }),
    result: ANY,
  },
  // #389: expert OCPP call — any station-initiated CALL of the station's
  // OCPP-J version, payload as given. A CALLERROR is a result, not an error;
  // refusals (unsupported action/transport, schema-invalid payload without
  // skipValidation, boot gate) are invalid_params.
  send_ocpp_call: {
    params: z.object({
      action: NON_EMPTY_STR.describe(
        "Station-initiated OCPP action, e.g. Heartbeat or StatusNotification",
      ),
      payload: OBJ()
        .optional()
        .describe(
          "The CALL payload, sent as given; left out, the schema-valid default payload of the action (#1097)",
        ),
      skipValidation: z
        .boolean()
        .optional()
        .describe(
          "Send even if the payload fails the outgoing OCPP schema check (this call only)",
        ),
      applyResponse: z
        .boolean()
        .optional()
        .describe(
          "Also apply the CSMS's answer to the station's state (default: only log and return it)",
        ),
    }),
    result: ocppCallOutcomeSchema,
  },
  // #1096: OCPP 2.1 SEND (RPC message type 6, Part 2 FR.07): an unconfirmed
  // station-initiated message, today NotifyPeriodicEventStream. The CSMS never
  // answers, so the result is the frame that went out. Refusals (not a 2.1
  // station, not a SEND action, schema-invalid payload without skipValidation,
  // closed socket) are invalid_params.
  send_ocpp_send: {
    params: z.object({
      action: NON_EMPTY_STR.describe(
        "Station-initiated SEND action; OCPP 2.1: NotifyPeriodicEventStream",
      ),
      payload: OBJ()
        .optional()
        .describe(
          "The message payload, sent as given; left out, the schema-valid default payload of the action",
        ),
      skipValidation: z
        .boolean()
        .optional()
        .describe(
          "Send even if the payload fails the outgoing OCPP schema check (this message only)",
        ),
    }),
    result: z.object({ messageId: z.string(), sentFrame: z.string() }),
  },
  // #393: expert raw frame (level C of #389): one text frame written to the
  // WebSocket as given, valid OCPP-J or not. SOAP stations and a closed
  // socket are refused (invalid_params); no reply is a result, not an error.
  send_raw_frame: {
    params: z.object({
      frame: z
        .string()
        .describe(
          "The text frame, written as given (e.g. a wrong message type, a missing element, invalid JSON)",
        ),
      waitMs: z
        .number()
        .int()
        .min(0)
        .max(25_000)
        .optional()
        .describe(
          "How long to wait for a reply, in milliseconds (default 5000)",
        ),
      collectMs: z
        .number()
        .int()
        .min(0)
        .max(25_000)
        .optional()
        .describe(
          "After the first reply keep listening this long (within waitMs) so duplicate replies to the same id are returned in `replies` (default 0: return at the first reply)",
        ),
    }),
    result: rawFrameOutcomeSchema,
  },
  // #1090: block until something happens on this charge point. Either a CLI
  // event (`event`, optionally narrowed by `match`: every key must equal the
  // event data's) or a scenario state (`scenario`). A condition that already
  // holds when the command arrives answers at once for `scenario`; an `event`
  // is only matched by events that arrive after the command. A timeout is a
  // result (`timedOut: true`), not an error.
  wait_for: {
    params: z
      .object({
        event: NON_EMPTY_STR.optional().describe(
          "CLI event name to wait for, e.g. connector_status, boot_notification, scenario_state_changed",
        ),
        match: OBJ()
          .optional()
          .describe(
            "With `event`: keys the event's data must carry with these values (shallow, deep-equal per key)",
          ),
        scenario: z
          .object({
            connector: CONN_POS,
            scenarioId: NON_EMPTY_STR,
            state: NON_EMPTY_STR.describe(
              "Execution state to wait for: idle, running, waiting, paused, completed, error, ...",
            ),
          })
          .optional()
          .describe(
            "Wait until the scenario's state is this one (checked now, then on every scenario_state_changed)",
          ),
        timeoutMs: z
          .number()
          .int()
          .min(1)
          .max(25_000)
          .optional()
          .describe(
            "Give up after this many milliseconds (default 20000, at most 25000: an RPC is answered within 30 s, so repeat the wait for longer)",
          ),
      })
      .refine((v) => (v.event !== undefined) !== (v.scenario !== undefined), {
        message: "wait_for needs exactly one of event or scenario",
      })
      .refine((v) => v.match === undefined || v.event !== undefined, {
        message: "match needs event",
      }),
    result: z.object({
      matched: z.boolean(),
      timedOut: z.boolean(),
      event: z.string().optional(),
      data: z.unknown().optional(),
      timestamp: z.string().optional(),
      scenarioStatus: z.unknown().optional(),
    }),
  },
  // #1091: resolve when the wire is quiet: every CALL the station sent has
  // been answered and no frame crossed the socket for `quietMs`. `quiet:
  // false` (with `reason`) when `timeoutMs` passes first, the link is down, or
  // the station runs on a virtual clock.
  wait_quiet: {
    params: z.object({
      quietMs: z
        .number()
        .int()
        .min(1)
        .max(60_000)
        .optional()
        .describe("No frame for this long counts as quiet (default 250)"),
      timeoutMs: z
        .number()
        .int()
        .min(1)
        .max(25_000)
        .optional()
        .describe(
          "Give up after this many milliseconds (default 10000, at most 25000)",
        ),
    }),
    result: z.object({
      quiet: z.boolean(),
      reason: z.enum(["quiet", "timeout", "offline", "virtual_clock"]),
      outstandingCalls: z.number().int(),
    }),
  },
  // #1090: control what the station answers a CSMS CALL with. A test arms an
  // override for an action; the next `times` CALLs of it (default 1), or every
  // one with `persistent`, get that answer instead of the engine's. Armed
  // overrides are answered before the station's own handlers, so any of them
  // can own a malformed CALL. `mode` picks the answer; the fields each mode
  // needs are checked when it is armed (invalid_params).
  set_response_override: {
    params: z.object({
      action: NON_EMPTY_STR.describe(
        "CSMS-initiated action, in the 1.6 or the 2.x spelling, e.g. Reset or RequestStartTransaction",
      ),
      mode: z
        .enum([
          "status",
          "callError",
          "callResult",
          "raw",
          "callResultError",
          "delay",
          "noAnswer",
        ])
        .describe(
          "status: CALLRESULT { status }; callError: CALLERROR errorCode/errorDescription/errorDetails; callResult: CALLRESULT with `payload` as given (schema-valid or not); raw: `frame` written as given; callResultError: an OCPP 2.1 CALLRESULTERROR frame (type 5) with the CALL's id; delay: the normal answer, `delayMs` late; noAnswer: never answer",
        ),
      status: NON_EMPTY_STR.optional().describe("Mode status"),
      errorCode: NON_EMPTY_STR.optional().describe(
        "Modes callError and callResultError; any string, e.g. NotSupported, InternalError, FormatViolation",
      ),
      errorDescription: STR_64K.optional().describe(
        "Modes callError and callResultError (default empty)",
      ),
      errorDetails: OBJ()
        .optional()
        .describe("Modes callError and callResultError (default {})"),
      payload: z
        .unknown()
        .optional()
        .describe(
          "Mode callResult: the CALLRESULT payload, any JSON value, written as given",
        ),
      frame: STR_64K.optional().describe(
        "Mode raw: the text frame written instead of an answer (use the CALL's message id yourself)",
      ),
      delayMs: z
        .number()
        .int()
        .min(0)
        .max(25_000)
        .optional()
        .describe(
          "Mode delay: how late the normal answer is written; any other mode but noAnswer: how long the answer is held back",
        ),
      times: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("How many CALLs of the action get this answer (default 1)"),
      persistent: z
        .boolean()
        .optional()
        .describe(
          "Answer every CALL of the action until clear_response_overrides (or a reset); overrides times",
        ),
    }),
    result: z.object({ action: NON_EMPTY_STR, mode: NON_EMPTY_STR }),
  },
  clear_response_overrides: {
    params: z.object({
      action: NON_EMPTY_STR.optional().describe(
        "Only the override armed for this action; default all of them",
      ),
    }),
    result: z.object({ cleared: z.number().int() }),
  },
  // #1090: OCPP 2.1 CALLRESULTERROR (RPC message type 5): the station's
  // answer to a CALLRESULT it cannot accept. OCPP 2.1 stations only.
  send_call_result_error: {
    params: z.object({
      messageId: NON_EMPTY_STR.describe(
        "Id of the CALL the CSMS answered (a send_ocpp_call result carries it)",
      ),
      errorCode: NON_EMPTY_STR.optional().describe(
        "Default FormatViolation; any string is sent",
      ),
      errorDescription: STR_64K.optional().describe("Default empty"),
      errorDetails: OBJ().optional().describe("Default {}"),
    }),
    result: z.object({ sentFrame: z.string(), messageId: z.string() }),
  },
  // #452: the charge point's Authorization Cache, a test seam. Seed and
  // clear act whatever AuthorizationCacheEnabled / AuthCacheCtrlr.Enabled
  // says (get reports the switch); nothing goes on the wire.
  get_auth_cache: {
    params: EMPTY,
    result: authorizationCacheViewSchema,
  },
  seed_auth_cache: {
    params: z.object({ entries: authorizationCacheSeedSchema }),
    result: z.object({ seeded: z.number().int() }),
  },
  clear_auth_cache: {
    params: EMPTY,
    result: z.object({ cleared: z.boolean() }),
  },

  // -- status notifications --
  diagnostics_status_notification: {
    // The four 1.6 statuses (#377); 2.0.1 has no such message.
    params: z.object({ status: z.enum(DIAGNOSTICS_STATUSES) }),
    result: ANY,
  },
  firmware_status_notification: {
    // #345: `requestId` names the UpdateFirmware the report belongs to
    // (2.0.1 only; 1.6's request has no such field). Omitted on 2.0.1, the
    // station uses the requestId of the UpdateFirmware it last accepted.
    params: z.object({
      // The 2.0.1 FirmwareStatusEnumType, of which the seven 1.6 statuses
      // are the first members; a 2.0.1-only status on a 1.6 wire is sent as
      // given and the codec's outgoing check warns.
      status: z.enum(FIRMWARE_STATUSES),
      requestId: z.number().int().nonnegative().optional(),
    }),
    result: ANY,
  },
  // #345: LogStatusNotification.req (1.6 Security Whitepaper / 2.0.1 N01).
  // `requestId` as above, defaulting to the GetLog last accepted on 2.0.1.
  log_status_notification: {
    params: z.object({
      status: z.enum(UPLOAD_LOG_STATUSES),
      requestId: z.number().int().nonnegative().optional(),
    }),
    result: ANY,
  },
  security_event_notification: {
    // SecurityEventNotification: type string[0..50], techInfo
    // string[0..255] (1.6 whitepaper, 2.0.1, 2.1).
    params: z.object({
      type: NON_EMPTY_STR.max(50),
      techInfo: NON_EMPTY_STR.max(255).optional(),
    }),
    result: ANY,
  },
  sign_certificate: {
    // SignCertificateRequest.csr is string[0..5500] (1.6, 2.0.1, 2.1).
    params: z.object({ csr: NON_EMPTY_STR.max(5500).optional() }),
    result: ANY,
  },
  // #537: 2.0.1 / 2.1 Get15118EVCertificate (M01 / M02). The caller stands
  // in for the EV: the station relays the EXI request and the result is the
  // CSMS's answers. Bounds are 2.1's; a 2.0.1 station refuses what its own
  // schema does not admit (the 2.1 fields, exiRequest over 5600).
  get_15118_ev_certificate: {
    params: z.object({
      iso15118SchemaVersion: NON_EMPTY_STR.max(50).describe(
        "ISO 15118 schema version of the EV session, e.g. urn:iso:15118:2:2013:MsgDef",
      ),
      action: z.enum(["Install", "Update"]),
      exiRequest: BASE64_STR.max(11000).describe(
        "The EV's CertificateInstallationReq / CertificateUpdateReq, EXI, base64",
      ),
      maximumContractCertificateChains: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "OCPP 2.1, ISO 15118-20 sessions only; the station then repeats the request while remainingContracts > 0",
        ),
      prioritizedEMAIDs: z
        .array(NON_EMPTY_STR.max(255))
        .min(1)
        .max(8)
        .optional()
        .describe("OCPP 2.1, ISO 15118-20 sessions only"),
    }),
    result: get15118EVCertificateResultSchema,
  },

  // -- connector --
  update_connector_status: {
    params: z.object({
      connector: CONN_NONNEG,
      // #383: the vocabulary is the schema's to enforce. A value outside it
      // used to pass here and fail in the handler, answering `internal`.
      status: z.enum(OCPPStatus),
      errorCode: STR_64K.optional(),
      info: STR_64K.optional(),
      vendorErrorCode: STR_64K.optional(),
      vendorId: STR_64K.optional(),
      // Anything `Date` can read, as before; the handler passes it on as one.
      timestamp: STR_64K.refine((v) => !Number.isNaN(Date.parse(v)), {
        message: "timestamp must be a date string",
      }).optional(),
      suppressChargingStateTransactionEvent: z.boolean().optional(),
      // #618: send the StatusNotification even when the capability profile
      // enforces the OCPP 1.6 §4.9 transition table and this change is not
      // in it. Applies to the normal path only: with any StatusNotification
      // field above the message is sent raw and no transition is checked.
      allowInvalidTransition: z.boolean().optional(),
    }),
    result: ANY,
  },
  // #488: the EV side of the cable was unplugged. With a running
  // transaction StopTransactionOnEVSideDisconnect stops or suspends it.
  ev_disconnected: {
    params: z.object({ connector: CONN_POS }),
    result: ANY,
  },
  // #453: a cable was plugged into the EV side. An idle Available connector
  // reports Preparing; a transaction suspended by an EV-side disconnect
  // resumes Charging (#846); any other state is unchanged. Idempotent.
  ev_plug_in: {
    params: z.object({ connector: CONN_POS }),
    result: ANY,
  },
  // #453: the EV asks for energy or stops asking. With a running transaction
  // "not ready" suspends it (SuspendedEV), "ready" resumes Charging. Needs a
  // plugged-in cable.
  ev_ready: {
    params: z.object({ connector: CONN_POS, ready: z.boolean() }),
    result: ANY,
  },
  set_meter_value: {
    params: z.object({ connector: CONN_POS, value: z.number().int().min(0) }),
    result: ANY,
  },
  send_meter_value: {
    params: z.object({
      connector: CONN_POS,
      // #335: the ReadingContext the sampled values carry; default Sample.Periodic.
      context: z.enum(METER_READING_CONTEXTS).optional(),
    }),
    result: ANY,
  },
  remove_connector: { params: z.object({ connector: CONN_POS }), result: ANY },
  set_ev_settings: {
    params: z.object({ connector: CONN_POS, settings: OBJ() }),
    result: ANY,
  },
  get_ev_settings: { params: z.object({ connector: CONN_POS }), result: ANY },
  set_auto_meter_config: {
    params: z.object({ connector: CONN_POS, config: OBJ() }),
    result: ANY,
  },
  get_auto_meter_config: {
    params: z.object({ connector: CONN_POS }),
    result: ANY,
  },
  set_auto_traffic_config: {
    params: z.object({ connector: CONN_POS, config: OBJ() }),
    result: ANY,
  },
  get_auto_traffic_config: {
    params: z.object({ connector: CONN_POS }),
    result: ANY,
  },
  set_auto_reset_to_available: {
    params: z.object({ connector: CONN_POS, enabled: z.boolean() }),
    result: ANY,
  },
  set_mode: {
    params: z.object({ connector: CONN_POS, mode: z.enum(SCENARIO_MODES) }),
    result: ANY,
  },
  set_soc: {
    params: z.object({ connector: CONN_POS, soc: z.number().nullable() }),
    result: ANY,
  },
  set_soc_meter_sync: {
    params: z.object({ connector: CONN_POS, enabled: z.boolean() }),
    result: ANY,
  },
  get_charging_profiles: {
    params: z.object({ connector: CONN_POS }),
    result: ANY,
  },

  // -- history --
  get_state_history: {
    params: z.object({ options: OBJ().optional() }),
    result: ANY,
  },
} satisfies Record<string, { params: z.ZodTypeAny; result: z.ZodTypeAny }>;
