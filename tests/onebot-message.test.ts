import { describe, expect, it } from "vitest";

import {
  parseAllowedGroupMessage,
  parseAllowedOneBotMessage,
  parseAllowedPrivateMessage,
  parseMentionedGroupMessage,
} from "../src/onebot/message.js";

const allowedGroups = new Set(["10001"]);
const allowedPrivateUsers = new Set(["20002"]);

function groupEvent(overrides: Record<string, unknown> = {}) {
  return {
    post_type: "message",
    message_type: "group",
    self_id: "90009",
    user_id: "20002",
    group_id: "10001",
    message_id: "30003",
    message: [
      { type: "at", data: { qq: "90009" } },
      { type: "text", data: { text: " 你好，机器人 " } },
    ],
    ...overrides,
  };
}

function privateEvent(overrides: Record<string, unknown> = {}) {
  return {
    post_type: "message",
    message_type: "private",
    self_id: "90009",
    user_id: "20002",
    message_id: "40004",
    message: [{ type: "text", data: { text: " 你好，机器人 " } }],
    ...overrides,
  };
}

describe("parseAllowedGroupMessage", () => {
  it("解析白名单群中未 @ 的普通聊天并保留群昵称", () => {
    expect(
      parseAllowedGroupMessage(
        groupEvent({
          sender: { card: "群名片", nickname: "QQ昵称" },
          message: [{ type: "text", data: { text: " 大家在聊什么？ " } }],
        }),
        allowedGroups,
      ),
    ).toEqual({
      scope: "group",
      groupId: "10001",
      senderId: "20002",
      senderName: "群名片",
      messageId: "30003",
      content: "大家在聊什么？",
      mentioned: false,
    });
  });

  it("标记明确 @ 机器人的群消息", () => {
    expect(parseAllowedGroupMessage(groupEvent(), allowedGroups)).toMatchObject({
      mentioned: true,
      content: "你好，机器人",
    });
  });
});

describe("parseMentionedGroupMessage", () => {
  it("解析白名单群中 @机器人的数组消息", () => {
    expect(parseMentionedGroupMessage(groupEvent(), allowedGroups)).toEqual({
      scope: "group",
      groupId: "10001",
      senderId: "20002",
      messageId: "30003",
      content: "你好，机器人",
    });
  });

  it("兼容 CQ 字符串消息格式", () => {
    expect(
      parseMentionedGroupMessage(
        groupEvent({
          message: "[CQ:at,qq=90009] 请总结这段代码",
          raw_message: "[CQ:at,qq=90009] 请总结这段代码",
        }),
        allowedGroups,
      ),
    ).toMatchObject({ content: "请总结这段代码" });
  });

  it("保留 @群消息中的图片引用", () => {
    expect(
      parseMentionedGroupMessage(
        groupEvent({
          message: [
            { type: "at", data: { qq: "90009" } },
            { type: "text", data: { text: " 这张图是什么？ " } },
            {
              type: "image",
              data: {
                file: "qq-image.jpg",
                url: "https://multimedia.nt.qq.com.cn/download?id=example",
                path: "/tmp/qq-image.jpg",
                file_size: "1024",
                summary: "[图片]",
              },
            },
          ],
        }),
        allowedGroups,
      ),
    ).toEqual({
      scope: "group",
      groupId: "10001",
      senderId: "20002",
      messageId: "30003",
      content: "这张图是什么？",
      images: [
        {
          file: "qq-image.jpg",
          url: "https://multimedia.nt.qq.com.cn/download?id=example",
          path: "/tmp/qq-image.jpg",
          fileSize: 1024,
          summary: "[图片]",
        },
      ],
    });
  });

  it.each([
    ["没有 @机器人", groupEvent({ message: [{ type: "text", data: { text: "你好" } }] })],
    ["不在白名单群", groupEvent({ group_id: "99999" })],
    ["机器人自身消息", groupEvent({ user_id: "90009" })],
    ["私聊消息", groupEvent({ message_type: "private" })],
  ])("忽略%s", (_name, event) => {
    expect(parseMentionedGroupMessage(event, allowedGroups)).toBeNull();
  });
});

describe("parseAllowedPrivateMessage", () => {
  it("解析白名单好友的私聊文字消息且不要求 @", () => {
    expect(
      parseAllowedPrivateMessage(privateEvent(), allowedPrivateUsers),
    ).toEqual({
      scope: "private",
      senderId: "20002",
      messageId: "40004",
      content: "你好，机器人",
    });
  });

  it("兼容私聊 CQ 字符串并忽略非白名单与自身消息", () => {
    expect(
      parseAllowedPrivateMessage(
        privateEvent({
          message: "看图[CQ:image,file=test.jpg]",
          raw_message: "看图[CQ:image,file=test.jpg]",
        }),
        allowedPrivateUsers,
      ),
    ).toMatchObject({ content: "看图" });
    expect(
      parseAllowedPrivateMessage(privateEvent({ user_id: "30003" }), allowedPrivateUsers),
    ).toBeNull();
    expect(
      parseAllowedPrivateMessage(privateEvent({ user_id: "90009" }), allowedPrivateUsers),
    ).toBeNull();
  });

  it("保留纯图片私聊和 CQ 图片参数", () => {
    expect(
      parseAllowedPrivateMessage(
        privateEvent({
          message: [
            {
              type: "image",
              data: {
                file: "only-image.png",
                url: "https://gchat.qpic.cn/example.png",
                file_size: 2048,
              },
            },
          ],
        }),
        allowedPrivateUsers,
      ),
    ).toMatchObject({
      content: "",
      images: [
        {
          file: "only-image.png",
          url: "https://gchat.qpic.cn/example.png",
          fileSize: 2048,
        },
      ],
    });

    expect(
      parseAllowedPrivateMessage(
        privateEvent({
          message:
            "帮我看[CQ:image,file=cq.jpg,url=https://gchat.qpic.cn/a.jpg?x=1&amp;y=2]",
          raw_message:
            "帮我看[CQ:image,file=cq.jpg,url=https://gchat.qpic.cn/a.jpg?x=1&amp;y=2]",
        }),
        allowedPrivateUsers,
      ),
    ).toMatchObject({
      content: "帮我看",
      images: [
        {
          file: "cq.jpg",
          url: "https://gchat.qpic.cn/a.jpg?x=1&y=2",
        },
      ],
    });
  });

  it("由统一入口按私聊和群聊分发", () => {
    expect(
      parseAllowedOneBotMessage(privateEvent(), allowedGroups, allowedPrivateUsers),
    ).toMatchObject({ scope: "private", senderId: "20002" });
    expect(
      parseAllowedOneBotMessage(groupEvent(), allowedGroups, allowedPrivateUsers),
    ).toMatchObject({ scope: "group", groupId: "10001" });
  });
});
