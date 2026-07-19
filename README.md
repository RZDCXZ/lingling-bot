# QQ AI 机器人

通过 NapCat 的 OneBot 11 WebSocket 控制一个普通 QQ 小号，并把白名单好友的
私聊消息、白名单群内的 `@机器人` 消息，以及符合参与条件的群聊话题交给本机
Codex。文字聊天、实时搜索、图片识别以及图片生成/编辑全部走 Codex CLI，不再
调用 PackyAPI。

> NapCat/OneBot 不是 QQ 开放平台官方群机器人通道，存在登录验证、掉线、
> 账号限制或封号风险。只使用专门的小号，不要使用主 QQ，也不要在同一设备上
> 高频操作多个账号。

## 维护与交接

后续新 AI 会话或人工维护时，先阅读：

- [`AGENTS.md`](AGENTS.md)：当前完成状态、协作约束和代码导航
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md)：启动、重启、加群、改人设、验证和排障流程
- [`docs/PERSONA.md`](docs/PERSONA.md)：铃铃酱当前人设的非敏感副本

真实 QQ 号、群号和 Token 只保存在本机 `.env.local` 或 NapCat 配置中，不写入
上述文档。Codex 使用本机已有的 ChatGPT 登录，不需要在项目里保存 AI API Key。

## 当前能力

- 主动连接 NapCat 正向 WebSocket，无需公网 IP 或回调地址
- 私聊只响应配置的好友 QQ 号；群聊只监听白名单群
- 群内 `@机器人` 时必定处理；未 `@` 时累计最近群聊，由 Codex 判断是否自然加入
- 默认每累计 3 条群友消息获得一次 30% 的判断机会，机器人发言后冷却 2 分钟
- 支持无人回答救场、冷场续聊、早间情报雷达、晚间批斗大会、旧梗回旋镖和 QQ 消息表情轻回应
- 每天中国时间 `08:00` 发送成都天气、实用建议和 AI/二游情报；`21:00` 按群友当天全部缓存发言的整体表现选一人，直接发一条友好批斗和吐槽，没有合适人选就跳过
- Codex 会根据真实原话决定正常吐槽或使用无厘头罪名；不硬凑、不编造黑料
- 支持 `21:50` 私聊指定主号征集“延年益寿”图片，`22:00` 由 Codex 逐图审核后把安全投稿和暧昧但不露骨的配文发到显式目标群；没有合格投稿就跳过
- 三个固定任务的群消息都会显式带上 `【情报雷达】`、`【批斗大会】` 或 `【延年益寿】` 标题
- 主动文字默认每天每群最多 4 条；救场、冷场等普通主动互动在 `09:00`～`23:30` 工作
- 使用受限的本机 Codex CLI，默认模型为 `gpt-5.6-luna`，推理深度为 `medium`
- 支持实时网页搜索；需要最新信息时由 Codex 主动搜索并在回复中给出来源链接
- 支持图片识别：纯图片、文字加图片以及一次多图
- 支持按群友要求生成图片，以及结合附加图片进行编辑；生成结果会作为真正的 QQ 图片发送
- 每个私聊好友或“群 + 成员”独立保留最近 20 轮对话，避免串上下文
- `/重置` 清除自己的当前对话，`/帮助` 查看用法
- 消息去重、成员/群/全局限流、同一成员串行排队、长回复自动分段
- 群聊回复原消息并 @提问者；私聊直接回复
- 支持通过 `AI_SYSTEM_PROMPT` 自定义名字、人设、语气和回复规则
- 铃铃酱会随话题在松弛、吐槽、冷幽默、发癫、兴奋和认真之间切换；可爱、称呼
  “哥哥”和“喵~”只作偶尔点缀，不再套用固定模板
- 当前完整人设在 `.env.local`、`src/persona.ts`、`.env.example` 和
  `docs/PERSONA.md` 中保持逐字一致，并由测试防止已提交副本漂移
- 群聊内容不能启用 Codex 的 Shell、文件修改、应用、插件或电脑控制工具
- OneBot Token 和好友/群白名单只从本地环境变量读取

## 数据流

```text
主账号私聊专用QQ小号 / 白名单群消息
        ↓
      NapCat
        ↓ OneBot 11 WebSocket
    本项目 Node.js 程序
        ↓ 受限的非交互 Codex CLI
  聊天 / 网页搜索 / 识图 / 生图
```

## 环境要求

- macOS、Windows 或 Linux
- Node.js 22 或更高版本
- pnpm 11
- 一个专门用于机器人的 QQ 小号
- NapCat（macOS 可使用当前 Release 中的 DMG）
- 已安装并登录的 Codex CLI（运行 `codex login status` 应显示已登录）

NapCat 下载与文档：

- [NapCat Releases](https://github.com/NapNeko/NapCatQQ/releases)
- [NapCat WebUI 配置](https://napneko.github.io/config/basic)
- [OneBot 11 事件格式](https://napneko.github.io/onebot/basic_event)

Codex 运行与安全参考：

- [Codex 非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Codex 沙箱与审批](https://learn.chatgpt.com/docs/agent-approvals-security)

## 1. 配置 NapCat

1. 安装并启动 NapCat，使用手机 QQ 扫码登录专用小号。
2. 打开启动日志给出的 WebUI 地址；默认端口通常为 `6099`。
3. 在“网络配置”中新建 **WebSocket 服务器（正向 WS）**。
4. 使用以下设置：

```text
名称：qq-group-ai-bot
启用：是
主机：127.0.0.1
端口：3001
消息格式：array
上报自身消息：否
Token：生成一个随机且足够长的 Token
```

WebSocket 只监听 `127.0.0.1`，不要把未加密的 OneBot 端口暴露到公网。

### macOS 同时运行主号和 NapCat 小号

项目提供了独立启动脚本。磁盘上的 QQ 默认始终保留原版入口，所以平时从
Dock 或“应用程序”打开 QQ，正常登录和使用主号即可。需要启动机器人小号时，
在项目目录运行：

```bash
pnpm qq:start-napcat:macos
```

脚本会自动识别已经生成 OneBot 配置的小号，短暂切换当前 QQ 热更新入口，
加载 NapCat 后立即恢复原版入口；启动失败时也会在 5 秒内兜底恢复。因此普通
QQ 可以和 NapCat 小号同时运行。若本机存在多个 NapCat 账号配置，可仅在本地
指定小号：

```bash
NAPCAT_QQ_ACCOUNT=小号QQ号 pnpm qq:start-napcat:macos
```

检查 QQ 是否处于可安全双启动的状态：

```bash
pnpm qq:verify-macos
```

QQ 自动更新后，启动脚本会读取当前版本再执行瞬时注入，不需要手工修改新版本
的 `package.json`。

## 2. 配置项目

首次使用时复制模板：

```bash
cp .env.example .env.local
chmod 600 .env.local
```

填写 `.env.local`：

```dotenv
ONEBOT_WS_URL=ws://127.0.0.1:3001
ONEBOT_ACCESS_TOKEN=与NapCat中完全一致的Token
ONEBOT_ALLOWED_PRIVATE_USER_IDS=你的主账号QQ号
ONEBOT_ALLOWED_GROUP_IDS=

CODEX_COMMAND=codex
CODEX_MODEL=gpt-5.6-luna
CODEX_REASONING_EFFORT=medium
CODEX_LIVE_SEARCH=true
CODEX_TIMEOUT_MS=300000
CODEX_MAX_CONCURRENT=2
CODEX_MAX_QUEUE=12

GROUP_PARTICIPATION_ENABLED=true
GROUP_PARTICIPATION_MIN_MESSAGES=3
GROUP_PARTICIPATION_COOLDOWN_MS=120000
GROUP_PARTICIPATION_PROBABILITY=0.3
GROUP_PARTICIPATION_CONTEXT_MESSAGES=8
GROUP_OLD_JOKE_MEMORY_MESSAGES=30

PROACTIVE_ENGAGEMENT_ENABLED=true
PROACTIVE_TIME_ZONE=Asia/Shanghai
PROACTIVE_ACTIVE_START=09:00
PROACTIVE_ACTIVE_END=23:30
PROACTIVE_DAILY_TEXT_LIMIT=4
PROACTIVE_UNANSWERED_ENABLED=true
PROACTIVE_UNANSWERED_DELAY_MS=180000
PROACTIVE_REVIVAL_ENABLED=true
PROACTIVE_REVIVAL_MIN_SILENCE_MS=3600000
PROACTIVE_REVIVAL_MAX_SILENCE_MS=7200000
PROACTIVE_REVIVAL_PROBABILITY=0.2
PROACTIVE_HOT_TOPIC_ENABLED=false
PROACTIVE_HOT_TOPIC_INTERVAL_MS=86400000
PROACTIVE_HOT_TOPICS=AI,明日方舟：终末地,绝区零,异环,鸣潮

MORNING_RADAR_ENABLED=true
MORNING_RADAR_TIME=08:00
MORNING_RADAR_CATCH_UP_END=09:00
MORNING_RADAR_LOCATION=中国四川成都

DAILY_ROAST_ENABLED=true
DAILY_ROAST_TIME=21:00
DAILY_ROAST_CATCH_UP_END=22:00
DAILY_ROAST_MIN_MESSAGES=3
DAILY_ROAST_MAX_MESSAGES=120

DAILY_LONGEVITY_ENABLED=false
DAILY_LONGEVITY_SUBMITTER_USER_ID=指定投稿主号
DAILY_LONGEVITY_TARGET_GROUP_IDS=显式目标群号
DAILY_LONGEVITY_REMINDER_TIME=21:50
DAILY_LONGEVITY_SEND_TIME=22:00
DAILY_LONGEVITY_CATCH_UP_END=22:10
DAILY_LONGEVITY_MAX_IMAGES=6

GROUP_REACTION_ENABLED=true
GROUP_REACTION_PROBABILITY=0.12
GROUP_REACTION_COOLDOWN_MS=300000
GROUP_REACTION_DAILY_LIMIT=12
GROUP_REACTION_EMOJI_IDS=14,66,76
```

私聊测试通过后，把目标群号加入群白名单；多个号码使用英文逗号分隔：

```dotenv
ONEBOT_ALLOWED_PRIVATE_USER_IDS=123456789
ONEBOT_ALLOWED_GROUP_IDS=123456789,987654321
```

两个白名单至少填写一个。私聊不需要 `@`；群聊中 `@机器人` 会直接触发，普通
消息则只用于群聊参与模式。普通消息先经过本地门槛、冷却和概率控制，满足条件后
才把最多 8 条最近群聊交给 Codex；Codex 可以返回 `[[SILENT]]` 继续潜水。

程序会把 QQ 图片验证后写入单次临时工作区，再通过 Codex 的 `--image` 输入。
支持 JPG、PNG、WebP 和 GIF，单张最多 8 MB、一次最多 4 张。Codex 生成的图片
会从该次任务的独立生成目录读取为内存数据，发送成功后不会加入会话记忆。

首次启动前检查：

```bash
codex --version
codex login status
```

不要把 `.env.local` 或 OneBot Token 提交到 Git，也不要粘贴到聊天中。

## 3. 安装与运行

先启动 NapCat，再运行本项目：

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

开发时可用：

```bash
pnpm dev
```

日常管理机器人：

```bash
pnpm status   # 查看 Node 机器人是否运行
pnpm stop     # 安全关闭 AI 回复，NapCat 小号保持在线
pnpm restart  # 安全重启并继续在当前终端运行
```

这些命令只匹配本项目工作目录中的 `node dist/index.js`，不会关闭普通 QQ、
NapCat 小号或其他项目的 Node 服务。`pnpm start` 和 `pnpm restart` 一样需要保持
当前终端运行；按 `Control + C` 也可以停止。

日志出现 `已连接 NapCat WebSocket` 和 `机器人已就绪` 后，先用白名单中的
主账号私聊专用小号：

```text
你好，只回复“私聊测试成功”
```

后续启用群聊后，在白名单群中发送：

```text
@机器人 你好，请介绍一下你自己
```

群聊参与模式默认开启。群友正常聊满至少 3 条后，机器人有机会在不引用消息、
不 `@` 某个人的情况下接住话题；直接在文字里叫“铃铃酱”会提高判断机会。它不会
固定回复每一轮，Codex 判断不适合插话时保持安静。需要完全关闭可设置：

```dotenv
GROUP_PARTICIPATION_ENABLED=false
```

主动互动默认还包含：开放式问题 3 分钟无人接话时救场；冷场 1～2 小时后以 20%
概率尝试续聊；每 24 小时尝试一次指定领域热点；偶尔给合适的普通消息加一个 QQ
表情。热点首次启动会随机等待 1～3 小时，且群里至少要有 3 条新的群友消息，避免
机器人刚启动就自说自话。所有文字模式仍由 Codex 最终选择发言或 `[[SILENT]]`。

“旧梗回旋镖”只在内存额外保留每群最多 30 条短期消息，从中最多取 4 条较早片段
给 Codex 参考；只有与当前话题明确呼应时才允许翻梗。群聊正文不会写入磁盘。
每日计数、冷却时间和最近 3 次热点摘要写入本地
`data/group-engagement-state.json`，用于重启后继续防刷屏。

也可以在私聊中直接发送图片，或在群里发送 `@机器人 + 图片`。没有附带文字时，
机器人会默认按“请描述这张图片”处理；需要 OCR、排错或比较多张图时，建议同时
写清具体要求。

生成图片示例：

```text
画一张铃铃酱在森林里追蝴蝶的动漫头像，绿色主色调
```

编辑图片时把原图和要求放在同一条消息，例如“把背景改成夜晚，人物保持不变”。
图片生成通常比文字回复慢，默认超时为 5 分钟，也会消耗 Codex/ChatGPT 账号额度。

## 常见问题

### 连接被拒绝或出现 401/403

检查 `ONEBOT_ACCESS_TOKEN` 是否和 NapCat WebSocket 服务器中的 Token 完全一致。

### ECONNREFUSED 127.0.0.1:3001

NapCat 未启动、正向 WebSocket 未启用，或端口不是 `3001`。

### 群里 @机器人但没有回复

检查：

- 专用 QQ 小号是否仍在线并已加入目标群
- 群号是否已写入 `ONEBOT_ALLOWED_GROUP_IDS`
- NapCat 消息上报格式是否为 `array`
- 项目日志是否收到 OneBot 事件或 Codex 错误

### 铃铃酱没有主动加入群友话题

确认 `GROUP_PARTICIPATION_ENABLED=true`。普通群聊不是每次都会触发：默认至少累计
3 条消息、机器人上次发言已超过 2 分钟，并通过 30% 的本地抽样后，才会调用
Codex 判断；Codex 仍可能选择潜水。这是防刷屏设计，不代表机器人掉线。

如果连救场、冷场续聊、热点和表情都没有触发，再检查当前是否处于配置的活跃时段、
是否达到每天每群 4 条主动文字或 12 个消息表情的上限。热点首次启动会等待 1～3
小时，并要求群内已有至少 3 条新消息。

### 好友私聊但没有回复

检查主账号 QQ 号是否已写入 `ONEBOT_ALLOWED_PRIVATE_USER_IDS`，并确认消息发给的
确实是运行 NapCat 的专用小号。机器人不会响应未列入白名单的好友。

### 延年益寿没有提醒、没有收图或没有发群

确认功能已启用，投稿主号同时位于私聊白名单，目标群同时位于群白名单。只有
`21:50`～`22:00` 由指定主号私聊发送的图片才会作为投稿；可用
`/延年益寿状态` 查看缓存数量，或用 `/取消延年益寿` 清空。`22:00` 没有投稿，
或 Codex 判断全部图片不符合“明确成年、非露骨、非真人二次元图片”标准时，群里
不会发送任何内容。

### 图片没有被识别

确认发送的是 JPG、PNG、WebP 或 GIF，且单张不超过 8 MB；再用
`codex login status` 检查本机 Codex 登录。

### Codex 无法回复或无法生成图片

先检查 `codex login status`、ChatGPT/Codex 额度和网络。图片生成可能需要一至数
分钟；若经常超时，可在允许范围内增大 `CODEX_TIMEOUT_MS`。升级 Codex 后先运行
一次受限的文字和图片生成测试，再重启机器人。

## 数据与安全边界

- AI 对话上下文仅保存在进程内存中，重启后自动清空。
- 会话按“私聊好友”或“群 + 成员”隔离，默认最多保留 20 轮，闲置 24 小时自动清理。
- 群聊参与上下文按群隔离，只在内存保存最多 30 条短期消息；每次通常只使用最近
  8 条，并最多附加 4 条较早片段用于旧梗回旋镖。重启后这些正文全部清空。
- `data/group-engagement-state.json` 只持久化每日次数、冷却时间、下次热点时间和
  最近 3 次热点摘要，不保存群友聊天正文；文件权限为 `600`。
- 图片只在当前请求中处理，不把二进制写入会话记忆；后续对话仅保留文字问题和
  AI 回答。重启后所有内存会话仍会清空。
- “延年益寿”投稿图片只在 `21:50`～`22:00` 的当晚内存队列中保存，最多 6 张；
  审核发送后、跨日或进程重启即清空，不写入项目数据文件。
- 群消息和图片会交给本机 Codex 及其后端服务，不要让机器人处理密码、身份信息等
  敏感内容。
- 每次调用使用只读临时目录并关闭 Shell、应用、插件、电脑控制和文件修改能力；
  只保留网页搜索、理解附加图片和图片生成/编辑能力。
- OneBot WebSocket 默认仅允许本机访问，并必须配置 Token。

## 项目结构

```text
src/
├── ai/                         # 受限 Codex CLI 适配器与 AI 窄接口
├── onebot/                     # OneBot WebSocket、事件解析和私聊/群回复
├── config.ts                   # 环境变量校验与好友/群白名单
├── conversation-memory.ts      # 有界、隔离的对话记忆
├── engagement-state.ts         # 主动消息/表情计数与热点调度状态
├── group-chat-handler.ts       # 私聊/群聊命令与 AI 对话编排
├── group-participation.ts      # 普通群聊参与、主动调度、旧梗与表情判断
├── runtime-guards.ts           # 去重、限流和按成员排队
├── create-bot.ts               # NapCat/OneBot 运行时装配
└── index.ts                    # 启动与优雅退出

legacy/qq-open-platform/        # 先前 QQ 开放平台接入源码备份
docs/OPERATIONS.md              # 当前部署、运维、加群、验证和排障
docs/PERSONA.md                 # 铃铃酱人设的非敏感持久副本
AGENTS.md                       # 新 AI 会话首先读取的项目约束与状态
```
