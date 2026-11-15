// Regression cases for the golden wire test. Every transcript here was
// recorded on ca01d302 (before the charger engine), never on this branch: they
// pin what that commit put on the wire in situations the first set missed
// (retries, the offline queue, disconnects with follow-ups in flight, gate
// precedence, deferred availability, reservations and so on).
import { cases } from "./regressionCases/helpers";
import "./regressionCases/startAndAuth";
import "./regressionCases/availability";
import "./regressionCases/reservation";
import "./regressionCases/resetPhysical";
import "./regressionCases/networkDrops";
import "./regressionCases/triggersFirmware";
import "./regressionCases/protocolMisc";
import "./regressionCases/mutationGaps";
import "./regressionCases/remoteStartAndTariff";
import "./regressionCases/paceAndFollowUps";
import "./regressionCases/securityAndPower";
import "./regressionCases/modem";

export const regressionCases = cases;
