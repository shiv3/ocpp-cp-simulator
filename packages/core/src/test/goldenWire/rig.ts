import { ChargePoint } from "../../cp/domain/charge-point/ChargePoint";
import {
  DefaultBootNotification,
  OCPPStatus,
} from "../../cp/domain/types/OcppTypes";
import { tcpPort } from "../bunServe";
import {
  FakeCsms,
  type CsmsResponder,
  type WireFrame,
  type WireVersion,
} from "./FakeCsms";

export const OCPP_VERSION_STRING: Record<WireVersion, string> = {
  "1.6": "OCPP-1.6J",
  "2.0.1": "OCPP-2.0.1",
};

export interface RigOptions {
  readonly version: WireVersion;
  readonly connectors?: number;
  readonly responders?: Readonly<Record<string, CsmsResponder>>;
  /** Run before `connect()`, to arm configuration, policies or overrides. */
  readonly beforeConnect?: (cp: ChargePoint) => void;
  /** Leave the station unconnected; the case connects it itself. */
  readonly noConnect?: boolean;
}

/** A real ChargePoint wired to a fake CSMS, one per golden case. */
export class Rig {
  private sink: ReturnType<typeof Bun.serve> | null = null;

  private constructor(
    readonly cp: ChargePoint,
    readonly csms: FakeCsms,
    readonly version: WireVersion,
  ) {}

  static async create(options: RigOptions): Promise<Rig> {
    const csms = new FakeCsms({
      version: options.version,
      responders: options.responders,
    });
    const cp = new ChargePoint(
      "CP-GOLDEN",
      DefaultBootNotification,
      options.connectors ?? 1,
      csms.url,
      null,
      null,
      null,
      {},
      [],
      OCPP_VERSION_STRING[options.version],
      {},
    );
    cp.logger.setEnabledTypes();
    cp.events.on("error", () => undefined);
    const rig = new Rig(cp, csms, options.version);
    options.beforeConnect?.(cp);
    if (!options.noConnect) await rig.connectAndBoot();
    return rig;
  }

  get frames(): readonly WireFrame[] {
    return this.csms.frames;
  }

  get is16(): boolean {
    return this.version === "1.6";
  }

  /** connect(), wait for the BootNotification and the status cascade after it. */
  async connectAndBoot(): Promise<void> {
    const from = this.csms.mark();
    this.cp.connect();
    await this.csms.waitForFrame(
      (f) => f.dir === "CP>" && f.action === "BootNotification",
      { from },
    );
    await this.csms.settle();
  }

  /** An HTTP endpoint that accepts every upload with 200, for diagnostics/logs. */
  uploadUrl(): string {
    this.sink ??= Bun.serve({
      port: 0,
      fetch: () => new Response("ok", { status: 200 }),
    });
    return `http://127.0.0.1:${tcpPort(this.sink)}/upload`;
  }

  plugIn(connectorId = 1): void {
    this.cp.updateConnectorStatus(connectorId, OCPPStatus.Preparing);
  }

  unplug(connectorId = 1): void {
    this.cp.updateConnectorStatus(connectorId, OCPPStatus.Available);
  }

  /** The id the CSMS sees for the running transaction of a connector. */
  transactionId(connectorId = 1): string | number | undefined {
    const tx = this.cp.getConnector(connectorId)?.transaction;
    if (!tx) return undefined;
    return this.is16 ? tx.id : (tx.cpTransactionId ?? tx.id);
  }

  async startLocal(tag = "TAG-1", connectorId = 1): Promise<void> {
    await this.cp.startTransaction(tag, connectorId);
    await this.csms.settle();
  }

  async remoteStart(tag = "TAG-R", connectorId = 1): Promise<WireFrame> {
    const answer = this.is16
      ? await this.csms.call("RemoteStartTransaction", {
          idTag: tag,
          connectorId,
        })
      : await this.csms.call("RequestStartTransaction", {
          idToken: { idToken: tag, type: "ISO14443" },
          remoteStartId: 1,
          evseId: connectorId,
        });
    await this.csms.settle();
    return answer;
  }

  async remoteStop(connectorId = 1): Promise<WireFrame> {
    const id = this.transactionId(connectorId);
    const answer = this.is16
      ? await this.csms.call("RemoteStopTransaction", { transactionId: id })
      : await this.csms.call("RequestStopTransaction", { transactionId: id });
    await this.csms.settle();
    return answer;
  }

  async dispose(): Promise<void> {
    try {
      this.cp.dispose();
    } finally {
      await this.csms.stop();
      if (this.sink) await this.sink.stop(true);
    }
  }
}
