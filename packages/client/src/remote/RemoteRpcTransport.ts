import {
  RPC_TIMEOUT_MS,
  RpcFailure,
  type Params,
  type Result,
  type RpcAck,
  type RpcErrorCode,
  type RpcMethod,
  type RpcRequest,
} from "@ocpp-cp-simulator/contracts/index";
import type { Socket } from "socket.io-client";
import { publicFailure } from "./rpcErrors";

interface PendingRpc {
  reject: (failure: RpcFailure) => void;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isRpcAck<R>(ack: unknown): ack is RpcAck<R> {
  return (
    isRecord(ack) &&
    typeof ack.ok === "boolean" &&
    (ack.ok === true ||
      (isRecord(ack.error) &&
        typeof ack.error.code === "string" &&
        typeof ack.error.message === "string"))
  );
}

/** Socket.IO RPC emit / pending-request bookkeeping of RemoteChargePointService (split out in #877). */
export class RemoteRpcTransport {
  private readonly pendingRpc = new Map<number, PendingRpc>();
  private nextRpcId = 1;

  constructor(private readonly socket: Socket) {}

  rpc<M extends RpcMethod>(
    method: M,
    params: Params<M>,
    cpId?: string,
  ): Promise<Result<M>> {
    const request: RpcRequest = {
      ...(cpId ? { cpId } : {}),
      method,
      params,
    };

    return this.emitRpcRequest(request, (ack) => {
      if (!ack.ok) {
        throw new RpcFailure(ack.error.code, ack.error.message, {
          retryAfterSeconds: ack.error.retryAfterSeconds,
        });
      }
      return ack.result as Result<M>;
    });
  }

  emitRpcAck(request: RpcRequest): Promise<RpcAck> {
    return this.emitRpcRequest(request, (ack) => ack);
  }

  private emitRpcRequest<T>(
    request: RpcRequest,
    mapAck: (ack: RpcAck) => T,
  ): Promise<T> {
    const id = this.nextRpcId++;

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        this.pendingRpc.delete(id);
        fn();
      };

      this.pendingRpc.set(id, {
        reject: (failure) => settle(() => reject(failure)),
      });

      if (!this.socket.connected) this.socket.connect();

      void this.socket
        .timeout(RPC_TIMEOUT_MS)
        .emitWithAck("rpc", request)
        .then(
          (ack: unknown) => {
            if (!isRpcAck(ack)) {
              settle(() =>
                reject(new RpcFailure("internal", "invalid rpc ack")),
              );
              return;
            }
            settle(() => {
              try {
                resolve(mapAck(ack));
              } catch (err) {
                reject(err);
              }
            });
          },
          () => {
            this.rejectPending("timeout");
          },
        );
    });
  }

  rejectPending(code: RpcErrorCode): void {
    if (this.pendingRpc.size === 0) return;
    const failure = publicFailure(code);
    const pending = [...this.pendingRpc.values()];
    this.pendingRpc.clear();
    pending.forEach((entry) => entry.reject(failure));
  }
}
