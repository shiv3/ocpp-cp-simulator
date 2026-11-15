import { bootCases } from "./cases/boot";
import { firmwareCases } from "./cases/firmware";
import type { GoldenCase } from "./cases/helpers";
import { availabilityCases } from "./cases/availability";
import { configurationCases } from "./cases/configuration";
import { connectionLossCases } from "./cases/connectionLoss";
import { inboundCases } from "./cases/inbound";
import { optInCases } from "./cases/optIn";
import { resetCases } from "./cases/reset";
import { transactionCases } from "./cases/transactions";

export type { GoldenCase } from "./cases/helpers";

export const goldenCases: GoldenCase[] = [
  ...bootCases,
  ...transactionCases,
  ...resetCases,
  ...firmwareCases,
  ...optInCases,
  ...availabilityCases,
  ...inboundCases,
  ...configurationCases,
  ...connectionLossCases,
];
