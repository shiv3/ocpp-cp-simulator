/**
 * OCPP-S request/response shapes the SOAP client puts on (or reads from) the
 * wire, per dialect: 1.2, 1.5 and 1.6 SOAP. Types only.
 */
import type { StopTransactionRequestV16 } from "@ocpp-cp-simulator/ocpp/index";

export type IdTagInfoStatus =
  "Accepted" | "Blocked" | "Expired" | "Invalid" | "ConcurrentTx";

export type IdTagInfo = {
  expiryDate?: string;
  parentIdTag?: string;
  status: IdTagInfoStatus;
};

export type Ocpp15StopTransactionRequest = Omit<
  StopTransactionRequestV16,
  "reason"
>;

export type Ocpp15ChargePointStatus =
  "Available" | "Occupied" | "Faulted" | "Unavailable" | "Reserved";

export type Ocpp15ChargePointErrorCode =
  | "ConnectorLockFailure"
  | "HighTemperature"
  | "Mode3Error"
  | "NoError"
  | "PowerMeterFailure"
  | "PowerSwitchFailure"
  | "ReaderFailure"
  | "ResetFailure"
  | "GroundFailure"
  | "OverCurrentFailure"
  | "UnderVoltage"
  | "WeakSignal"
  | "OtherError";

export type Ocpp15ReadingContext =
  | "Interruption.Begin"
  | "Interruption.End"
  | "Sample.Clock"
  | "Sample.Periodic"
  | "Transaction.Begin"
  | "Transaction.End";

export type Ocpp15Measurand =
  | "Energy.Active.Export.Register"
  | "Energy.Active.Import.Register"
  | "Energy.Reactive.Export.Register"
  | "Energy.Reactive.Import.Register"
  | "Energy.Active.Export.Interval"
  | "Energy.Active.Import.Interval"
  | "Energy.Reactive.Export.Interval"
  | "Energy.Reactive.Import.Interval"
  | "Power.Active.Export"
  | "Power.Active.Import"
  | "Power.Reactive.Export"
  | "Power.Reactive.Import"
  | "Current.Export"
  | "Current.Import"
  | "Voltage"
  | "Temperature";

export type Ocpp15UnitOfMeasure =
  | "Wh"
  | "kWh"
  | "varh"
  | "kvarh"
  | "W"
  | "kW"
  | "var"
  | "kvar"
  | "Amp"
  | "Volt"
  | "Celsius";

export type Ocpp15Location = "Inlet" | "Outlet" | "Body";

export type Ocpp15StatusNotificationRequest = {
  connectorId: number;
  status: Ocpp15ChargePointStatus;
  errorCode: Ocpp15ChargePointErrorCode;
  info?: string;
  timestamp?: string;
  vendorId?: string;
  vendorErrorCode?: string;
};

export type Ocpp12ChargePointStatus =
  "Available" | "Occupied" | "Faulted" | "Unavailable";

export type Ocpp12ChargePointErrorCode =
  | "ConnectorLockFailure"
  | "HighTemperature"
  | "Mode3Error"
  | "NoError"
  | "PowerMeterFailure"
  | "PowerSwitchFailure"
  | "ReaderFailure"
  | "ResetFailure";

export type Ocpp12StatusNotificationRequest = {
  connectorId: number;
  status: Ocpp12ChargePointStatus;
  errorCode: Ocpp12ChargePointErrorCode;
};

export type Ocpp12MeterSample = string;

export type Ocpp12MeterValuesRequest = {
  connectorId: number;
  values: {
    timestamp: string;
    value: Ocpp12MeterSample;
  }[];
};

export type Ocpp12StartTransactionRequest = {
  connectorId: number;
  idTag: string;
  timestamp: string;
  meterStart: number;
};

export type Ocpp15MeterSample = {
  "#text": string;
  "@_context"?: Ocpp15ReadingContext;
  "@_format"?: "Raw" | "SignedData";
  "@_measurand"?: Ocpp15Measurand;
  "@_location"?: Ocpp15Location;
  "@_unit"?: Ocpp15UnitOfMeasure;
};

export type Ocpp15MeterValuesRequest = {
  connectorId: number;
  transactionId?: number;
  values: {
    timestamp: string;
    value: Ocpp15MeterSample[];
  }[];
};

// 1.6 SOAP enums: passthrough, no collapsing
export type Ocpp16ChargePointStatus =
  | "Available"
  | "Preparing"
  | "Charging"
  | "SuspendedEV"
  | "SuspendedEVSE"
  | "Finishing"
  | "Reserved"
  | "Unavailable"
  | "Faulted";

export type Ocpp16ChargePointErrorCode =
  | "ConnectorLockFailure"
  | "EVCommunicationError"
  | "GroundFailure"
  | "HighTemperature"
  | "InternalError"
  | "LocalListConflict"
  | "NoError"
  | "OtherError"
  | "OverCurrentFailure"
  | "OverVoltage"
  | "PowerMeterFailure"
  | "PowerSwitchFailure"
  | "ReaderFailure"
  | "ResetFailure"
  | "UnderVoltage"
  | "WeakSignal";

export type Ocpp16StatusNotificationRequest = {
  connectorId: number;
  status: Ocpp16ChargePointStatus;
  errorCode: Ocpp16ChargePointErrorCode;
  info?: string;
  timestamp?: string;
  vendorId?: string;
  vendorErrorCode?: string;
};

// 1.6 SOAP SampledValue: child elements, not attributes
export type Ocpp16SampledValue = {
  value: string;
  context?: string;
  format?: "Raw" | "SignedData";
  measurand?: string;
  phase?: string;
  location?: string;
  unit?: string;
};

export type Ocpp16MeterValue = {
  timestamp: string;
  sampledValue: Ocpp16SampledValue[];
};

export type Ocpp16MeterValuesRequest = {
  connectorId: number;
  transactionId?: number;
  meterValue?: Ocpp16MeterValue[];
};

export type Ocpp16StartTransactionRequest = {
  connectorId: number;
  idTag: string;
  timestamp: string;
  meterStart: number;
  reservationId?: number;
};

export type Ocpp16StopTransactionRequest = {
  transactionId: number;
  idTag?: string;
  timestamp: string;
  meterStop: number;
  reason?: string;
  transactionData?: Ocpp16MeterValue[];
};
