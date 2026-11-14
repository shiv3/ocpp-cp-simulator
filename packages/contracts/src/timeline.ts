// Operational timeline vocabulary (#448): the format version, the entry kinds
// and the default capacity. The timeline itself is
// `cp/application/services/OperationalTimeline.ts`; the kind vocabulary and the
// correlation rules are documented in `docs/concepts/operational-timeline.md`.

/** Bumped by minor for additive changes; consumers ignore unknown kinds. */
export const TIMELINE_FORMAT_VERSION = "1.7";

export const TIMELINE_KINDS = [
  "connected",
  "disconnected",
  "reconnecting",
  "gave_up",
  "boot_notification",
  "reconnected_without_boot",
  "status_change",
  "connector_status",
  "network_fault_injected",
  "cellular_link_lost",
  "cellular_link_restored",
  "cellular_throughput_changed",
  "power_lost",
  "power_restored",
  "recovery_completed",
  "transaction_started",
  "transaction_id_assigned",
  "transaction_stopped",
  "transaction_rejected",
  "transaction_message_rejected",
  "transaction_message_discarded",
  "authorization_rejected",
  "scenario_started",
  "scenario_wait_changed",
  "scenario_error",
  "scenario_finished",
  "charging_profile_applied",
  "charging_profile_cleared",
  "charging_profile_expired",
] as const;

export const TIMELINE_DEFAULT_CAPACITY = 1000;
