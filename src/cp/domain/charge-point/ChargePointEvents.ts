import { OCPPStatus, OCPPAvailability } from "../types/OcppTypes";

/**
 * ChargePoint event types
 */
export interface ChargePointEvents {
  // Status events
  statusChange: { status: OCPPStatus; message?: string };
  error: { error: string };

  // Connection events
  connected: void;
  disconnected: { code: number; reason: string };
  reconnecting: { attempt: number; maxAttempts: number };

  // Connector events
  connectorStatusChange: {
    connectorId: number;
    status: OCPPStatus;
    previousStatus: OCPPStatus;
  };
  connectorAvailabilityChange: {
    connectorId: number;
    availability: OCPPAvailability;
  };
  connectorTransactionChange: {
    connectorId: number;
    transactionId: number | null;
  };
  connectorMeterValueChange: {
    connectorId: number;
    meterValue: number;
  };
  connectorSocChange: {
    connectorId: number;
    soc: number | null;
  };
  connectorRemoved: {
    connectorId: number;
  };

  // Transaction events
  transactionStarted: {
    connectorId: number;
    transactionId: number;
    tagId: string;
  };
  transactionStopped: {
    connectorId: number;
    transactionId: number;
    reason?: string;
  };

  // Message events
  messageSent: {
    messageId: string;
    action: string;
    payload: unknown;
  };
  messageReceived: {
    messageId: string;
    action: string;
    payload: unknown;
  };

  // Heartbeat events
  heartbeatSent: void;
  heartbeatReceived: { currentTime: string };

  // Log events
  log: {
    timestamp: Date;
    level: number;
    type: string;
    message: string;
  };
}
