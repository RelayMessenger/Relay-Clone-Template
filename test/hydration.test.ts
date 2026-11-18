import {
  abortAllDurableObjects,
  env,
  runInDurableObject,
} from "cloudflare:test";
import { getAgentByName } from "agents";
import type { ModelMessage, UIMessage } from "ai";
import { describe, expect, it } from "vitest";

/** The recent tail compaction keeps verbatim (src/index.ts RELAY_KEEP_RECENT_TOKENS). */
const MAX_HISTORY_TOKENS = 100_000;

const CHAT = "chat:01993d50-ef7b-7b37-886b-23fd80c7ec90";
// One real chat stored 934,397 bytes for 15,935
// estimated tokens of model text, 59 bytes a token, because every stored
// Message carries the adapter's raw webhook Message and every tool call
// carries Gemini thought signatures. This history keeps that ratio and fills
// 100,000 tokens, the recent tail compaction keeps verbatim.
const BYTES_PER_TOKEN = 59;
const TOKENS_PER_MESSAGE = 500;
const MESSAGES = Math.floor(MAX_HISTORY_TOKENS / TOKENS_PER_MESSAGE) - 1;

function storedMessage(index: number): UIMessage {
  const tag = `m${index} `;
  return {
    id: `h${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    parts: [{
      type: "text",
      text: tag + "x".repeat(TOKENS_PER_MESSAGE * 4 - tag.length),
    }],
    metadata: {
      padding: "p".repeat(TOKENS_PER_MESSAGE * (BYTES_PER_TOKEN - 4)),
    },
  };
}

/**
 * Think internals the test drives: appendMessageToHistory (protected) and the
 * turn pipeline (think.js _assembleModelMessages).
 */
interface TurnContext {
  appendMessageToHistory(message: UIMessage): Promise<unknown>;
  _assembleModelMessages(tools: object): Promise<ModelMessage[]>;
  _lastHydration: { truncated: boolean; totalContentBytes: number } | null;
}

describe("cold-start hydration", () => {
  it("keeps every stored Message of a 100,000-token history", async () => {
    await getAgentByName(env.RelayChat, CHAT);
    await runInDurableObject(env.RelayChat.getByName(CHAT), async (instance) => {
      const history = instance as unknown as TurnContext;
      for (let index = 0; index < MESSAGES; index += 1) {
        await history.appendMessageToHistory(storedMessage(index));
      }
    });

    await abortAllDurableObjects();
    await getAgentByName(env.RelayChat, CHAT);
    const cold = await runInDurableObject(
      env.RelayChat.getByName(CHAT),
      async (instance) => {
        const turn = instance as unknown as TurnContext;
        const model = await turn._assembleModelMessages({});
        return {
          hydrated: instance.messages.map((message) => message.id),
          storedBytes: turn._lastHydration?.totalContentBytes,
          modelMessages: model.length,
          oldest: JSON.stringify(model[0]?.content ?? "").slice(0, 40),
        };
      },
    );

    // The fixture is what it claims: inside the kept tail, and past the old
    // 256 KiB budget many times over.
    expect(MESSAGES * TOKENS_PER_MESSAGE).toBeLessThanOrEqual(MAX_HISTORY_TOKENS);
    expect(cold.storedBytes).toBeGreaterThan(20 * 256 * 1024);
    // Every Message reaches the model, the oldest included.
    expect(cold.hydrated).toHaveLength(MESSAGES);
    expect(cold.hydrated[0]).toBe("h0");
    expect(cold.modelMessages).toBe(MESSAGES);
    expect(cold.oldest).toContain("m0 ");
  }, 60_000);
});
