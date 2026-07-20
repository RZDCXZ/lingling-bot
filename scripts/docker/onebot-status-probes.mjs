export const NODE_ONEBOT_STATUS_PROBE = String.raw`
import { readFileSync } from "node:fs";
import WebSocket from "ws";

const stdinToken = readFileSync(0, "utf8").trim();
const token = stdinToken || String(process.env.ONEBOT_ACCESS_TOKEN ?? "").trim();
const headers = token ? { Authorization: "Bearer " + token } : {};
const echo = "qq-bots-status-probe";
let socket;

function finish(code, status) {
  if (status) process.stdout.write(JSON.stringify(status));
  socket?.terminate();
  process.exit(code);
}

const timeout = setTimeout(() => finish(2), 3_000);
socket = new WebSocket("ws://napcat:3001", { headers });
socket.once("open", () => {
  socket.send(JSON.stringify({ action: "get_status", params: {}, echo }));
});
socket.on("message", (raw) => {
  let response;
  try {
    response = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (response.echo !== echo) return;
  clearTimeout(timeout);
  finish(0, {
    online: response.data?.online === true,
    good: response.data?.good === true,
  });
});
socket.once("error", () => {
  clearTimeout(timeout);
  finish(2);
});
`;

export const PYTHON_ONEBOT_STATUS_PROBE = String.raw`
import asyncio
import json
import os
import sys

import aiohttp


async def probe():
    stdin_token = sys.stdin.read().strip()
    token = stdin_token or os.environ.get("ONEBOT_ACCESS_TOKEN", "").strip()
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    echo = "qq-bots-status-probe"
    timeout = aiohttp.ClientTimeout(total=4)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.ws_connect("ws://napcat:3001", headers=headers) as websocket:
            await websocket.send_json({"action": "get_status", "params": {}, "echo": echo})
            while True:
                message = await asyncio.wait_for(websocket.receive(), timeout=3)
                if message.type != aiohttp.WSMsgType.TEXT:
                    raise RuntimeError("OneBot WebSocket closed before returning status")
                response = json.loads(message.data)
                if response.get("echo") != echo:
                    continue
                data = response.get("data") or {}
                print(json.dumps({
                    "online": data.get("online") is True,
                    "good": data.get("good") is True,
                }))
                return


try:
    asyncio.run(probe())
except Exception:
    sys.exit(2)
`;
