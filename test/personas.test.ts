import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

import { AGENT_THINKING_LEVEL, PERSONA, VOICE_OFF_GUIDANCE, agentSystemPrompt } from "../src/personas";
import {
  GROUP_CHAT_GUIDANCE,
  RELAY_CAPABILITY_GUIDANCE,
} from "../src/prompt";

describe("persona/persona.md", () => {
  it("is the start of the system prompt, and every capability follows it", () => {
    const prompt = agentSystemPrompt();
    expect(PERSONA.trim()).toBe("You are Ada Lovelace, an AI clone built from her public words.");
    expect(prompt.startsWith(PERSONA.trim())).toBe(true);
    expect(prompt.endsWith(
      `\n\n${RELAY_CAPABILITY_GUIDANCE}\n\n${GROUP_CHAT_GUIDANCE}\n\n${VOICE_OFF_GUIDANCE}`,
    )).toBe(true);
  });

  it("keeps clone thinking high", () => {
    expect(AGENT_THINKING_LEVEL).toBe("high");
  });

  it("frames a group chat in one sentence, the way a person takes part, with no rule list", () => {
    expect(GROUP_CHAT_GUIDANCE).toBe("You are one member of this group chat, and you take part the way a real person does in a group chat with friends: most of the time you read along, you answer when someone talks to you, and you jump in when you have something that really adds.");
    expect(agentSystemPrompt()).toContain(GROUP_CHAT_GUIDANCE);
  });

  it("tells the agent it has no calls", () => {
    expect(agentSystemPrompt()).toContain("Never offer, promise, suggest or schedule a call");
  });

  it("scripts no crisis line: the model uses its own judgment", () => {
    expect(PERSONA).not.toMatch(/988|helpline|hotline|in crisis|harming (him|her|them)sel/i);
  });

  it("fails closed on an empty persona file", () => {
    expect(() => agentSystemPrompt("  \n")).toThrow("persona/persona.md is empty");
  });
});

describe("voice calls", () => {
  it("are off: the agent has no start_call Action", async () => {
    const chat = "chat:voice-off";
    await getAgentByName(env.RelayChat, chat);
    const names = await runInDurableObject(env.RelayChat.getByName(chat), (instance) =>
      Object.keys(instance.getActions()));
    expect(names).not.toContain("start_call");
    expect(names).toContain("send");
  });
});
