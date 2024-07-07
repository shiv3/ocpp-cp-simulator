export enum StorageKey {
  CHARGE_POINT = 'charge_point',
  // METER_VALUE = 'meter_value',
  // TRANSACTION_ID = 'transaction_id',
  // OCPP_STATUS = 'ocpp_status',
  // CONN_STATUS = 'conn_status',
  // CONN_AVAILABILITY = 'conn_availability',
}

// export const getStorageKeyByConnector = (connectorId: number, key: StorageKey) => {
//   return `${key}_${connectorId}`;
// }

export interface ChargePoint {
  id: string;
  connectorNumber: number;
  connectors: Connector[];
}

export function setChargePoint(cp: ChargePoint) {
  sessionStorage.setItem(StorageKey.CHARGE_POINT, JSON.stringify(cp));
}

export function getChargePoint(): ChargePoint {
  const cp = sessionStorage.getItem(StorageKey.CHARGE_POINT);
  if (cp) {
    return JSON.parse(cp);
  }
  throw new Error('Charge Point not found');
}

interface Connector {
  id: number;
  status: string;
  availability: string;
  transaction: Transaction | null;
  meterValue: number;
}

interface Transaction {
  id: number | null;
  connectorId: number;
  tagId: string;
  meterStart: number;
  startTime: string;
  stopTime: string | null;
}

export function getConnector(connectorId: number): Connector | null {
  const cp = getChargePoint();
  if (cp) {
    return cp.connectors.find(c => c.id === connectorId) || null;
  }
  return null;
}

export function setAllConnectorsStatus(status: string) {
  const cp = getChargePoint();
  if (cp) {
    cp.connectors = cp.connectors.map(c => {
      c.status = status;
      return c;
    });
    setChargePoint(cp);
  }
}

export function setConnectorStatus(connectorId: number, status: string) {
  const cp = getChargePoint();
  if (cp) {
    const connector = cp.connectors.find(c => c.id === connectorId);
    if (connector) {
      connector.status = status;
      cp.connectors = cp.connectors.map(c => c.id === connectorId ? connector : c);
      setChargePoint(cp);
    }
  }
}

export function getTransaction(connectorId: number): Transaction {
  const cp = getChargePoint();
  if (cp) {
    const tx = cp.connectors.find(c => c.id === connectorId)?.transaction;
    if (tx) {
      return tx;
    }
  }
  throw new Error('Transaction not found');
}

export function setTransaction(connectorId: number, transaction: Transaction|null) {
  const cp = getChargePoint();
  if (cp) {
    cp.connectors = cp.connectors.map(c => {
      if (c.id === connectorId) {
        c.transaction = transaction;
      }
      return c;
    })
    setChargePoint(cp);
  }
}

export function getTransactionByTagId(tagId: string): Transaction | null {
  const cp = getChargePoint();
  if (cp) {
    return cp.connectors.filter(c => c.transaction !== null).map(c => c.transaction).find(t => t?.tagId === tagId) || null;
  }
  return null;
}

export function getLatestTransaction(): Transaction | null {
  const cp = getChargePoint();
  if (cp) {
    return cp.connectors.filter(c => c.transaction !== null).map(c => c.transaction).filter(t => t !== null && t?.stopTime === null).sort((a, b) => a.startTime.localeCompare(b.startTime))[0] || null;
  }
  return null;
}

export function getTransactionByTransactionId(transactionId: number): Transaction | null {
  const cp = getChargePoint();
  if (cp) {
    return cp.connectors.filter(c => c.transaction !== null).map(c => c.transaction).find(t => t.id === transactionId) || null;
  }
  return null;
}

export function getMeterValue(connectorId: number): number {
  const cp = getChargePoint();
  if (cp) {
    const connector = cp.connectors.find(c => c.id === connectorId);
    if (connector) {
      return connector.meterValue;
    }
  }
  throw new Error('Meter value not found');
}

export function setMeterValue(connectorId: number, value: number) {
  const cp = getChargePoint();
  if (cp) {
    const connector = cp.connectors.find(c => c.id === connectorId);
    if (connector) {
      connector.meterValue = value;
      return setChargePoint(cp);
    }
  }
  throw new Error('Meter value not found');
}
