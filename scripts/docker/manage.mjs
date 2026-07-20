#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = realpathSync(path.resolve(path.dirname(scriptPath), "../.."));
const maiBotRoot = path.resolve(projectRoot, "../MaiBot");
const allBots = process.argv.includes("--all");
const action = process.argv[2] ?? "status";

const dockerEnvironment = {
  ...process.env,
  LOCAL_UID: String(process.getuid?.() ?? 1000),
  LOCAL_GID: String(process.getgid?.() ?? 1000),
};

const NODE_ONEBOT_STATUS_PROBE = String.raw`
import { readFileSync } from "node:fs";
import WebSocket from "ws";

const token = readFileSync(0, "utf8").trim();
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

const PYTHON_ONEBOT_STATUS_PROBE = String.raw`
import asyncio
import json
import sys

import aiohttp


async def probe():
    token = sys.stdin.read().strip()
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

const statusTargets = {
  lingling: {
    label: "铃铃酱",
    coreContainer: "lingling-bot-core",
    configDir: path.join(projectRoot, "data/napcat/config"),
    probeCommand: [
      "node",
      "--input-type=module",
      "--eval",
      NODE_ONEBOT_STATUS_PROBE,
    ],
  },
  maibot: {
    label: "麦麦",
    coreContainer: "maim-bot-core",
    configDir: path.join(maiBotRoot, "docker-config/napcat"),
    probeCommand: ["python", "-c", PYTHON_ONEBOT_STATUS_PROBE],
  },
};

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: dockerEnvironment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function readOneBotToken(configDir) {
  const configFiles = readdirSync(configDir)
    .filter((fileName) => /^onebot11_\d+\.json$/.test(fileName))
    .sort();
  const tokens = [];

  for (const fileName of configFiles) {
    const config = JSON.parse(
      readFileSync(path.join(configDir, fileName), "utf8"),
    );
    const servers = config.network?.websocketServers ?? [];
    for (const server of servers) {
      if (server.enable === true && Number(server.port) === 3001) {
        tokens.push(String(server.token ?? ""));
      }
    }
  }

  if (tokens.length !== 1) {
    throw new Error("未找到唯一启用的 3001 端口 OneBot WebSocket 配置");
  }
  return tokens[0];
}

function probeOneBotStatus(target) {
  let token;
  try {
    token = readOneBotToken(target.configDir);
  } catch (error) {
    return {
      kind: "unknown",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const result = spawnSync(
    "docker",
    ["exec", "-i", target.coreContainer, ...target.probeCommand],
    {
      cwd: projectRoot,
      env: dockerEnvironment,
      encoding: "utf8",
      input: token,
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 6_000,
    },
  );

  if (result.error || result.status !== 0) {
    return {
      kind: "unknown",
      reason: "核心容器未运行、认证不一致或 OneBot 暂不可用",
    };
  }

  try {
    const status = JSON.parse(result.stdout.trim());
    if (status.online === true && status.good === true) {
      return { kind: "online" };
    }
    if (status.online === false) {
      return { kind: "offline" };
    }
    return { kind: "unhealthy" };
  } catch {
    return { kind: "unknown", reason: "OneBot 返回了无法识别的状态" };
  }
}

function printOneBotStatus(target) {
  const status = probeOneBotStatus(target);
  switch (status.kind) {
    case "online":
      console.log("QQ 连接：在线");
      break;
    case "offline":
      console.log("QQ 连接：离线（NapCat 仍在运行，但 QQ 登录态已失效）");
      break;
    case "unhealthy":
      console.log("QQ 连接：异常（已登录，但 OneBot 状态不健康）");
      break;
    default:
      console.log(`QQ 连接：无法检测（${status.reason}）`);
  }
}

function runLingling(...args) {
  run(
    "docker",
    ["compose", "--env-file", ".env.local", "-f", "compose.yaml", ...args],
    projectRoot,
  );
}

function runMaiBot(...args) {
  const composePath = path.join(maiBotRoot, "docker-compose.yml");
  if (!existsSync(composePath)) {
    throw new Error(`未找到同级 MaiBot 项目：${composePath}`);
  }
  run("docker", ["compose", "-f", composePath, ...args], maiBotRoot);
}

function printTitle(title) {
  process.stdout.write(`\n=== ${title} ===\n`);
}

switch (action) {
  case "start":
    if (allBots) runMaiBot("up", "-d");
    runLingling("up", "-d", "--build");
    break;
  case "stop":
    runLingling("down");
    if (allBots) runMaiBot("down");
    break;
  case "restart":
    runLingling("down");
    if (allBots) {
      runMaiBot("down");
      runMaiBot("up", "-d");
    }
    runLingling("up", "-d", "--build");
    break;
  case "status":
    if (allBots) {
      printTitle("麦麦");
      runMaiBot("ps");
      printOneBotStatus(statusTargets.maibot);
      printTitle("铃铃酱");
    }
    runLingling("ps");
    printOneBotStatus(statusTargets.lingling);
    break;
  case "logs":
    if (allBots) {
      throw new Error("合并日志容易混淆账号，请分别使用各项目的日志命令。");
    }
    runLingling("logs", "--tail", "200", "-f");
    break;
  default:
    throw new Error(
      `未知操作：${action}；可用值为 start、stop、restart、status、logs。`,
    );
}
