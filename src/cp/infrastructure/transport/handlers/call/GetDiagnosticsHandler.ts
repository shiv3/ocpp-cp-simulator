import { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import * as request from "@voltbras/ts-ocpp/dist/messages/json/request";
import * as response from "@voltbras/ts-ocpp/dist/messages/json/response";
import { UploadFile } from "../../../file_upload";
import { LogType } from "../../../../shared/Logger";

export class GetDiagnosticsHandler
  implements
    CallHandler<
      request.GetDiagnosticsRequest,
      response.GetDiagnosticsResponse
    >
{
  handle(
    payload: request.GetDiagnosticsRequest,
    context: HandlerContext,
  ): response.GetDiagnosticsResponse {
    context.logger.info(`Get diagnostics request received: ${payload.location}`, LogType.DIAGNOSTICS);

    const logs = context.logger.getLogs().join("\n");
    const blob = new Blob([logs], { type: "text/plain" });
    const file = new File([blob], "diagnostics.txt");
    (async () => await UploadFile(payload.location, file))();

    return { fileName: "diagnostics.txt" };
  }
}
