import { describe, expect, it, vi } from "vitest";

import type { AiReplyResult, AiService } from "../src/ai/types.js";
import {
  GroupParticipationCoordinator,
  parseParticipationReply,
  parseReactionReply,
} from "../src/group-participation.js";

const baseConfig = {
  enabled: true,
  minMessages: 3,
  cooldownMs: 120_000,
  probability: 0.3,
  contextMessages: 8,
};

function groupMessage(content: string, senderId = "20002") {
  return {
    groupId: "10001",
    senderId,
    senderName: senderId === "20002" ? "小明" : "小红",
    content,
  };
}

describe("群聊参与协调器", () => {
  it("累计三条群消息后才让 Codex 判断，并发送带标记的自然回复", async () => {
    const generateReply = vi
      .fn<AiService["generateReply"]>()
      .mockResolvedValue("[[REPLY]]这剧情再拐一下都能上高速了😹 喵~");
    const send = vi.fn().mockResolvedValue(undefined);
    const coordinator = new GroupParticipationCoordinator({
      ai: { generateReply },
      config: baseConfig,
      random: () => 0,
    });

    await expect(
      coordinator.handleUnmentioned(groupMessage("这游戏开局有点怪"), { send }),
    ).resolves.toBe("none");
    await expect(
      coordinator.handleUnmentioned(groupMessage("越玩越离谱", "30003"), {
        send,
      }),
    ).resolves.toBe("none");
    await expect(
      coordinator.handleUnmentioned(groupMessage("已经变成喜剧了"), { send }),
    ).resolves.toBe("text");

    expect(generateReply).toHaveBeenCalledWith(
      [
        { role: "user", content: "[群友：小明] 这游戏开局有点怪" },
        { role: "user", content: "[群友：小红] 越玩越离谱" },
        { role: "user", content: "[群友：小明] 已经变成喜剧了" },
      ],
      { mode: "group-participation" },
    );
    expect(send).toHaveBeenCalledWith(
      "这剧情再拐一下都能上高速了😹 喵~",
    );
  });

  it("Codex 选择潜水或输出格式异常时不向群里发送", async () => {
    const generateReply = vi
      .fn<AiService["generateReply"]>()
      .mockResolvedValueOnce("[[SILENT]]")
      .mockResolvedValueOnce("这条缺少安全前缀，不能发送");
    const send = vi.fn().mockResolvedValue(undefined);
    const coordinator = new GroupParticipationCoordinator({
      ai: { generateReply },
      config: { ...baseConfig, minMessages: 1, probability: 1 },
      random: () => 0,
    });

    await coordinator.handleUnmentioned(groupMessage("嗯"), { send });
    await coordinator.handleUnmentioned(groupMessage("好吧"), { send });

    expect(generateReply).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
  });

  it("直接叫名字时提高为必定判断，但仍由 Codex 决定是否加入", async () => {
    const generateReply = vi
      .fn<AiService["generateReply"]>()
      .mockResolvedValue("[[REPLY]]听见有人叫我，我啪一下就冒头了👀 喵~");
    const send = vi.fn().mockResolvedValue(undefined);
    const coordinator = new GroupParticipationCoordinator({
      ai: { generateReply },
      config: { ...baseConfig, probability: 0 },
      random: () => 0.99,
    });

    await expect(
      coordinator.handleUnmentioned(groupMessage("铃铃酱觉得呢"), { send }),
    ).resolves.toBe("text");
    expect(generateReply).toHaveBeenCalledOnce();
  });

  it("思考期间群聊已经快速推进时丢弃过时回复", async () => {
    let resolveReply: ((value: AiReplyResult) => void) | undefined;
    const generateReply = vi.fn<AiService["generateReply"]>().mockReturnValue(
      new Promise<AiReplyResult>((resolve) => {
        resolveReply = resolve;
      }),
    );
    const send = vi.fn().mockResolvedValue(undefined);
    const coordinator = new GroupParticipationCoordinator({
      ai: { generateReply },
      config: { ...baseConfig, minMessages: 1, probability: 1 },
      random: () => 0,
    });

    const decision = coordinator.handleUnmentioned(groupMessage("这个咋样？"), {
      send,
    });
    coordinator.observeHuman(groupMessage("下一句", "30003"));
    coordinator.observeHuman(groupMessage("又下一句"));
    coordinator.observeHuman(groupMessage("话题已经跑远了", "30003"));
    resolveReply?.("[[REPLY]]这是已经过时的回复喵~");

    await expect(decision).resolves.toBe("none");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("群聊参与输出解析", () => {
  it("只接受明确的回复标记", () => {
    expect(parseParticipationReply("[[SILENT]]")).toBeNull();
    expect(parseParticipationReply("普通文字")).toBeNull();
    expect(parseParticipationReply({ text: "[[REPLY]] 接住了喵~" })).toBe(
      "接住了喵~",
    );
  });

  it("表情回应只接受白名单中的严格标记", () => {
    expect(parseReactionReply("[[REACTION:76]]", ["14", "66", "76"])).toBe(
      "76",
    );
    expect(parseReactionReply("[[REACTION:999]]", ["14", "66", "76"])).toBeNull();
    expect(parseReactionReply("赞 [[REACTION:76]]", ["76"])).toBeNull();
  });
});
