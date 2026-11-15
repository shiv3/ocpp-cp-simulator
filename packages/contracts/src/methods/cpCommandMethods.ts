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
          "OCPP 2.x TransactionEvent(Started) chargingState; default Charging",
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
      payload: OBJ().describe("The CALL payload, sent as given"),
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
    }),
    result: rawFrameOutcomeSchema,
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
