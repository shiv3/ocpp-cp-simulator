import type { Database } from "./Database";
import {
  InMemoryChargingSessionRepository,
  type ChargingSessionRepository,
} from "./ChargingSessionRepository";
import { SqliteChargingSessionRepository } from "./SqliteChargingSessionRepository";

/** The session history for a daemon (#447): the `charging_sessions` table on
 *  `database`, or a bounded in-memory store without one. */
export function createChargingSessionRepository(
  database: Database | null,
): ChargingSessionRepository {
  return database
    ? new SqliteChargingSessionRepository(database)
    : new InMemoryChargingSessionRepository();
}
