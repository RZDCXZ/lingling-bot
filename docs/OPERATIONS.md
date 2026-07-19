# QQ AI 机器人运维与交接

本文记录当前部署结果和可重复执行的维护流程。所有真实 QQ 号、群号和密钥只保存在 `.env.local` 或 NapCat 本地配置中，不在文档中出现。

## 1. 当前部署快照

最后更新：2026-07-19。

| 项目 | 当前状态 |
| --- | --- |
| QQ 接入 | 普通专用小号 + NapCat + OneBot 11 正向 WebSocket |
| 主号与小号 | macOS 上可同时运行；主号使用正常 QQ 界面，小号由 NapCat 后台运行 |
| AI 服务 | 本机 Codex CLI，使用本机已有的 ChatGPT 登录 |
| 模型与模式 | `gpt-5.6-luna` + medium reasoning + 非交互临时任务 |
| 私聊 | 1 个白名单好友，可直接发送文字或图片 |
| 群聊 | “杀鸡练习生测试”已加入群白名单；`@铃铃酱` 必定回复，普通话题按策略判断是否加入，并支持救场、冷场续聊、热点和轻量表情 |
| 人设 | 森林系猫娘“铃铃酱”，完整内容见 `docs/PERSONA.md` |
| 图片输入 | JPG、PNG、WebP、GIF；单张最多 8 MB，一次最多 4 张 |
| 图片输出 | 支持 Codex 生成/编辑图片，单次最多回传 1 张，按 OneBot 图片消息发送 |
| 会话 | 每位好友或“群 + 成员”独立，默认保留最近 8 轮，闲置 24 小时过期 |
| 最近历史验收 | 私聊文字、私聊图片、双 QQ、入群、自我介绍和群白名单均通过；Codex 迁移后需按第 9 节复验 |
| 当前代码验收 | 类型检查、构建、16 个测试文件 89 项测试，以及 `gpt-5.6-luna` + `medium` 真实 Codex 文字探针均通过；主动互动的真实群触发仍需观察 |

自我介绍已经由铃铃酱账号发送并在主号 QQ 界面确认：

> 哥哥们好呀，我是铃铃酱，是刚来群里的森林系 AI 猫娘 ฅ^•ﻌ•^ฅ 平时可以陪哥哥们聊天、接梗、看图，也能帮忙回答各种问题。想找我时 @铃铃酱 就好，请多关照喵~

## 2. 实际架构

```text
主号私聊 / 白名单群消息
                ↓
        专用 QQ 小号（NapCat）
                ↓ OneBot 11 WS，127.0.0.1:3001
          本项目 Node.js 进程
                ↓ 受限 codex exec
  gpt-5.6-luna / 搜索 / 识图 / 生成与编辑图片
                ↓
  OneBot 回复私聊、原群消息或自然群发言
```

当前方案不是 QQ 开放平台官方群机器人。早期开放平台代码保留在 `legacy/qq-open-platform/`，只用于参考。

## 3. 配置边界

实际配置文件是 `.env.local`，已被 `.gitignore` 忽略，必须保持 `chmod 600`。新会话需要确认配置时，只读取必要字段并输出脱敏摘要，不要打印整个文件。

主要字段：

```dotenv
ONEBOT_WS_URL=ws://127.0.0.1:3001
ONEBOT_ACCESS_TOKEN=本机私密值
ONEBOT_ALLOWED_PRIVATE_USER_IDS=逗号分隔的好友QQ号
ONEBOT_ALLOWED_GROUP_IDS=逗号分隔的群号

CODEX_COMMAND=codex
CODEX_MODEL=gpt-5.6-luna
CODEX_REASONING_EFFORT=medium
CODEX_LIVE_SEARCH=true
CODEX_TIMEOUT_MS=300000
CODEX_MAX_CONCURRENT=2
CODEX_MAX_QUEUE=12
AI_SYSTEM_PROMPT="多行铃铃酱人设"
CONVERSATION_MAX_TURNS=8
CONVERSATION_TTL_MS=86400000
GROUP_PARTICIPATION_ENABLED=true
GROUP_PARTICIPATION_MIN_MESSAGES=3
GROUP_PARTICIPATION_COOLDOWN_MS=120000
GROUP_PARTICIPATION_PROBABILITY=0.3
GROUP_PARTICIPATION_CONTEXT_MESSAGES=8
GROUP_OLD_JOKE_MEMORY_MESSAGES=30

PROACTIVE_ENGAGEMENT_ENABLED=true
PROACTIVE_TIME_ZONE=Asia/Singapore
PROACTIVE_ACTIVE_START=09:00
PROACTIVE_ACTIVE_END=23:30
PROACTIVE_DAILY_TEXT_LIMIT=4
PROACTIVE_TEXT_COOLDOWN_MS=600000
PROACTIVE_UNANSWERED_ENABLED=true
PROACTIVE_UNANSWERED_DELAY_MS=180000
PROACTIVE_REVIVAL_ENABLED=true
PROACTIVE_REVIVAL_MIN_SILENCE_MS=3600000
PROACTIVE_REVIVAL_MAX_SILENCE_MS=7200000
PROACTIVE_REVIVAL_PROBABILITY=0.2
PROACTIVE_HOT_TOPIC_ENABLED=true
PROACTIVE_HOT_TOPIC_INTERVAL_MS=86400000
PROACTIVE_HOT_TOPICS=AI,明日方舟：终末地,绝区零,异环,鸣潮

GROUP_REACTION_ENABLED=true
GROUP_REACTION_PROBABILITY=0.12
GROUP_REACTION_COOLDOWN_MS=300000
GROUP_REACTION_DAILY_LIMIT=12
GROUP_REACTION_EMOJI_IDS=14,66,76
```

安全约束：

- 群白名单与私聊白名单至少配置一项。
- 机器人不会响应非白名单私聊，也不会监听非白名单群。白名单群内 `@` 消息直接
  处理；普通消息只进入有界群聊参与上下文，并受门槛、概率、冷却和 Codex 潜水
  判断控制。
- 机器人子进程采用只读临时工作区、`approval=never`、临时会话；关闭 Shell、文件修改、应用、插件、电脑控制、多代理等能力，只保留网页搜索、识图和图片生成/编辑。
- `@` 消息和图片会交给 Codex；群聊互动判断触发时，通常使用 8 条最近消息，旧梗
  模式还可能附带最多 4 条较早片段。不应让机器人处理密码、证件或其他敏感信息。
- `.env.local` 不再需要 PackyAPI 地址、密钥、模型或接口模式；旧字段即使暂时保留也不会被当前入口读取，清理前仍按敏感值处理。

## 4. 日常启动顺序

项目目录：`/Users/why/code/my-project/qq-group-ai-bot`。

### 4.1 正常主号 QQ

从 Dock 或“应用程序”正常打开 QQ。磁盘上的 QQ 入口应始终保持原版，主号界面不依赖 NapCat。

### 4.2 NapCat 小号

先检查是否已经存在 NapCat 小号进程；没有时在项目目录运行：

```bash
pnpm qq:start-napcat:macos
```

脚本会从 NapCat 的 `onebot11_*.json` 配置自动识别唯一小号。若以后存在多个小号配置，需要仅在本机指定：

```bash
NAPCAT_QQ_ACCOUNT=小号QQ号 pnpm qq:start-napcat:macos
```

小号由 NapCat 在后台运行，看不到完整 QQ 窗口是正常现象；正常 QQ 主号仍可使用完整界面。

验证双启动保护：

```bash
pnpm qq:verify-macos
```

该检查会确认基础入口和当前热更新入口都已恢复为 QQ 原版，并检查瞬时注入加载器的恢复逻辑。不要手工编辑 QQ 的 `package.json`。

### 4.3 Node 机器人

首次安装或代码有改动时：

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

启动前确认本机 Codex 可用：

```bash
codex --version
codex login status
```

启动：

```bash
pnpm start
```

成功日志应同时包含：

```text
[onebot] 已连接 NapCat WebSocket
[app] QQ AI 机器人已就绪
```

并确认日志中的 `allowedGroupCount`、`allowedPrivateUserCount` 与预期一致。不要启动两个 Node 机器人实例，否则同一条消息可能被重复处理。

## 5. 安全重启

只修改 `.env.local` 不需要重新构建，但必须重启 Node 机器人；修改 `src/` 后必须先 `pnpm build`。

日常直接使用项目命令：

```bash
pnpm status
pnpm stop
pnpm restart
```

`pnpm stop` 只关闭本项目的 Node AI 机器人，NapCat 小号继续在线；`pnpm restart`
会先安全关闭旧实例，再像 `pnpm start` 一样在当前终端运行新实例。管理脚本同时
核对进程命令与工作目录，不依赖模糊的 `pkill node`。

只有管理命令自身失效时，才手工使用 `ps`、`lsof` 核对 PID、命令和工作目录，
再对已确认的机器人 PID 执行 `kill -TERM PID`。

不要停止以下对象：

- `/Applications/QQ.app/...` 的正常主号 QQ。
- `scripts/macos/launch-napcat.mjs` 对应的 NapCat 小号启动器。
- 其他项目中同样名为 `dist/index.js` 的 Node 服务。

重启会清空内存会话，群成员需要重新开始上下文；白名单和人设不会丢失。当前默认
每位成员保留最近 8 轮，最后一次访问后 24 小时未互动才过期。群聊互动按群在内存
保留最多 30 条短期消息，重启后同样清空。每日主动次数、冷却时间、下次热点时间
和最近 3 次热点摘要保存在 `data/group-engagement-state.json`，重启后继续生效，
但其中不保存群友聊天正文。

## 6. 添加新群

只有用户明确指定目标群并授权后才执行。

1. 在正常主号 QQ 中打开目标群，点击“邀请加群”，选择机器人小号。
2. 正式点击“确定”前再次核对目标群和小号，因为入群会让小号持续接收该群消息。
3. 入群后通过 NapCat 的 OneBot `get_group_list` 查询真实 `group_id`，不要根据群名猜测。
4. 将群号追加到 `.env.local` 的 `ONEBOT_ALLOWED_GROUP_IDS`，多个群号使用英文逗号分隔。
5. 用 `loadConfig()` 输出布尔值或数量进行脱敏校验，不打印白名单原值和密钥。
6. 按“安全重启”步骤重启机器人，日志中群白名单数量应增加。
7. 在群内使用 `@铃铃酱 你好` 验证直接回复；再用多人普通聊天验证参与模式只会
   偶尔接话，不会每条都回复。

主动发送入群自我介绍时，使用 OneBot `send_group_msg`，消息格式使用数组：

```js
await client.call("send_group_msg", {
  group_id: targetGroupId,
  message: [{ type: "text", data: { text: introduction } }],
});
```

发送消息属于外部操作，必须有用户对具体群和消息目的的明确授权。发送后用主号 QQ 界面或 OneBot 返回的 `message_id` 核验。

## 7. 修改人设或回复规则

当前人设副本见 `docs/PERSONA.md`，实际运行值是 `.env.local` 中的多行
`AI_SYSTEM_PROMPT`，代码默认值位于 `src/persona.ts`，`.env.example` 提供同一版本。

1. 只替换 `.env.local` 的 `AI_SYSTEM_PROMPT`，不要改动同文件中的 Token、Key 和白名单。
2. 同步更新 `docs/PERSONA.md`、`src/persona.ts` 和 `.env.example`；
   `tests/persona-sync.test.ts` 会逐字核对三个已提交副本。
3. 使用 `loadConfig()` 检查提示词能成功解析；输出名称存在、规则存在和长度等摘要即可。
4. 重启 Node 机器人。
5. 连续用玩笑吐槽、普通闲聊和认真求助三类输入测试，确认语气、句式和长度有变化，
   同时仍能识别“铃铃酱”身份。

模型提示词是行为引导而非绝对安全边界。需要百分之百保证的规则应在代码中实现，而不是只写提示词。当前 `/帮助`、`/重置`、限流和错误提示是程序直接回复，不经过人设模型。

### 群聊参与模式

该模式只作用于白名单群。`src/group-participation.ts` 在内存中保存每群最多 30 条
短期消息；默认累计 3 条群友消息后获得一次 30% 的 Codex 判断机会。每次使用最近
8 条，必要时附加最多 4 条较早片段做“旧梗回旋镖”。文字中直接叫“铃铃酱”时会
立即获得判断机会，面向全群的问题会提高判断概率。机器人发言后冷却 2 分钟，
Codex 输出 `[[SILENT]]` 时保持潜水；只有带 `[[REPLY]]` 的输出才会作为不引用、
不 `@` 成员的普通群消息发送。

参与判断期间如果话题快速推进超过两条新消息，旧回复会被丢弃。被动参与禁止生成
或编辑图片；需要生图必须明确 `@铃铃酱` 或私聊请求。

通过以下变量调整或关闭：

```dotenv
GROUP_PARTICIPATION_ENABLED=true
GROUP_PARTICIPATION_MIN_MESSAGES=3
GROUP_PARTICIPATION_COOLDOWN_MS=120000
GROUP_PARTICIPATION_PROBABILITY=0.3
GROUP_PARTICIPATION_CONTEXT_MESSAGES=8
GROUP_OLD_JOKE_MEMORY_MESSAGES=30
```

### 主动聊天组合

主动调度只在 `09:00`～`23:30`（`Asia/Singapore`）运行，并遵守每群每天 4 条主动
文字、主动文字间隔至少 10 分钟的总闸门。明确 `@铃铃酱` 的回复和私聊不占这 4 条。
每天的计数按配置时区归零。

- 无人回答救场：开放式问题 3 分钟内没有任何群友接话时，Codex 判断是否引用原
  消息救场；只要有人继续说话就取消，避免抢答。
- 冷场续聊：最后一条群消息后随机等待 1～2 小时，再以 20% 概率尝试一次；同一
  次冷场不会反复试探，也不发送“有人吗”。
- 热点投喂：每 24 小时最多尝试一次，范围是 AI、终末地、绝区零、异环和鸣潮。
  Codex 必须搜索最近 48 小时、交叉核验并附来源；没有值得聊的消息就潜水。首次
  启动随机等待 1～3 小时，且群里至少要出现 3 条新的群友消息。
- 旧梗回旋镖：较早片段只在与当前话题有清晰呼应时使用，不生硬翻旧账。
- 轻量表情：对普通群消息先按 12% 本地概率抽样，再由 Codex 从配置的 QQ 表情 ID
  中选择一个或潜水；默认 5 分钟冷却、每天每群最多 12 个。它不会发送颜文字或
  表情包，也不会给问题、争执、负面内容或命令乱点表情。

`PROACTIVE_ENGAGEMENT_ENABLED=false` 会关闭定时救场、冷场续聊、热点及主动时段
限制；普通话题参与和轻量表情仍可分别用 `GROUP_PARTICIPATION_ENABLED`、
`GROUP_REACTION_ENABLED` 独立关闭。

## 8. 图片识别、生成与编辑流程

1. `src/onebot/message.ts` 从 OneBot 数组消息或 CQ 字符串中保留 `image` 段。
2. `src/onebot/image-loader.ts` 优先读取 NapCat 本地缓存路径，其次读取受信任的 QQ 图片域名，缺少直链时调用 `get_image`。
3. 图片会验证真实文件签名，再转换成 data URL；不信任扩展名或普通网页返回的 MIME 声明。
4. 当前限制为单张 8 MB、一次 4 张、总计 16 MB，仅允许 JPG、PNG、WebP 和 GIF。
5. `src/ai/codex-cli-ai.ts` 把验证后的 data URL 写入权限为 `600` 的单次临时文件，并通过 `codex exec --image` 传给 Codex；任务结束后删除临时工作区。
6. 用户明确要求生成或编辑图片时，Codex 调用内置图片生成功能。程序从 JSONL 的 `thread.started` 取得任务 ID，只读取 `~/.codex/generated_images/<thread-id>/` 下本次任务的图片，因此并发请求不会串图。
7. 生图要求中若出现不确定或不能按字面确定指代的网络梗、缩写、谐音、圈内称呼或专有词，Codex 必须先实时搜索并对照至少两条当前结果。仍有多义时先追问，本轮不生成；不能把词拆字后擅自拼成物件。
   当前群内约定“咕咕嘎嘎”默认指《明日方舟：终末地》的企鹅相关梗，但每次生图前仍需搜索当前视觉语境。
8. 生成图读取为 data URL 后，任务生成目录会清理；`src/onebot/reply.ts` 将其转换为 `base64://` OneBot 图片段并发送到 QQ，而不是把路径当文字回复。
9. 图片二进制不写入会话记忆。后续对话只保留“本轮附带图片”的文字标记、用户要求和 AI 文字回答。

若图片失败，先做纯文字 Codex 对照，再检查输入图片格式/大小、`codex login status`、额度和网络。图片生成通常需要一至数分钟，默认超时为 5 分钟。

## 9. 验证清单

代码修改后：

```bash
pnpm typecheck
pnpm test
pnpm build
```

macOS 启动逻辑修改后：

```bash
pnpm qq:verify-macos
```

实机验收按风险选择执行：

- 白名单主号私聊文字，确认 Codex 回复且保持铃铃酱人设。
- 询问当天最新信息，确认回复含可打开的来源链接。
- 私聊普通 JPG/PNG，确认能识别图片。
- 私聊发送“画一张绿色卡通猫爪”，确认 QQ 收到文字和真正的图片消息，而非本机路径。
- 附图发送“把背景改成夜晚”，确认返回编辑后的图片。
- 正常主号 QQ 与 NapCat 小号同时在线。
- 白名单群 `@铃铃酱` 时回复原消息；普通聊天满足参与条件时最多偶尔自然接话，
  不引用原消息也不 `@` 某位成员。
- 用测试配置缩短等待后，确认无人回答救场会引用原问题，随后有群友接话则取消。
- 确认冷场与热点不会在启动后立刻刷屏，热点正文带可打开的来源链接。
- 确认轻量回应调用 QQ 消息表情，而不是发送颜文字、表情包或额外文字。
- `/重置` 后旧上下文不再进入下一次请求。
- 人设连续测试至少覆盖玩笑、闲聊和认真求助；三次回复不应都称呼“哥哥”、都走
  可爱风或都以“喵~”结尾，认真求助必须收起玩梗。

本项目测试包含一个临时监听本机随机端口的 WebSocket 测试；受限沙箱中若出现 `listen EPERM`，应在获得权限后重跑完整测试，不能把它当作业务代码失败。

## 10. 常见故障

### 普通 QQ 出现 `installPathPkgJson` JavaScript 错误

这是旧式 NapCat 注入残留或 QQ 更新入口未恢复造成的。不要继续手工改包。先运行 `pnpm qq:verify-macos`，再使用 `pnpm qq:start-napcat:macos` 的瞬时注入流程。当前加载器会在 NapCat 启动后立即恢复原版入口，并在失败时兜底恢复。

### NapCat 小号没有完整 QQ 界面

当前双启动设计中这是正常的：主号使用正常 QQ 界面，小号在 NapCat 后台运行。通过 WebUI、OneBot 端口和项目日志判断小号状态。

### `ECONNREFUSED 127.0.0.1:3001`

NapCat 未启动、正向 WebSocket 未启用或端口配置不一致。先检查 NapCat，再启动 Node 项目。

### 群内没有回复

明确 `@` 时，依次确认：小号仍在群内、群号已进白名单、消息确实 `@` 了小号、
Node 日志显示群白名单数量正确、Codex 没有报错。

普通聊天时，确认 `GROUP_PARTICIPATION_ENABLED=true`。默认必须累计 3 条、通过 30%
本地抽样、超过 2 分钟冷却，而且 Codex 仍可选择潜水，因此短时间没接话属于正常
防刷屏行为。查看日志中是否出现“群聊参与判断失败”，不要为了验证把概率长期调成
`1`。

救场、冷场、热点或轻量表情没有触发时，还要检查当前是否在主动时段、当日上限
是否用完，以及 `data/group-engagement-state.json` 中的下一次热点时间。排障时只
输出计数和时间，不要把 `.env.local` 或群聊正文写进日志。首次启动的热点会随机
等待 1～3 小时，不应为了测试直接向真实群发送消息。

### 人设没有更新

确认修改的是 `.env.local` 而非 `.env.example`，多行双引号正确闭合，并重启 Node 机器人。代码没有变化时不必重新构建。

### Codex 提示未登录、额度不足或调用失败

运行 `codex login status`。未登录时由机器所有者执行 `codex login`；已登录则检查 ChatGPT/Codex 额度、网络和 `codex --version`。不要把登录凭据写入 `.env.local`。

### 文字成功但图片生成超时

图片生成比普通文字慢。先用简单提示词重试，确认 `CODEX_TIMEOUT_MS` 至少为 `300000`；仍失败时查看 Node 日志和独立 `codex exec` 图片探针。不要为了绕过超时而开启 Shell 或电脑控制权限。

## 11. 新会话接手清单

1. 阅读 `AGENTS.md`、本文件和 `docs/PERSONA.md`。
2. 确认工作目录是 `/Users/why/code/my-project/qq-group-ai-bot`。
3. 不打印 `.env.local`；通过 `loadConfig()` 读取并只输出 Codex 模型、推理等级、
   搜索开关、白名单数量、群聊参与参数和人设布尔检查。
4. 检查正常 QQ、NapCat 小号和 Node 机器人是否仍在运行，避免重复启动。
5. 先复现问题，再修改最小范围。
6. 完成后执行与风险相称的测试、构建和实机验证，并把新的持久事实同步回本文。
