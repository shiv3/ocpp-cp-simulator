---
title: Device Model registry
type: entity
summary: The typed registry of the OCPP 2.x components and variables a simulated station has — mutability, data type, values list, limits, default, persistence — that GetVariables, SetVariables, variable monitoring and GetBaseReport resolve through.
sources:
  - packages/core/src/cp/domain/device-model/DeviceModelRegistry.ts
  - packages/core/src/cp/infrastructure/transport/v201/deviceModelMap.ts
  - packages/core/src/cp/domain/charge-point/ConfigurationStore.ts
  - "issue #604"
  - "issue #569"
related:
  - ../concepts/variable-monitoring.md
  - ../concepts/local-authorization.md
  - default-behaviors.md
  - ../sources/github-issues.md
updated: 2026-11-08
---

# Device Model registry

The registry is the one place that says which OCPP 2.0.1 / 2.1 components and
variables the simulator has and what each is (#604, part of the #569 remote
configuration epic). It is data plus lookups, in
[`DeviceModelRegistry.ts`](../../packages/core/src/cp/domain/device-model/DeviceModelRegistry.ts);
`DEVICE_MODEL` is the instance the handlers use. The values stay in the
`ConfigurationStore`: a variable shared with a 1.6 key reads and writes the
same store entry as `GetConfiguration` / `ChangeConfiguration`, so there is
one value, one validation and one persistence path.

## Who uses it

| Consumer                         | Uses                                                                                                                                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GetVariables` / `SetVariables`  | `resolveDeviceModelVariable` ([`deviceModelMap.ts`](../../packages/core/src/cp/infrastructure/transport/v201/deviceModelMap.ts)) → store key; unknown names answer `UnknownComponent` / `UnknownVariable` |
| `SetVariableMonitoring`          | the same resolution, so monitors keep working on every registered variable ([Variable monitoring](../concepts/variable-monitoring.md#the-device-model-behind-a-monitor))                                  |
| `GetBaseReport` / `NotifyReport` | mutability, `dataType`, `valuesList`, `minLimit` / `maxLimit` and `unit` of each reported variable come from the entry; only variables the store has a value for are listed                               |
| `ChargePoint`                    | publishes the registry's constants as read-only runtime keys at start (2.x only)                                                                                                                          |

## Entry fields

| Field                                          | Meaning                                                                                                                                              |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `component`, `variable`, `instance`            | The Device Model name. An instanced variable is only found with its instance.                                                                        |
| `valueKey`                                     | The `ConfigurationStore` key. For `EVSE` / `Connector` variables, the prefix of the per-EVSE key.                                                    |
| `sharedWith16`                                 | `valueKey` is also a 1.6 configuration key.                                                                                                          |
| `mutability`                                   | `ReadOnly`, `ReadWrite` or `WriteOnly`.                                                                                                              |
| `dataType`, `valuesList`, `min`, `max`, `unit` | What the variable holds and what `SetVariables` accepts; reported in `variableCharacteristics`.                                                      |
| `default`                                      | The value of a fresh station (also what a constant publishes).                                                                                       |
| `persistence`                                  | `Persistent`: a configuration key, saved to the state database when one is configured. `Volatile`: made at runtime, never stored, always `ReadOnly`. |
| `effect`                                       | Required for a writable variable: the simulated behavior that follows from changing it.                                                              |
| `constant`                                     | A fixed value the station publishes because nothing else defines it.                                                                                 |

## The #569 rule

A variable without simulated behavior is `ReadOnly` or not registered; it is
never writable ("configuration acceptance implies implemented behavior").
`createDeviceModelRegistry` enforces it structurally: a writable entry without
`effect`, a writable `Volatile` entry, a duplicate id or `valueKey`, an
unknown component, bounds on a non-numeric type, and a default outside its
bounds or `valuesList` all throw when the registry is built, and a test pins
every entry to the `ConfigurationStore` definition it maps onto (read-only
flag, type, bounds, allowed values, default, 1.6 sharing).

`TxCtrlr.TxStartPoint` and `TxStopPoint` are registered `ReadOnly`: the
simulator starts a transaction on authorization and ends it on deauthorization,
EV disconnect or connection timeout, and their values (`Authorized`,
`Authorized,EVConnected`) describe that (`TxStopPoint` reads
`Authorized,EVConnected` while `StopTxOnEVSideDisconnect` is true, its default,
because that variable is writable). Making them `ReadWrite` belongs with
the follow-up that makes transaction timing follow them; writable earlier they
would accept a value that changes nothing.

`OCPPCommCtrlr.ResetRetries` is `ReadOnly` on 2.x although OCPP 1.6 §9.1 lists
the key read-write: the simulated reset never fails, so nothing retries, and a
writable value would change nothing. The 1.6 key stays read-write; on 2.x
`defaultConfiguration` marks the store key read-only to match.

A `MemberList` variable, like an `OptionList` one, carries a `valuesList`
(mandatory in `VariableCharacteristicsType` for `OptionList`, `MemberList` and
`SequenceList`); the registry refuses one without it and refuses it on any other
type. The measurand variables list the measurands `MeterValueBuilder` models;
the store does not enforce the list.

## Components

`OCPPCommCtrlr`, `TxCtrlr`, `SampledDataCtrlr`, `AlignedDataCtrlr`,
`LocalAuthListCtrlr`, `AuthCtrlr`, `AuthCacheCtrlr`, `MonitoringCtrlr`,
`ChargingStation`, `SecurityCtrlr`, and the EVSE-scoped `EVSE` and `Connector`
(which need `component.evse`). `ClockCtrlr`, `DeviceDataCtrlr`,
`TariffCostCtrlr` and `ISO15118Ctrlr` exist with no variable yet: a request for
one of their variables answers `UnknownVariable`, not `UnknownComponent`.

## Variables

| Variable                                                   | Store key                                 | Mutability | Data type  | Limits                                                 | Default                                           | Persistence |
| ---------------------------------------------------------- | ----------------------------------------- | ---------- | ---------- | ------------------------------------------------------ | ------------------------------------------------- | ----------- |
| `OCPPCommCtrlr.HeartbeatInterval`                          | `HeartbeatInterval` (1.6)                 | ReadWrite  | integer    | –                                                      | 300                                               | Persistent  |
| `OCPPCommCtrlr.WebSocketPingInterval`                      | `WebSocketPingInterval` (1.6)             | ReadWrite  | integer    | min 0, max 2147483                                     | 0                                                 | Persistent  |
| `OCPPCommCtrlr.ResetRetries`                               | `ResetRetries` (1.6)                      | ReadOnly   | integer    | –                                                      | 1                                                 | Persistent  |
| `OCPPCommCtrlr.MessageAttempts[TransactionEvent]`          | `TransactionMessageAttempts` (1.6)        | ReadWrite  | integer    | –                                                      | 3                                                 | Persistent  |
| `OCPPCommCtrlr.MessageAttemptInterval[TransactionEvent]`   | `TransactionMessageRetryInterval` (1.6)   | ReadWrite  | integer    | –                                                      | 60                                                | Persistent  |
| `OCPPCommCtrlr.MessageTimeout[Default]`                    | `MessageTimeout`                          | ReadOnly   | integer    | min 1                                                  | 30                                                | Persistent  |
| `TxCtrlr.EVConnectionTimeOut`                              | `ConnectionTimeOut` (1.6)                 | ReadWrite  | integer    | –                                                      | 60                                                | Persistent  |
| `SampledDataCtrlr.TxUpdatedInterval`                       | `MeterValueSampleInterval` (1.6)          | ReadWrite  | integer    | –                                                      | 60                                                | Persistent  |
| `SampledDataCtrlr.TxUpdatedMeasurands`                     | `MeterValuesSampledData` (1.6)            | ReadWrite  | MemberList | the measurands of `MeterValueBuilder`                  | Energy.Active.Import.Register,Power.Active.Import | Persistent  |
| `SampledDataCtrlr.SignReadings`                            | `SampledDataSignReadings` (1.6)           | ReadWrite  | boolean    | –                                                      | false                                             | Persistent  |
| `AlignedDataCtrlr.Interval`                                | `ClockAlignedDataInterval` (1.6)          | ReadWrite  | integer    | min 0, max 86400                                       | 0                                                 | Persistent  |
| `AlignedDataCtrlr.Measurands`                              | `MeterValuesAlignedData` (1.6)            | ReadWrite  | MemberList | the measurands of `MeterValueBuilder`                  | (empty)                                           | Persistent  |
| `LocalAuthListCtrlr.Enabled`                               | `LocalAuthListEnabled` (1.6)              | ReadWrite  | boolean    | –                                                      | true                                              | Persistent  |
| `LocalAuthListCtrlr.ItemsPerMessage`                       | `SendLocalListMaxLength` (1.6)            | ReadOnly   | integer    | –                                                      | 100                                               | Persistent  |
| `AuthCtrlr.AuthorizeRemoteStart`                           | `AuthorizeRemoteTxRequests` (1.6)         | ReadOnly   | boolean    | –                                                      | false                                             | Persistent  |
| `AuthCtrlr.LocalPreAuthorize`                              | `LocalPreAuthorize` (1.6)                 | ReadWrite  | boolean    | –                                                      | false                                             | Persistent  |
| `AuthCtrlr.LocalAuthorizeOffline`                          | `LocalAuthorizeOffline` (1.6)             | ReadWrite  | boolean    | –                                                      | true                                              | Persistent  |
| `AuthCtrlr.OfflineTxForUnknownIdEnabled`                   | `AllowOfflineTxForUnknownId` (1.6)        | ReadWrite  | boolean    | –                                                      | false                                             | Persistent  |
| `AuthCacheCtrlr.Enabled`                                   | `AuthorizationCacheEnabled` (1.6)         | ReadWrite  | boolean    | –                                                      | false                                             | Persistent  |
| `AuthCacheCtrlr.LifeTime`                                  | `AuthCacheLifeTime`                       | ReadWrite  | integer    | min 0                                                  | 0                                                 | Persistent  |
| `TxCtrlr.StopTxOnInvalidId`                                | `StopTransactionOnInvalidId` (1.6)        | ReadWrite  | boolean    | –                                                      | true                                              | Persistent  |
| `TxCtrlr.StopTxOnEVSideDisconnect`                         | `StopTransactionOnEVSideDisconnect` (1.6) | ReadWrite  | boolean    | –                                                      | true                                              | Persistent  |
| `TxCtrlr.TxStartPoint`                                     | `TxStartPoint`                            | ReadOnly   | MemberList | Authorized                                             | Authorized                                        | Volatile    |
| `TxCtrlr.TxStopPoint`                                      | `TxStopPoint`                             | ReadOnly   | MemberList | Authorized, EVConnected                                | Authorized,EVConnected                            | Volatile    |
| `MonitoringCtrlr.ItemsPerMessage[SetVariableMonitoring]`   | `ItemsPerMessageSetVariableMonitoring`    | ReadOnly   | integer    | –                                                      | 100                                               | Volatile    |
| `MonitoringCtrlr.BytesPerMessage[SetVariableMonitoring]`   | `BytesPerMessageSetVariableMonitoring`    | ReadOnly   | integer    | –                                                      | 65536                                             | Volatile    |
| `MonitoringCtrlr.ItemsPerMessage[ClearVariableMonitoring]` | `ItemsPerMessageClearVariableMonitoring`  | ReadOnly   | integer    | –                                                      | 100                                               | Volatile    |
| `MonitoringCtrlr.BytesPerMessage[ClearVariableMonitoring]` | `BytesPerMessageClearVariableMonitoring`  | ReadOnly   | integer    | –                                                      | 65536                                             | Volatile    |
| `MonitoringCtrlr.ActiveMonitoringLevel`                    | `ActiveMonitoringLevel`                   | ReadOnly   | integer    | min 0, max 9                                           | runtime                                           | Volatile    |
| `MonitoringCtrlr.ActiveMonitoringBase`                     | `ActiveMonitoringBase`                    | ReadOnly   | OptionList | one of All/FactoryDefault/HardWiredOnly                | runtime                                           | Volatile    |
| `MonitoringCtrlr.OfflineQueuingSeverity`                   | `OfflineQueuingSeverity`                  | ReadWrite  | integer    | min 0, max 9                                           | 0                                                 | Persistent  |
| `ChargingStation.AvailabilityState`                        | `ChargingStationAvailabilityState`        | ReadOnly   | OptionList | one of Available/Occupied/Reserved/Unavailable/Faulted | runtime                                           | Volatile    |
| `SecurityCtrlr.CertificateEntries`                         | `CertificateEntries`                      | ReadOnly   | integer    | min 0                                                  | 0                                                 | Persistent  |
| `SecurityCtrlr.MaxCertificateChainSize`                    | `MaxCertificateChainSize`                 | ReadOnly   | integer    | min 1, max 10000                                       | 10000                                             | Persistent  |
| `SecurityCtrlr.CertSigningWaitMinimum`                     | `CertSigningWaitMinimum`                  | ReadWrite  | integer    | min 1                                                  | 60                                                | Persistent  |
| `SecurityCtrlr.CertSigningRepeatTimes`                     | `CertSigningRepeatTimes`                  | ReadWrite  | integer    | min 0                                                  | 3                                                 | Persistent  |
| `EVSE.Power`                                               | `EVSEPower`                               | ReadOnly   | decimal    | unit W                                                 | runtime                                           | Volatile    |
| `EVSE.AvailabilityState`                                   | `EVSEAvailabilityState`                   | ReadOnly   | OptionList | one of Available/Occupied/Reserved/Unavailable/Faulted | runtime                                           | Volatile    |
| `Connector.AvailabilityState`                              | `ConnectorAvailabilityState`              | ReadOnly   | OptionList | one of Available/Occupied/Reserved/Unavailable/Faulted | runtime                                           | Volatile    |

## Adding a variable

Add the value to the store first (a configuration key in `Configuration.ts`,
or a runtime key a service publishes), then one entry to `VARIABLES` in the
registry. Give a writable entry its `effect` and make sure the behavior
exists; otherwise register it `ReadOnly`. The registry test then checks the
entry against the store.
