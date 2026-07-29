// src/cli/exportK6/runtime/metrics.ts
import { Counter, Rate, Trend } from "k6/metrics";

export const ocppCallDuration = new Trend("ocpp_call_duration", true);
export const ocppCalls = new Counter("ocpp_calls");
export const ocppErrors = new Counter("ocpp_errors");
export const ocppBootTime = new Trend("ocpp_boot_time", true);
export const scenarioSuccess = new Rate("scenario_success");
