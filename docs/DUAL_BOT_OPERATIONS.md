# 本机双 QQ 机器人 Docker 共存说明

本文记录麦麦与铃铃酱在同一台 Mac 上通过两套 Docker Compose 长期共存的部署方式。
文档不保存 QQ 号、群号、Token、API Key 或 Codex 登录信息；真实值只保存在被 Git
忽略的本地配置和持久化目录中。

## 当前架构与端口

两套机器人使用不同 QQ 小号、容器名、Docker 网络、数据目录和 WebUI 端口。
两个 OneBot WebSocket 都只存在于各自私有网络的 `napcat:3001`，不映射到宿主机。

| 用途 | 本机访问地址 | 容器 |
| --- | --- | --- |
| 铃铃酱 NapCat WebUI | `http://127.0.0.1:17099/webui` | `lingling-bot-napcat` |
| 铃铃酱核心 | 无 WebUI | `lingling-bot-core` |
| 麦麦 NapCat WebUI | `http://127.0.0.1:16099/webui` | `maim-bot-napcat` |
| 麦麦 MaiBot WebUI | `http://127.0.0.1:18001` | `maim-bot-core` |

端口只绑定 `127.0.0.1`，不要改成 `0.0.0.0` 或映射到公网。旧的铃铃酱原生端口
`6099`、`3001` 只属于备用的 macOS NapCat 方案；Docker 部署时不再使用。

## 持久化与敏感配置

铃铃酱项目：

- `.env.local`：白名单、OneBot Token、机器人小号变量与运行参数，权限保持 `600`。
- `data/napcat/config/`：NapCat WebUI 和 OneBot 配置。
- `data/napcat/qq/`：QQ 登录状态。
- 核心容器以只读方式挂载同一 QQ 数据目录，确保 NapCat 返回容器内本地图片路径时
  仍能读取图片；核心不能修改 QQ 登录数据。
- `data/group-engagement-state.json`：主动互动计数与调度状态，不保存聊天正文。
- `~/.codex`：从宿主机挂载到核心容器，提供 Codex 登录和生成图片目录；不写入镜像。
- `~/Pictures/daily-sese/`：延年益寿图片归档。

麦麦项目：

- `.env`：Compose 使用的本地账号变量。
- `docker-config/mmc/`：麦麦本体和模型配置。
- `docker-config/napcat/`、`data/qq/`：麦麦 NapCat 配置和 QQ 登录状态。
- `data/MaiMBot/`：数据库、插件、日志和其他持久数据。

上述本地文件不得提交或粘贴到聊天中。检查时只输出字段是否存在、列表数量和连接
状态，不打印真实值。

## Token 获取方法

下面的命令把 Token 直接复制到剪贴板，不在终端打印。

### 铃铃酱 NapCat WebUI Token

```bash
cd /Users/why/code/my-project/qq-bots/lingling-bot
node -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync("data/napcat/config/webui.json","utf8"));process.stdout.write(d.token)' | pbcopy
```

然后打开 `http://127.0.0.1:17099/webui`，粘贴并登录。

### 麦麦 NapCat WebUI Token

```bash
cd /Users/why/code/my-project/qq-bots/MaiBot
node -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync("docker-config/napcat/webui.json","utf8"));process.stdout.write(d.token)' | pbcopy
```

然后打开 `http://127.0.0.1:16099/webui`，粘贴并登录。

### 麦麦 MaiBot WebUI Access Token

```bash
cd /Users/why/code/my-project/qq-bots/MaiBot
node -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync("data/MaiMBot/webui.json","utf8"));process.stdout.write(d.access_token)' | pbcopy
```

然后打开 `http://127.0.0.1:18001`，粘贴并登录。

OneBot Token 不是 WebUI 登录密码：铃铃酱的 `.env.local` 中
`ONEBOT_ACCESS_TOKEN` 必须与 `data/napcat/config/onebot11_*.json` 一致；麦麦的
适配器 Token 必须与它自己的 NapCat 配置一致。PackyAPI Key 只属于麦麦模型配置，
不能填到任何 WebUI 登录页面。

## 最常用命令

推荐直接在共同父目录统一管理：

```bash
cd /Users/why/code/my-project/qq-bots
pnpm start
pnpm status
pnpm restart
pnpm stop
pnpm bots:login
```

`pnpm status`/`pnpm bots:status` 会先显示四个 Compose 容器，再分别通过 OneBot
`get_status` 输出麦麦和铃铃酱的真实 QQ 连接状态。即使 NapCat 容器仍在运行，
QQ 登录态失效也会显示为离线；探针不会输出 OneBot Token。

`pnpm bots:login` 会检查两个机器人，只为离线账号重启对应 NapCat 并打开新二维码；也可
使用 `pnpm login:lingling` 或 `pnpm login:maibot` 单独处理。

在铃铃酱项目中可一次管理两套机器人：

```bash
cd /Users/why/code/my-project/qq-bots/lingling-bot
pnpm bots:start
pnpm bots:status
pnpm bots:restart
pnpm bots:stop
```

这些命令要求 MaiBot 位于同级目录 `/Users/why/code/my-project/qq-bots/MaiBot`。`bots:start`
先启动麦麦，再构建并启动铃铃酱；`bots:stop` 对两套 Compose 执行 `down`，不会删除
持久化数据。

只管理铃铃酱：

```bash
pnpm docker:start
pnpm docker:status
pnpm docker:logs
pnpm docker:login
pnpm docker:restart
pnpm docker:stop
```

`docker:logs` 会持续跟踪铃铃酱两个容器，按 `Control + C` 只退出日志查看，不会停止
机器人。`docker:login` 会只重启铃铃酱 NapCat、等待生成新的本地二维码图片并自动
打开；不要打开 NapCat 日志里的 QQ 跳转链接，它在电脑浏览器中通常会进入下载页。

只管理麦麦：

```bash
cd /Users/why/code/my-project/qq-bots/MaiBot
docker compose up -d
docker compose ps
docker compose logs --tail=100 core
docker compose down
```

不要使用 `pkill node`、`killall QQ`、无目标的 `docker rm` 或 `docker system prune`，
否则可能误停主号 QQ、另一套机器人或删除仍需使用的数据。

## 电脑重启后的操作

1. 启动 Docker Desktop，等待引擎就绪。
2. 在铃铃酱项目执行 `pnpm bots:start`。
3. 执行 `pnpm bots:status`，确认四个容器均运行，且两个 `QQ 连接` 都为在线。
4. 若某个 QQ 登录失效，打开对应 NapCat WebUI 重新扫码。
5. 用主号分别私聊两个机器人，再在目标群分别 `@` 测试。

Compose 的重启策略会在 Docker Desktop 恢复后自动拉起已有容器；如果之前执行了
`bots:stop`/`docker compose down`，仍需再次执行 `pnpm bots:start`。Docker 容器不能
阻止 Mac 睡眠，电脑睡眠、断网或 Docker Desktop 退出期间两个机器人都无法回复。

## 首次迁移铃铃酱 NapCat

1. 把原生 NapCat 的账号配置复制到 `data/napcat/config/`。
2. 把铃铃酱的 OneBot WebSocket 服务器改为 `0.0.0.0:3001`；Token 保持不变。
3. 在 `.env.local` 增加 `NAPCAT_QQ_ACCOUNT`，不要提交该文件。
4. 精确停止旧的原生 NapCat 小号和本机 Node 核心，不影响正常主号 QQ。
5. 执行 `pnpm docker:start`；首次进入 Linux QQ 容器通常需要重新扫码。
6. 登录成功后，QQ 状态会保存在 `data/napcat/qq/`，以后重启通常无需重复扫码。

不要同时运行同一小号的原生 NapCat 与 Docker NapCat，也不要同时运行本机
`node dist/index.js` 与 `lingling-bot-core`，否则会出现登录互踢或重复回复。

## 排障顺序

1. `pnpm bots:status`：确认四个容器状态和两个 QQ 的真实在线状态。
2. 铃铃酱 `pnpm docker:logs`：确认出现“已连接 NapCat WebSocket”和“机器人已就绪”。
3. 麦麦 `docker compose logs --tail=100 core`：确认适配器与消息网关已连接。
4. WebUI 打不开时先核对端口：铃铃酱 `17099`、麦麦 NapCat `16099`、麦麦 `18001`。
5. WebUI 能开但 QQ 离线时，在对应页面重新扫码，不要改另一套机器人的配置。
6. 铃铃酱 QQ 在线但不回复时，核对 OneBot Token、白名单和容器日志；容器内地址应为
   `ws://napcat:3001`，不是 `127.0.0.1:3001`。
7. 铃铃酱 Codex 失败时，先在宿主机运行 `codex login status`，再检查容器日志；不要
   把 `~/.codex`、登录信息或 Token 复制到项目提交中。

## 验收标准

- `pnpm bots:status` 中麦麦和铃铃酱共四个容器均运行，两个 `QQ 连接` 均为在线。
- 铃铃酱日志显示 OneBot 已连接、核心已就绪，并能完成文字、识图和生图测试。
- 麦麦日志显示 NapCat 适配器和消息网关已连接。
- 主号分别私聊两者可独立回复，目标群中分别 `@` 也可回复。
- 两个机器人没有互相循环接话；若发生循环，先停其中一套再增加忽略规则。

MaiBot 与 NapCat Docker 官方参考：

- https://docs.mai-mai.org/manual/deployment/docker
- https://docs.mai-mai.org/manual/adapters/napcat
- https://github.com/NapNeko/NapCat-Docker
