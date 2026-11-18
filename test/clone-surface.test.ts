import { env, reset, runInDurableObject, SELF } from "cloudflare:test";
import { getAgentByName } from "agents";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RelayChatAgent } from "../src/index";
import { agentSystemPrompt } from "../src/personas";
import { WEB_SEARCH_GUIDANCE } from "../src/web-search";

afterEach(async () => {
  await reset();
  vi.restoreAllMocks();
});

describe("the clone's feature surface", () => {
  it("keeps the same Actions and prompt with the shipped wrangler.jsonc vars", async () => {
    // vitest.config.ts passes wrangler.jsonc's vars as SHIPPED_VARS.
    const vars = JSON.parse((env as unknown as { SHIPPED_VARS: string }).SHIPPED_VARS) as Record<string, string>;
    const chat = await getAgentByName(env.RelayChat, "chat:clone-surface");
    await runInDurableObject(chat, (instance: RelayChatAgent) => {
      const agent = instance as unknown as { env: object };
      // Only presence is read while constructing Actions. No index or AI call.
      agent.env = { ...agent.env, ...vars, CLONE_INDEX: {} };
      expect(Object.keys(instance.getActions()).sort()).toEqual([
        "find_agents", "group", "payment_request", "react", "read_location",
        "request_location", "search_sources", "send", "share_contact_card",
        "stay_silent",
      ]);
      expect(Object.keys(instance.getTools())).toEqual(["google_search", "url_context"]);
      expect(instance.getSystemPrompt()).toBe(`${agentSystemPrompt()}\n\n${WEB_SEARCH_GUIDANCE}`);
    });
  });

  it("leaves an unknown path at 404 without a request out", async () => {
    const outbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected outbound request"));
    const response = await SELF.fetch("https://agent.example/support/updates", {
      method: "POST", body: "{}",
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expect(outbound).not.toHaveBeenCalled();
  });
});
