#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  NODE_ONEBOT_STATUS_PROBE,
  PYTHON_ONEBOT_STATUS_PROBE,
} from "./onebot-status-probes.mjs";

const qrPathInContainer = "/app/napcat/cache/qrcode.png";
const requestedTarget = process.argv[2] ?? "lingling";

const botTargets = {
  lingling: {
    label: "铃铃酱",
    napcatContainer: "lingling-bot-napcat",
    coreContainer: "lingling-bot-core",
    probeCommand: [
      "node",
      "--input-type=module",
      "--eval",
      NODE_ONEBOT_STATUS_PROBE,
    ],
    qrFileName: "lingling-napcat-qrcode.png",
  },
  maibot: {
    label: "麦麦",
    napcatContainer: "maim-bot-napcat",
    coreContainer: "maim-bot-core",
    probeCommand: ["python", "-c", PYTHON_ONEBOT_STATUS_PROBE],
    qrFileName: "maibot-napcat-qrcode.png",
  },
};

function run(args, options = {}) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    process.exit(result.status ?? 1);
  }
  return result;
}

function containerExists(containerName) {
  return run(["inspect", containerName], {
    capture: true,
    allowFailure: true,
  }).status === 0;
}

function isOnline(target) {
  if (!containerExists(target.coreContainer)) return false;
  const result = run(
    ["exec", target.coreContainer, ...target.probeCommand],
    { capture: true, allowFailure: true },
  );
  if (result.status !== 0) return false;
  try {
    const status = JSON.parse(result.stdout.trim());
    return status.online === true && status.good === true;
  } catch {
    return false;
  }
}

function readQrHash(containerName) {
  const result = run(
    ["exec", containerName, "sha256sum", qrPathInContainer],
    { capture: true, allowFailure: true },
  );
  if (result.status !== 0) return "";
  return result.stdout.trim().split(/\s+/, 1)[0] ?? "";
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function openImage(imagePath) {
  if (process.platform === "darwin") {
    return spawnSync("open", [imagePath], { stdio: "ignore" });
  }
  if (process.platform === "win32") {
    return spawnSync("cmd", ["/c", "start", "", imagePath], {
      stdio: "ignore",
    });
  }
  return spawnSync("xdg-open", [imagePath], { stdio: "ignore" });
}

async function openLoginQr(target) {
  if (!containerExists(target.napcatContainer)) {
    throw new Error(`${target.label}尚未启动，请先运行 pnpm start。`);
  }
  if (isOnline(target)) {
    console.log(`${target.label}已经在线，无需重新扫码。`);
    return;
  }

  const previousHash = readQrHash(target.napcatContainer);
  run(["restart", target.napcatContainer]);

  let currentHash = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await delay(2_000);
    if (isOnline(target)) {
      console.log(`${target.label}已自动恢复登录，无需扫码。`);
      return;
    }
    currentHash = readQrHash(target.napcatContainer);
    if (currentHash && currentHash !== previousHash) break;
  }

  if (!currentHash || currentHash === previousHash) {
    throw new Error(`${target.label}未在 40 秒内生成新的登录二维码，请检查容器日志。`);
  }

  const localQrPath = path.join(tmpdir(), target.qrFileName);
  run(["cp", `${target.napcatContainer}:${qrPathInContainer}`, localQrPath]);
  chmodSync(localQrPath, 0o600);
  const opened = openImage(localQrPath);
  if (opened.error || opened.status !== 0) {
    throw opened.error ?? new Error(`无法打开${target.label}二维码图片。`);
  }
  console.log(`${target.label}的新 QQ 登录二维码已打开，请尽快扫码确认。`);
}

const targets =
  requestedTarget === "all"
    ? [botTargets.lingling, botTargets.maibot]
    : [botTargets[requestedTarget]];

if (targets.some((target) => !target)) {
  throw new Error("登录目标只能是 lingling、maibot 或 all。");
}

for (const target of targets) {
  await openLoginQr(target);
}
