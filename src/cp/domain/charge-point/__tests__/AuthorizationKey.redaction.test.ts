import { describe, expect, it, vi } from "vitest";

import type { HandlerContext } from "../../../infrastructure/transport/handlers/MessageHandlerRegistry";
import { GetConfigurationHandler } from "../../../infrastructure/transport/handlers/call/GetConfigurationHandler";
import { ChangeConfigurationHandler } from "../../../infrastructure/transport/handlers/call/OtherCallHandlers";
import { Logger, LogLevel, LogType } from "../../../shared/Logger";
import { eventToWire } from "../../../../protocol";
import type { ChargePoint } from "../ChargePoint";
import { defaultConfiguration } from "../Configuration";
import { ConfigurationStore } from "../ConfigurationStore";

const SECRET = "authorization-key-secret";

const cpShape = {
  connectorNumber: 1,
  wsUrl: "ws://csms.example/ocpp/",
} as ChargePoint;

function storeWithAuthorizationKey(): ConfigurationStore {
  const store = new ConfigurationStore(
    "cp-redact",
    defaultConfiguration(cpShape),
    null,
  );
  expect(store.applyChange("AuthorizationKey", SECRET)).toBe("Accepted");
  return store;
}

function contextFor(
  store: ConfigurationStore,
  logger: Logger = { info: vi.fn() } as unknown as Logger,
): HandlerContext {
  return {
    chargePoint: { configuration: store } as ChargePoint,
    logger,
  };
}

describe("AuthorizationKey redaction", () => {
  const surfaces: Array<{
    readonly name: string;
    readonly expose: () => unknown;
  }> = [
    {
      name: "GetConfiguration response",
      expose: () => {
        const response = new GetConfigurationHandler().handle(
          { key: ["AuthorizationKey"] },
          contextFor(storeWithAuthorizationKey()),
        );
        expect(response.configurationKey?.[0]).toMatchObject({
          key: "AuthorizationKey",
          readonly: false,
          value: "",
        });
        return response;
      },
    },
    {
      name: "HTTP/socket event payload",
      expose: () => {
        const payload = eventToWire({
          event: "configuration",
          data: {
            AuthorizationKey: SECRET,
            nested: { authorizationKey: SECRET },
            url: "ws://user:pass@csms.example/ocpp",
          },
        });
        expect(JSON.stringify(payload)).not.toContain("pass@");
        return payload;
      },
    },
    {
      name: "debug/state serialization",
      expose: () => JSON.stringify(storeWithAuthorizationKey()),
    },
    {
      name: "logs",
      expose: () => {
        const logger = new Logger(LogLevel.DEBUG);
        const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
        try {
          new ChangeConfigurationHandler().handle(
            { key: "AuthorizationKey", value: SECRET },
            contextFor(storeWithAuthorizationKey(), logger),
          );
          logger.info(
            `manual AuthorizationKey='${SECRET}'`,
            LogType.CONFIGURATION,
          );
          return {
            entries: logger.getLogEntries(),
            console: infoSpy.mock.calls,
          };
        } finally {
          infoSpy.mockRestore();
        }
      },
    },
  ];

  it.each(surfaces)(
    "$name does not expose the write-only value",
    ({ expose }) => {
      expect(JSON.stringify(expose())).not.toContain(SECRET);
    },
  );
});
