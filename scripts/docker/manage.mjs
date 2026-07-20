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

import {
  NODE_ONEBOT_STATUS_PROBE,
  PYTHON_ONEBOT_STATUS_PROBE,
} from "./onebot-status-probes.mjs";

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
  case "restart-core":
    if (allBots) {
      runMaiBot("up", "-d", "--no-deps", "--force-recreate", "core");
    }
    runLingling(
      "up",
      "-d",
      "--build",
      "--no-deps",
      "--force-recreate",
      "core",
    );
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
      `未知操作：${action}；可用值为 start、stop、restart、restart-core、status、logs。`,
    );
}
