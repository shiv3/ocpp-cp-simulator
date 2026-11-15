// Device Model variable table (#604), split out of DeviceModelRegistry.ts
// (#877): AuthCtrlr, AuthCacheCtrlr, ReservationCtrlr and TxCtrlr event variables.
import type { DeviceModelVariableDef } from "./DeviceModelRegistry";
import { persistent } from "./deviceModelVariableHelpers";

export const AUTH_AND_TRANSACTION_VARIABLES: readonly DeviceModelVariableDef[] =
  [
    // §2.3.4 leaves the mutability to the station; both values are implemented
    // (F01.FR.01/02, #762), so it is writable (#921). `ReadWrite` is the
    // default; a station can make it ReadOnly with the custom key
    // `AuthorizeRemoteTxRequestsReadOnly` (#922), see `effectiveMutability`.
    persistent(
      "AuthCtrlr",
      "AuthorizeRemoteStart",
      "AuthorizeRemoteTxRequests",
      {
        mutability: "ReadWrite",
        dataType: "boolean",
        default: false,
        effect:
          "A remote start is authorized like a local one before it starts (F01.FR.01).",
      },
    ),
    // #452: local authorization (2.0.1 Part 2 §2.3-§2.4, C10-C15).
    persistent("AuthCtrlr", "LocalPreAuthorize", "LocalPreAuthorize", {
      mutability: "ReadWrite",
      dataType: "boolean",
      default: false,
      effect: "An id is started on a local decision before the CSMS answers.",
    }),
    persistent("AuthCtrlr", "LocalAuthorizeOffline", "LocalAuthorizeOffline", {
      mutability: "ReadWrite",
      dataType: "boolean",
      default: true,
      effect: "An offline station authorizes from the local list and cache.",
    }),
    persistent(
      "AuthCtrlr",
      "OfflineTxForUnknownIdEnabled",
      "AllowOfflineTxForUnknownId",
      {
        mutability: "ReadWrite",
        dataType: "boolean",
        default: false,
        effect: "An offline station starts a transaction for an unknown id.",
      },
    ),
    // #598: C12.FR.09; "" = no master pass. 2.x only.
    persistent("AuthCtrlr", "MasterPassGroupId", "MasterPassGroupId", {
      sharedWith16: false,
      mutability: "ReadWrite",
      dataType: "string",
      default: "",
      effect:
        "A RequestStartTransaction whose groupIdToken is this group is refused.",
    }),
    persistent("AuthCacheCtrlr", "Enabled", "AuthorizationCacheEnabled", {
      mutability: "ReadWrite",
      dataType: "boolean",
      default: false,
      effect: "The authorization cache is used or not.",
    }),
    persistent("AuthCacheCtrlr", "LifeTime", "AuthCacheLifeTime", {
      sharedWith16: false,
      mutability: "ReadWrite",
      dataType: "integer",
      min: 0,
      default: 0,
      effect: "Seconds a cached authorization stays valid.",
    }),
    persistent("TxCtrlr", "StopTxOnInvalidId", "StopTransactionOnInvalidId", {
      mutability: "ReadWrite",
      dataType: "boolean",
      default: true,
      effect: "A transaction stops when its id is invalidated.",
    }),
    persistent("TxCtrlr", "MaxEnergyOnInvalidId", "MaxEnergyOnInvalidId", {
      mutability: "ReadWrite",
      dataType: "integer",
      unit: "Wh",
      default: 0,
      effect:
        "Wh still delivered after the id of a transaction is invalidated.",
    }),
    // #709: H01.FR.18/19, the 2.x name of 1.6 ReserveConnectorZeroSupported.
    persistent(
      "ReservationCtrlr",
      "NonEvseSpecific",
      "ReserveConnectorZeroSupported",
      {
        mutability: "ReadOnly",
        dataType: "boolean",
        default: false,
      },
    ),
    persistent(
      "TxCtrlr",
      "StopTxOnEVSideDisconnect",
      "StopTransactionOnEVSideDisconnect",
      {
        mutability: "ReadWrite",
        dataType: "boolean",
        default: true,
        effect: "A transaction stops when the EV unplugs.",
      },
    ),
    // #697: the events that start and end a transaction. Only the member sets
    // below drive the simulated timing; any other set is Rejected (#569). The
    // defaults reproduce the timing before they were writable.
    persistent("TxCtrlr", "TxStartPoint", "TxStartPoint", {
      sharedWith16: false,
      mutability: "ReadWrite",
      dataType: "MemberList",
      valuesList: ["Authorized", "EVConnected"],
      allowedLists: [
        ["Authorized"],
        ["EVConnected"],
        ["Authorized", "EVConnected"],
      ],
      default: ["Authorized"],
      effect:
        "EVConnected starts the transaction at the cable plug-in (Started, CablePluggedIn); the authorization is then an Updated event.",
    }),
    persistent("TxCtrlr", "TxStopPoint", "TxStopPoint", {
      sharedWith16: false,
      mutability: "ReadWrite",
      dataType: "MemberList",
      valuesList: ["Authorized", "EVConnected"],
      allowedLists: [["Authorized", "EVConnected"], ["EVConnected"]],
      default: ["Authorized", "EVConnected"],
      effect:
        "Without Authorized, a remote stop, a deauthorization or a tag stop gives an Updated event and the transaction ends at the cable unplug.",
    }),
  ];
