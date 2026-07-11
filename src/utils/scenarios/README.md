# Certification Scenario Templates

These built-in JSON templates implement the Charge Point side of OCPP 1.6 certification test cases. Each scenario encodes a specific flow or condition described in the OCPPSC test-case spec. To run a scenario:

1. Open the Scenario Editor in the web console.
2. Select one of the cert16-* scenarios from the dropdown.
3. Connect a real CSMS (or a test harness like GOCPP) to the simulator.
4. Click **Play** to execute the scenario.
5. Follow the CSMS-side operator actions listed below to complete the test case.

## Scenario Mapping

| Scenario ID                           | TC       | Title                                   | Profile       | CSMS-Side Operator Action                                                                                                                           |
| ------------------------------------- | -------- | --------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| cert16-tc001-cold-boot                | TC_001   | Cold Boot                               | Core          | Verify BootNotification and StatusNotification are sent automatically on connection.                                                                |
| cert16-tc003-charging-plugin-first    | TC_003   | Charging Session (Plug-In First)        | Core          | Provide idTag after the cable is plugged in. Accept StartTransaction. Verify MeterValue samples and StopTransaction.                                |
| cert16-tc004-charging-id-first        | TC_004   | Charging Session (Identification First) | Core          | Provide idTag before the cable is plugged in. Accept StartTransaction. Verify MeterValue samples and StopTransaction.                               |
| cert16-tc005-ev-side-disconnect       | TC_005   | EV Side Disconnected                    | Core          | Initiate the EV-side disconnect (plugout) during charging. Verify StopTransaction with EVDisconnected reason.                                       |
| cert16-tc010-remote-start             | TC_010   | Remote Start Transaction                | RemoteTrigger | Send RemoteStartTransaction.req. Accept the response. Verify StatusNotification(Preparing) and StartTransaction.                                    |
| cert16-tc011-remote-start-stop        | TC_011   | Remote Start + Remote Stop Transaction  | RemoteTrigger | Send RemoteStartTransaction.req, accept. Send RemoteStopTransaction.req during charging. Verify StopTransaction and StatusNotification sequence.    |
| cert16-tc012-remote-stop              | TC_012   | Remote Stop Transaction                 | RemoteTrigger | Verify a charging session in progress. Send RemoteStopTransaction.req. Accept the response. Verify StopTransaction.                                 |
| cert16-tc013-hard-reset               | TC_013   | Hard Reset                              | Core          | Send Reset(type=Hard) during charging. Verify StopTransaction with HardReset reason and CP reboot.                                                  |
| cert16-tc014-soft-reset               | TC_014   | Soft Reset                              | Core          | Send Reset(type=Soft) during charging. Verify StopTransaction with SoftReset reason and CP reboot.                                                  |
| cert16-tc017-unlock-occupied          | TC_017   | Unlock Connector (Occupied, Succeeds)   | Core          | Verify a charging session in progress. Send UnlockConnector.req. Accept the response. Verify the session completes normally.                        |
| cert16-tc018-unlock-failure           | TC_018   | Unlock Connector (Failure)              | Core          | Verify a charging session in progress. Send UnlockConnector.req. Accept the failure (UnlockFailed) response. Verify the session completes normally. |
| cert16-tc019-get-configuration-all    | TC_019_1 | Retrieve All Configuration Keys         | Core          | Send GetConfiguration with no key filter. Verify the CP returns all supported configuration keys.                                                   |
| cert16-tc019-get-configuration-key    | TC_019_2 | Retrieve Specific Configuration Key     | Core          | Send GetConfiguration for a specific key (e.g., HeartbeatInterval). Verify the CP returns the requested configuration.                              |
| cert16-tc021-change-configuration     | TC_021   | Change Configuration                    | Core          | Send ChangeConfiguration to update a key (e.g., MeterValueSampleInterval). Verify the CP accepts and applies the change.                            |
| cert16-tc024-lock-failure             | TC_024   | Start Charging Session — Lock Failure   | Core          | Plug in the cable. Verify StatusNotification(Faulted, ConnectorLockFailure) and no transaction started. Plug out.                                   |
| cert16-tc026-remote-start-rejected    | TC_026   | Remote Start — Rejected                 | RemoteTrigger | Send RemoteStartTransaction.req on an Available connector. Verify the CP responds with Rejected status.                                             |
| cert16-tc028-remote-stop-rejected     | TC_028   | Remote Stop — Rejected                  | RemoteTrigger | Verify a charging session in progress. Send RemoteStopTransaction.req. Verify the CP responds with Rejected status and charging continues.          |
| cert16-tc031-unlock-unknown-connector | TC_031   | Unlock Connector — Unknown Connector    | Core          | Send UnlockConnector for a non-existent connector ID. Verify the CP responds with NotSupported.                                                     |
| cert16-reservation-basic              | TC_046   | Reservation (Basic)                     | Reservation   | Send ReserveNow.req for a future reservation. Present the reserved idTag. Accept StartTransaction. Verify MeterValue and StopTransaction.           |
| cert16-tc061-clear-cache              | TC_061   | Clear Authorization Cache               | Core          | Send ClearCache. Verify the CP accepts (Accepted).                                                                                                  |
| cert16-tc064-data-transfer            | TC_064   | Data Transfer to Central System         | Core          | Verify the CP sends DataTransfer.req with vendorId com.example.cert16. Accept or respond with UnknownVendorId as appropriate.                       |

## Numbering Note

Scenario identifiers follow the OCPP Certification Test Cases (OCPPSC) specification test-case numbering: TC_001, TC_003, TC_004, etc. The unlock scenarios TC_017 (Unlock Connector — Occupied, Succeeds) and TC_018 (Unlock Connector — Failure) predate the formal OCPPSC mapping; TC_017 ≈ "unlock with active session" and TC_018 ≈ "unlock failure / stuck lock".

## Response-Override Valid Statuses

When using the `responseOverride` node to arm a one-shot response override for an incoming OCPP request, the following status values are valid per action:

| Action                 | Valid Statuses                                     |
| ---------------------- | -------------------------------------------------- |
| RemoteStartTransaction | Accepted, Rejected                                 |
| RemoteStopTransaction  | Accepted, Rejected                                 |
| TriggerMessage         | Accepted, Rejected, NotImplemented                 |
| ReserveNow             | Accepted, Faulted, Occupied, Rejected, Unavailable |
| CancelReservation      | Accepted, Rejected                                 |
| SendLocalList          | Accepted, Failed, NotSupported, VersionMismatch    |
| ChangeConfiguration    | Accepted, Rejected, RebootRequired, NotSupported   |
| ClearCache             | Accepted, Rejected                                 |
| SetChargingProfile     | Accepted, Rejected, NotSupported                   |
| ClearChargingProfile   | Accepted, Unknown                                  |
| ChangeAvailability     | Accepted, Rejected, Scheduled                      |

## Out-of-Scope

The following test cases are not yet covered by scenarios:

- **TC_007** (Cached Authorization) — No scenario-drivable authorization flow with caching infrastructure.
- **TC_023** (Authorize Outcome Variants) — No scenario-drivable Authorize request/response orchestration.
- **TC_032, TC_037, TC_039** (Offline Power Failure, Offline Transactions) — No offline transaction queue or transaction replication orchestration in the scenario engine.
- **TC_073–TC_088** (Security, Certificates, Key Provisioning) — TLS/PKI infrastructure and security setup are outside the requested feature profiles.

Support for LocalAuthList, additional RemoteTrigger cases, SmartCharging, and Firmware Management profiles will be added in follow-up releases.
