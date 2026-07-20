import { readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AiService } from "../src/ai/types.js";
import { parseConfig } from "../src/config.js";
import { ConversationMemory } from "../src/conversation-memory.js";
import {
  createBotRuntime,
  type OneBotClientPort,
} from "../src/create-bot.js";
import { VolatileEngagementState } from "../src/group-participation.js";
import type { ImageLoader } from "../src/onebot/image-loader.js";
import type { OneBotEventHandler } from "../src/onebot/types.js";

class FakeOneBotClient implements OneBotClientPort {
  readonly callMock = vi.fn().mockResolvedValue({ message_id: "reply-id" });
  readonly stopMock = vi.fn();
  private eventHandler: OneBotEventHandler | undefined;

  async start(eventHandler: OneBotEventHandler): Promise<void> {
    this.eventHandler = eventHandler;
  }

  stop(): void {
    this.stopMock();
  }

  async call<T = unknown>(
    action: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    return (await this.callMock(action, params)) as T;
  }

  async emit(event: unknown): Promise<void> {
    if (!this.eventHandler) throw new Error("client has not started");
    await this.eventHandler(event);
  }
}

function createConfig(overrides: Record<string, string | undefined> = {}) {
  return parseConfig({
    ONEBOT_ACCESS_TOKEN: "onebot-token",
    ONEBOT_ALLOWED_GROUP_IDS: "10001",
    PROACTIVE_ENGAGEMENT_ENABLED: "false",
    GROUP_REACTION_ENABLED: "false",
    ...overrides,
  });
}

describe("OneBot 机器人运行时", () => {
  it("主号随时提交后即使机器人重启也会在二十二点从归档目录读取并发送", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T01:00:00.000Z"));
    const aiImage = {
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      detail: "auto" as const,
    };
    const generateReply = vi
      .fn<AiService["generateReply"]>()
      .mockResolvedValue("[[LONGEVITY:1]]今晚这份养生内容，建议反复观看喵~");
    const load = vi.fn<ImageLoader["load"]>().mockResolvedValue([aiImage]);
    const initialClient = new FakeOneBotClient();
    const archiveRoot = join(
      tmpdir(),
      `qq-bot-create-bot-${process.pid}-${Date.now()}`,
    );
    const runtimeConfig = createConfig({
        ONEBOT_ALLOWED_PRIVATE_USER_IDS: "20002",
        DAILY_LONGEVITY_ENABLED: "true",
        DAILY_LONGEVITY_SUBMITTER_USER_ID: "20002",
        DAILY_LONGEVITY_TARGET_GROUP_IDS: "10001",
        DAILY_LONGEVITY_ARCHIVE_DIR: archiveRoot,
      });
    const initialRuntime = createBotRuntime(
      runtimeConfig,
      { generateReply },
      new ConversationMemory({ maxTurns: 4 }),
      initialClient,
      { load },
    );
    let restartedRuntime: ReturnType<typeof createBotRuntime> | undefined;

    try {
      await initialRuntime.start();
      await vi.advanceTimersByTimeAsync(0);
      initialClient.callMock.mockClear();

      await initialClient.emit({
        post_type: "message",
        message_type: "private",
        self_id: "90009",
        user_id: "20002",
        message_id: "longevity-1",
        message: [
          { type: "text", data: { text: "/延年益寿" } },
          {
            type: "image",
            data: { file: "submitted.png", file_size: 1024 },
          },
        ],
      });

      expect(load).toHaveBeenCalledOnce();
      expect(generateReply).toHaveBeenCalledOnce();
      expect(generateReply).toHaveBeenCalledWith(
        [
          {
            role: "user",
            content: "submitted_image_count: 1",
            images: [aiImage],
          },
        ],
        { mode: "daily-longevity" },
      );
      expect(
        (await readdir(join(archiveRoot, "2026-07-19"))).filter(
          (fileName) => !fileName.startsWith("."),
        ),
      ).toEqual(["001.png"]);
      await expect(
        readFile(join(archiveRoot, "2026-07-19", "001.png")),
      ).resolves.toEqual(Buffer.from("iVBORw0KGgo=", "base64"));
      expect(initialClient.callMock).toHaveBeenCalledWith("send_private_msg", {
        user_id: "20002",
        message: [
          {
            type: "text",
            data: {
              text: expect.stringMatching(
                /已保存到 2026-07-19 归档文件夹[\s\S]*预审通过第 1 张[\s\S]*待发布 1\/6 张/,
              ),
            },
          },
        ],
      });

      initialRuntime.stop();
      vi.setSystemTime(new Date("2026-07-19T13:59:00.000Z"));
      const restartedClient = new FakeOneBotClient();
      restartedRuntime = createBotRuntime(
        runtimeConfig,
        { generateReply },
        new ConversationMemory({ maxTurns: 4 }),
        restartedClient,
        { load },
      );
      await restartedRuntime.start();
      await vi.advanceTimersByTimeAsync(60 * 1_000);

      expect(generateReply).toHaveBeenCalledWith(
        [
          {
            role: "user",
            content: "submitted_image_count: 1",
            images: [aiImage],
          },
        ],
        { mode: "daily-longevity" },
      );
      await vi.waitFor(() => {
        expect(restartedClient.callMock).toHaveBeenCalledWith("send_group_msg", {
          group_id: "10001",
          message: [
            {
              type: "text",
              data: {
                text: expect.stringMatching(/【延年益寿】[\s\S]*建议反复观看/),
              },
            },
            { type: "image", data: { file: "base64://iVBORw0KGgo=" } },
          ],
        });
      });
      await vi.waitFor(async () => {
        const pending = JSON.parse(
          await readFile(
            join(archiveRoot, "2026-07-19", ".pending.json"),
            "utf8",
          ),
        ) as { files: string[] };
        expect(pending.files).toEqual([]);
      });
    } finally {
      initialRuntime.stop();
      restartedRuntime?.stop();
      vi.useRealTimers();
      await rm(archiveRoot, { recursive: true, force: true });
    }
  });

  it("主号只发送延年益寿命令时提示需要在同一条消息附图", async () => {
    const generateReply = vi.fn<AiService["generateReply"]>();
    const client = new FakeOneBotClient();
    const runtime = createBotRuntime(
      createConfig({
        ONEBOT_ALLOWED_PRIVATE_USER_IDS: "20002",
        DAILY_LONGEVITY_ENABLED: "true",
        DAILY_LONGEVITY_SUBMITTER_USER_ID: "20002",
        DAILY_LONGEVITY_TARGET_GROUP_IDS: "10001",
      }),
      { generateReply },
      new ConversationMemory({ maxTurns: 4 }),
      client,
    );

    try {
      await runtime.start();
      client.callMock.mockClear();
      await client.emit({
        post_type: "message",
        message_type: "private",
        self_id: "90009",
        user_id: "20002",
        message_id: "longevity-without-image",
        message: [{ type: "text", data: { text: "/延年益寿" } }],
      });

      expect(generateReply).not.toHaveBeenCalled();
      expect(client.callMock).toHaveBeenCalledWith("send_private_msg", {
        user_id: "20002",
        message: [
          {
            type: "text",
            data: { text: expect.stringContaining("请在同一条消息附上图片") },
          },
        ],
      });
    } finally {
      runtime.stop();
    }
  });

  it("把白名单群中的 @消息交给 AI 并回复原消息", async () => {
    const generateReply = vi
      .fn<AiService["generateReply"]>()
      .mockResolvedValue("Codex 回答");
    const client = new FakeOneBotClient();
    const runtime = createBotRuntime(
      createConfig(),
      { generateReply },
      new ConversationMemory({ maxTurns: 4 }),
      client,
      undefined,
      new VolatileEngagementState(),
    );
    await runtime.start();

    await client.emit({
      post_type: "message",
      message_type: "group",
      self_id: "90009",
      user_id: "20002",
      group_id: "10001",
      message_id: "30003",
      message: [
        { type: "at", data: { qq: "90009" } },
        { type: "text", data: { text: "解释一下闭包" } },
      ],
    });

    await vi.waitFor(() => expect(client.callMock).toHaveBeenCalledTimes(1));
    expect(generateReply).toHaveBeenCalledWith(
      [{ role: "user", content: "解释一下闭包" }],
      undefined,
    );
    expect(client.callMock).toHaveBeenCalledWith("send_group_msg", {
      group_id: "10001",
      message: [
        { type: "reply", data: { id: "30003" } },
        { type: "at", data: { qq: "20002" } },
        { type: "text", data: { text: " Codex 回答" } },
      ],
    });

    runtime.stop();
    expect(client.stopMock).toHaveBeenCalledOnce();
  });

  it("在白名单群的话题中经 Codex 判断后发送不带 @ 的自然回复", async () => {
    const generateReply = vi
      .fn<AiService["generateReply"]>()
      .mockResolvedValue("[[REPLY]]这话题已经开始自己长腿跑了😹 喵~");
    const client = new FakeOneBotClient();
    const runtime = createBotRuntime(
      createConfig({
        GROUP_PARTICIPATION_MIN_MESSAGES: "3",
        GROUP_PARTICIPATION_PROBABILITY: "1",
      }),
      { generateReply },
      new ConversationMemory({ maxTurns: 4 }),
      client,
      undefined,
      new VolatileEngagementState(),
    );
    await runtime.start();

    for (const [index, content] of [
      "这游戏开局挺正常",
      "怎么突然开始离谱了",
      "剧情已经拐到隔壁地图了",
    ].entries()) {
      await client.emit({
        post_type: "message",
        message_type: "group",
        self_id: "90009",
        user_id: index % 2 === 0 ? "20002" : "30003",
        group_id: "10001",
        message_id: String(70000 + index),
        sender: { card: index % 2 === 0 ? "小明" : "小红" },
        message: [{ type: "text", data: { text: content } }],
      });
    }

    expect(generateReply).toHaveBeenCalledOnce();
    expect(generateReply).toHaveBeenCalledWith(
      expect.arrayContaining([
        { role: "user", content: "[群友：小明] 这游戏开局挺正常" },
        { role: "user", content: "[群友：小红] 怎么突然开始离谱了" },
      ]),
      { mode: "group-participation" },
    );
    expect(client.callMock).toHaveBeenCalledWith("send_group_msg", {
      group_id: "10001",
      message: [
        {
          type: "text",
          data: { text: "这话题已经开始自己长腿跑了😹 喵~" },
        },
      ],
    });

    runtime.stop();
  });

  it("通过 NapCat set_msg_emoji_like 轻量回应普通群消息", async () => {
    const generateReply = vi
      .fn<AiService["generateReply"]>()
      .mockResolvedValue("[[REACTION:76]]");
    const client = new FakeOneBotClient();
    const runtime = createBotRuntime(
      createConfig({
        GROUP_PARTICIPATION_PROBABILITY: "0",
        GROUP_REACTION_ENABLED: "true",
        GROUP_REACTION_PROBABILITY: "1",
      }),
      { generateReply },
      new ConversationMemory({ maxTurns: 4 }),
      client,
      undefined,
      new VolatileEngagementState(),
    );
    await runtime.start();

    await client.emit({
      post_type: "message",
      message_type: "group",
      self_id: "90009",
      user_id: "20002",
      group_id: "10001",
      message_id: "80001",
      sender: { card: "小明" },
      message: [{ type: "text", data: { text: "这波操作可以" } }],
    });

    expect(generateReply).toHaveBeenCalledWith(expect.any(Array), {
      mode: "group-reaction",
      reactionEmojiIds: ["14", "66", "76"],
    });
    expect(client.callMock).toHaveBeenCalledWith("set_msg_emoji_like", {
      message_id: "80001",
      emoji_id: "76",
      set: true,
    });

    runtime.stop();
  });

  it("把白名单好友的私聊消息交给 AI 并直接回复", async () => {
    const generateReply = vi
      .fn<AiService["generateReply"]>()
      .mockResolvedValue("私聊测试成功");
    const client = new FakeOneBotClient();
    const runtime = createBotRuntime(
      createConfig({
        ONEBOT_ALLOWED_GROUP_IDS: "",
        ONEBOT_ALLOWED_PRIVATE_USER_IDS: "20002",
      }),
      { generateReply },
      new ConversationMemory({ maxTurns: 4 }),
      client,
    );
    await runtime.start();

    await client.emit({
      post_type: "message",
      message_type: "private",
      self_id: "90009",
      user_id: "20002",
      message_id: "40004",
      message: [{ type: "text", data: { text: "只回复测试成功" } }],
    });

    await vi.waitFor(() => expect(client.callMock).toHaveBeenCalledTimes(1));
    expect(generateReply).toHaveBeenCalledWith(
      [{ role: "user", content: "只回复测试成功" }],
      undefined,
    );
    expect(client.callMock).toHaveBeenCalledWith("send_private_msg", {
      user_id: "20002",
      message: [{ type: "text", data: { text: "私聊测试成功" } }],
    });

    runtime.stop();
  });

  it("先解析 NapCat 图片，再把多模态私聊交给 AI", async () => {
    const aiImage = {
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      detail: "auto" as const,
    };
    const generateReply = vi
      .fn<AiService["generateReply"]>()
      .mockResolvedValue("图片识别成功");
    const load = vi
      .fn<ImageLoader["load"]>()
      .mockResolvedValue([aiImage]);
    const client = new FakeOneBotClient();
    const runtime = createBotRuntime(
      createConfig({
        ONEBOT_ALLOWED_GROUP_IDS: "",
        ONEBOT_ALLOWED_PRIVATE_USER_IDS: "20002",
      }),
      { generateReply },
      new ConversationMemory({ maxTurns: 4 }),
      client,
      { load },
    );
    await runtime.start();

    await client.emit({
      post_type: "message",
      message_type: "private",
      self_id: "90009",
      user_id: "20002",
      message_id: "50005",
      message: [
        {
          type: "image",
          data: {
            file: "qq-image.png",
            url: "https://gchat.qpic.cn/example.png",
            file_size: 1024,
          },
        },
      ],
    });

    await vi.waitFor(() => expect(client.callMock).toHaveBeenCalledTimes(1));
    expect(load).toHaveBeenCalledWith([
      {
        file: "qq-image.png",
        url: "https://gchat.qpic.cn/example.png",
        fileSize: 1024,
      },
    ]);
    expect(generateReply).toHaveBeenCalledWith(
      [
        {
          role: "user",
          content: "请描述这张图片。",
          images: [aiImage],
        },
      ],
      undefined,
    );
    expect(client.callMock).toHaveBeenCalledWith("send_private_msg", {
      user_id: "20002",
      message: [{ type: "text", data: { text: "图片识别成功" } }],
    });

    runtime.stop();
  });

  it("把 Codex 生成图片作为 OneBot 图片段发给好友", async () => {
    const generateReply = vi
      .fn<AiService["generateReply"]>()
      .mockResolvedValue({
        text: "画好了喵~",
        images: [{ dataUrl: "data:image/png;base64,aW1hZ2U=" }],
      });
    const client = new FakeOneBotClient();
    const runtime = createBotRuntime(
      createConfig({
        ONEBOT_ALLOWED_GROUP_IDS: "",
        ONEBOT_ALLOWED_PRIVATE_USER_IDS: "20002",
      }),
      { generateReply },
      new ConversationMemory({ maxTurns: 4 }),
      client,
    );
    await runtime.start();

    await client.emit({
      post_type: "message",
      message_type: "private",
      self_id: "90009",
      user_id: "20002",
      message_id: "60006",
      message: [{ type: "text", data: { text: "画一只猫" } }],
    });

    await vi.waitFor(() => expect(client.callMock).toHaveBeenCalledTimes(1));
    expect(client.callMock).toHaveBeenCalledWith("send_private_msg", {
      user_id: "20002",
      message: [
        { type: "text", data: { text: "画好了喵~" } },
        { type: "image", data: { file: "base64://aW1hZ2U=" } },
      ],
    });

    runtime.stop();
  });
});
