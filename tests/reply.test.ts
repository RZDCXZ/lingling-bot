import { describe, expect, it, vi } from "vitest";

import {
  sendOneBotGroupMessage,
  sendOneBotGroupText,
  sendOneBotPrivateMessage,
  sendOneBotReply,
  sendOneBotPrivateText,
  splitReplyText,
} from "../src/onebot/reply.js";
import type { OneBotActionCaller } from "../src/onebot/types.js";

describe("QQ 回复分段", () => {
  it("优先在自然边界分段", () => {
    const text = "第一段内容比较长一些。第二段内容也比较长一些。第三段继续补充。";
    const chunks = splitReplyText(text, 20, 5);

    expect(chunks[0]).toBe("第一段内容比较长一些。");
    expect(chunks.join("")).toBe(text);
  });

  it("最多生成 5 段并标记截断", () => {
    const chunks = splitReplyText("a".repeat(200), 20, 5);

    expect(chunks).toHaveLength(5);
    expect(chunks.join("")).toContain("回复过长，已截断");
  });

  it("通过 OneBot 接口回复原消息并 @发送者", async () => {
    const call = vi.fn().mockResolvedValue({ message_id: "reply" });
    const client: OneBotActionCaller = { call };

    await sendOneBotGroupText(
      client,
      {
        scope: "group",
        groupId: "10001",
        senderId: "20002",
        messageId: "30003",
      },
      "你好",
    );

    expect(call).toHaveBeenCalledWith("send_group_msg", {
      group_id: "10001",
      message: [
        { type: "reply", data: { id: "30003" } },
        { type: "at", data: { qq: "20002" } },
        { type: "text", data: { text: " 你好" } },
      ],
    });
  });

  it("自然加入群聊时发送不引用也不 @成员的普通群消息", async () => {
    const call = vi.fn().mockResolvedValue({ message_id: "reply" });
    const client: OneBotActionCaller = { call };

    await sendOneBotGroupMessage(client, "10001", "我也来接一句喵~");

    expect(call).toHaveBeenCalledWith("send_group_msg", {
      group_id: "10001",
      message: [
        { type: "text", data: { text: "我也来接一句喵~" } },
      ],
    });
  });

  it("群定时环节可在普通消息中附带多张图片", async () => {
    const call = vi.fn().mockResolvedValue({ message_id: "reply" });
    const client: OneBotActionCaller = { call };

    await sendOneBotGroupMessage(client, "10001", "【延年益寿】\n今晚份", [
      { dataUrl: "data:image/png;base64,aW1hZ2Ux" },
      { dataUrl: "data:image/jpeg;base64,aW1hZ2Uy" },
    ]);

    expect(call).toHaveBeenCalledWith("send_group_msg", {
      group_id: "10001",
      message: [
        { type: "text", data: { text: "【延年益寿】\n今晚份" } },
        { type: "image", data: { file: "base64://aW1hZ2Ux" } },
        { type: "image", data: { file: "base64://aW1hZ2Uy" } },
      ],
    });
  });

  it("通过私聊接口直接回复白名单好友", async () => {
    const call = vi.fn().mockResolvedValue({ message_id: "reply" });
    const client: OneBotActionCaller = { call };

    await sendOneBotPrivateText(
      client,
      { scope: "private", senderId: "20002", messageId: "40004" },
      "你好",
    );

    expect(call).toHaveBeenCalledWith("send_private_msg", {
      user_id: "20002",
      message: [{ type: "text", data: { text: "你好" } }],
    });
  });

  it("定时任务可主动私聊指定好友", async () => {
    const call = vi.fn().mockResolvedValue({ message_id: "reply" });
    const client: OneBotActionCaller = { call };

    await sendOneBotPrivateMessage(client, "20002", "【延年益寿】开始征集");

    expect(call).toHaveBeenCalledWith("send_private_msg", {
      user_id: "20002",
      message: [
        { type: "text", data: { text: "【延年益寿】开始征集" } },
      ],
    });
  });

  it("把 Codex 生成图片作为真正的 OneBot 图片消息发送", async () => {
    const call = vi.fn().mockResolvedValue({ message_id: "reply" });
    const client: OneBotActionCaller = { call };

    await sendOneBotReply(
      client,
      { scope: "private", senderId: "20002", messageId: "40004" },
      "画好了喵~",
      [{ dataUrl: "data:image/png;base64,aW1hZ2U=" }],
    );

    expect(call).toHaveBeenCalledWith("send_private_msg", {
      user_id: "20002",
      message: [
        { type: "text", data: { text: "画好了喵~" } },
        { type: "image", data: { file: "base64://aW1hZ2U=" } },
      ],
    });
  });
});
