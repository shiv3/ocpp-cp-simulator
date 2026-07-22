"""Minimal Python agent for a running ocpp-cp-sim daemon.

Run: pip install "python-socketio[asyncio_client]" && python3 agent.py [base-url]
"""

import asyncio
import sys

import socketio

sio = socketio.AsyncClient()


@sio.on("event")
async def on_event(envelope):
    print("event:", envelope)


async def main():
    base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5172"
    await sio.connect(base, socketio_path="/socket.io/")

    async def rpc(request):
        return await sio.call("rpc", request, timeout=30)

    await rpc({"method": "events.subscribe", "params": {"scope": "CP001"}})
    await rpc(
        {
            "cpId": "CP001",
            "method": "start_transaction",
            "params": {"connector": 1, "tagId": "TAG001"},
        }
    )
    await asyncio.sleep(10)
    await sio.disconnect()


asyncio.run(main())
