// Minimal Node agent for a running ocpp-cp-sim daemon.
// Run: npm i socket.io-client && node agent.mjs [base-url]
import { io } from "socket.io-client";

const base = process.argv[2] ?? "http://127.0.0.1:5172";
const socket = io(base, { path: "/socket.io/" });
const rpc = (request) => socket.timeout(30_000).emitWithAck("rpc", request);

socket.on("event", (envelope) => console.log(JSON.stringify(envelope)));
await new Promise((resolve, reject) => {
  socket.once("connect", resolve);
  socket.once("connect_error", reject);
});

await rpc({ method: "events.subscribe", params: { scope: "CP001" } });
await rpc({
  cpId: "CP001",
  method: "start_transaction",
  params: { connector: 1, tagId: "TAG001" },
});

// Stream events for 10 s, then disconnect.
await new Promise((resolve) => setTimeout(resolve, 10_000));
socket.close();
