import type { AutoMeterValueConfig } from "../cp/domain/connector/MeterValueCurve";
import type { ChargePointService } from "../data/interfaces/ChargePointService";

type ConnectorAutoMeterService = Pick<
  ChargePointService,
  "saveAutoMeterConfig" | "setAutoMeterValueConfig"
>;

export function saveConnectorAutoMeterConfig(
  chargePointService: ConnectorAutoMeterService,
  cpId: string,
  connectorId: number,
  config: AutoMeterValueConfig,
): void {
  void chargePointService.setAutoMeterValueConfig(cpId, connectorId, config);
  void chargePointService.saveAutoMeterConfig(cpId, connectorId, config);
}
