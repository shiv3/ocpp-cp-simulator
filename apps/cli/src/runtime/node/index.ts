/** The Node implementation of the runtime layer (#916). */
import type { Runtime } from "../types";
import { nodeFile } from "./file";
import { serveNode } from "./serve";
import { createNodeSocketIoEngine } from "./socketIo";
import { spawnNode } from "./spawn";

export const nodeRuntime: Runtime = {
  name: "node",
  serve: serveNode,
  createSocketIoEngine: createNodeSocketIoEngine,
  spawn: spawnNode,
  file: nodeFile,
};
