import { ChargePoint } from "../ChargePoint";
import { DefaultBootNotification } from "../../types/OcppTypes";
import type { Database, SqlParam, SqlRow } from "../../persistence/Database";

/** A WebSocket charge point that is never connected. */
export function makeChargePoint({
  id = "cp-test",
  ocppVersion = "OCPP-1.6J",
  database = null,
  connectorCount = 1,
}: {
  id?: string;
  ocppVersion?: string;
  database?: Database | null;
  connectorCount?: number;
} = {}): ChargePoint {
  return new ChargePoint(
    id,
    DefaultBootNotification,
    connectorCount,
    "ws://localhost:8080",
    null,
    null,
    database,
    {},
    [],
    ocppVersion,
    {},
  );
}

/** Answers the configuration-override query and nothing else. Values are
 *  stored the way ConfigurationStore persists them: JSON-encoded. */
export class OverrideDatabase implements Database {
  constructor(private readonly overrides: Record<string, string>) {}
  exec(): void {}
  run(): void {}
  all<T = SqlRow>(sql: string, _params: SqlParam[] = []): T[] {
    if (!sql.includes("FROM configuration")) return [];
    return Object.entries(this.overrides).map(([key, value]) => ({
      key,
      value,
    })) as T[];
  }
  get<T = SqlRow>(): T | null {
    return null;
  }
  close(): void {}
}
