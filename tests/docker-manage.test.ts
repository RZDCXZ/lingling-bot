import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = path.resolve(projectRoot, "..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("Docker 双机器人管理", () => {
  it("docker:login 以 OneBot 状态判断 QQ 离线，不把端口可用误判为在线", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "qq-bots-login-test-"),
    );
    temporaryDirectories.push(temporaryDirectory);

    const callsFile = path.join(temporaryDirectory, "docker-calls.txt");
    const restartedFile = path.join(temporaryDirectory, "napcat-restarted");
    const dockerStub = path.join(temporaryDirectory, "docker");
    await writeFile(
      dockerStub,
      `#!/bin/sh
printf "%s\\n" "$*" >> "$DOCKER_CALLS_FILE"
case "$*" in
  *get_status*)
    printf '{"online":false,"good":true}'
    ;;
  *"sha256sum /app/napcat/cache/qrcode.png"*)
    if [ -f "$DOCKER_RESTARTED_FILE" ]; then
      printf 'new-hash  /app/napcat/cache/qrcode.png\\n'
    else
      printf 'old-hash  /app/napcat/cache/qrcode.png\\n'
    fi
    ;;
  "restart lingling-bot-napcat")
    : > "$DOCKER_RESTARTED_FILE"
    ;;
  cp\\ *)
    for destination do :; done
    : > "$destination"
    ;;
esac
`,
      "utf8",
    );
    await chmod(dockerStub, 0o755);

    const openStub = path.join(temporaryDirectory, "open");
    await writeFile(openStub, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(openStub, 0o755);

    const result = spawnSync(
      "pnpm",
      ["-C", projectRoot, "run", "docker:login"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DOCKER_CALLS_FILE: callsFile,
          DOCKER_RESTARTED_FILE: restartedFile,
          PATH: `${temporaryDirectory}:${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).not.toContain("已经在线");
    expect(await readFile(callsFile, "utf8")).toContain(
      "restart lingling-bot-napcat",
    );
  });

  it("restart:core 只重建业务核心，不停止或重建 NapCat", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "qq-bots-docker-test-"),
    );
    temporaryDirectories.push(temporaryDirectory);

    const callsFile = path.join(temporaryDirectory, "docker-calls.txt");
    const dockerStub = path.join(temporaryDirectory, "docker");
    await writeFile(
      dockerStub,
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOCKER_CALLS_FILE"\n',
      "utf8",
    );
    await chmod(dockerStub, 0o755);

    const result = spawnSync(
      "pnpm",
      ["-C", workspaceRoot, "run", "restart:core"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DOCKER_CALLS_FILE: callsFile,
          PATH: `${temporaryDirectory}:${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);

    const calls = (await readFile(callsFile, "utf8")).trim().split("\n");
    expect(calls).toEqual([
      `compose -f ${path.join(workspaceRoot, "MaiBot/docker-compose.yml")} up -d --no-deps --force-recreate core`,
      "compose --env-file .env.local -f compose.yaml up -d --build --no-deps --force-recreate core",
    ]);
    expect(calls.join(" ")).not.toMatch(/\bdown\b|\bnapcat\b/i);
  });
});
