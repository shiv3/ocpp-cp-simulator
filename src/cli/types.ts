export interface CLIOptions {
  readonly wsUrl: string;
  readonly cpId: string | null;
  readonly connectors: number;
  readonly jsonMode: boolean;
  readonly daemon: boolean;
  readonly send: string | null;
  readonly events: boolean;
  readonly stop: boolean;
  readonly basicAuth: {
    readonly username: string;
    readonly password: string;
  } | null;
  readonly vendor: string;
  readonly model: string;
  readonly scenario: string | null;
  readonly scenarioTemplate: string | null;
  readonly scenarioConnector: number;
  readonly httpPort: number | null;
  readonly httpHost: string;
  readonly unixSocket: string | null;
  readonly httpUrl: string | null;
  readonly allEvents: boolean;
}

export interface ChargePointInitOptions {
  readonly cpId: string;
  readonly wsUrl: string;
  readonly connectors: number;
  readonly vendor: string;
  readonly model: string;
  readonly basicAuth: {
    readonly username: string;
    readonly password: string;
  } | null;
}

export interface JsonCommand {
  readonly id?: string;
  readonly command: string;
  readonly params?: Record<string, unknown>;
}

export interface JsonResponse {
  readonly id: string | null;
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

export interface JsonEvent {
  readonly event: string;
  readonly data: unknown;
  readonly timestamp: string;
}

export interface ConnectorStatus {
  readonly id: number;
  readonly status: string;
  readonly availability: string;
  readonly meterValue: number;
  readonly transactionId: number | null;
}

export interface ChargePointStatus {
  readonly id: string;
  readonly status: string;
  readonly error: string;
  readonly connectors: ReadonlyArray<ConnectorStatus>;
}
