import { env, runInDurableObject } from "cloudflare:test";
import { RelayGenerationActivities } from "@relaymessenger/think";
import { RELAY_ACTION_NAMES, createRelayTurnSettled } from "@relaymessenger/think/actions";
import { getAgentByName } from "agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toJSONSchema } from "zod";

import type { Bindings, CloneBindings } from "../src/env";
import { searchSources, searchSourcesInputSchema } from "../src/search-sources";
import { searchSourcesActions, type SearchSourcesActionDependencies } from "../src/search-sources-action";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup() {
  const vector = Array.from({ length: 1_024 }, (_, i) => i / 1_024);
  const run = vi.fn(async () => ({ data: [vector] }));
  const metadata = {
    text: "Focus means saying no.", title: "Talk", date: "1997", url: "https://example.com/talk",
    kind: "interview", attribution: "speaker-labeled", speaker_label: "Charles Babbage",
  };
  const query = vi.fn(async () => ({ matches: [{ id: "passage", score: 0.92, metadata }] }));
  const env: CloneBindings = { AI: { run } as unknown as Ai, CLONE_INDEX: { query } as unknown as VectorizeIndex };
  return { env, run, query, vector, metadata };
}

function dependencies(env: CloneBindings): SearchSourcesActionDependencies {
  return {
    env: { RELAY_AGENT_TOKEN: "test", RELAY_API_ORIGIN: "https://api.relayapp.im", ...env } as Bindings,
    activities: new RelayGenerationActivities(),
    turn: () => ({ chatId: "chat", eventId: "event" }), signal: (signal) => signal,
    assertCurrentTurn: () => {}, waitUntil: () => {},
  };
}

describe("search_sources", () => {
  it("offers every public Relay Action but start_call, plus search_sources", async () => {
    await getAgentByName(env.RelayChat, "chat:actions");
    const names = await runInDurableObject(env.RelayChat.getByName("chat:actions"), (instance) => {
      const agent = instance as unknown as { env: Bindings };
      agent.env = { ...agent.env, ...setup().env };
      return Object.keys(instance.getActions()).sort();
    });
    expect(names).toEqual([...RELAY_ACTION_NAMES.filter((name) => name !== "start_call"), "search_sources"].sort());
  });

  it("lets the model answer after reading passages instead of ending at retrieval", () => {
    expect(createRelayTurnSettled()({ steps: [{
      toolCalls: [{ toolName: "search_sources", toolCallId: "sources" }],
      toolResults: [{ toolCallId: "sources", output: [] }],
    }] } as never)).toBe(false);
  });
  it("embeds the person's query with BGE-M3 and returns all passage fields from eight Vectorize matches", async () => {
    const test = setup();
    expect(await searchSources(test.env, "How do I choose what not to build?")).toEqual([{
      text: "Focus means saying no.", title: "Talk", date: "1997", url: "https://example.com/talk",
      kind: "interview", attribution: "speaker-labeled", speaker: "Charles Babbage",
    }]);
    expect(test.run).toHaveBeenCalledExactlyOnceWith("@cf/baai/bge-m3", { text: ["How do I choose what not to build?"] }, { signal: undefined });
    expect(test.query).toHaveBeenCalledExactlyOnceWith(test.vector, { topK: 8, returnMetadata: "all" });
  });

  it("returns an empty list rather than inventing a source", async () => {
    const test = setup();
    test.query.mockResolvedValue({ matches: [] });
    expect(await searchSources(test.env, "unknown subject")).toEqual([]);
  });

  it("does not query the index on an embedding error or wrong dimensions", async () => {
    const test = setup();
    test.run.mockRejectedValueOnce(new Error("embedding failed"));
    await expect(searchSources(test.env, "focus")).rejects.toThrow("embedding failed");
    test.run.mockResolvedValue({ data: [[0.1, 0.2]] });
    await expect(searchSources(test.env, "focus")).rejects.toThrow();
    expect(test.query).not.toHaveBeenCalled();
  });

  it("offers the Action only with CLONE_INDEX and explains attribution and uncited fallback", () => {
    expect(searchSourcesActions(dependencies({}))).not.toHaveProperty("search_sources");
    const action = searchSourcesActions(dependencies(setup().env)).search_sources!;
    for (const guidance of ["before giving a substantive view", "own voice", "own-writing", "monologue", "speaker-labeled",
      "unlabeled-dialogue", "about-person", "without inventing a citation"]) expect(action.config.description).toContain(guidance);
    expect(toJSONSchema(searchSourcesInputSchema).type).toBe("object");
    expect(searchSourcesInputSchema.parse({ query: " focus ", activity: "Reading sources" }).query).toBe("focus");
  });

  it("runs the Action with the model's activity and clears it even when Vectorize fails", async () => {
    const test = setup();
    const deps = dependencies(test.env);
    const stop = vi.fn(async () => {});
    const start = vi.spyOn(deps.activities, "start").mockReturnValue({ stop });
    test.query.mockRejectedValue(new Error("index failed"));
    const action = searchSourcesActions(deps).search_sources!;
    await expect(action.config.execute({ query: "focus", activity: "Reading sources" }, {} as never)).rejects.toThrow("index failed");
    expect(start).toHaveBeenCalledWith(expect.anything(), "chat", { text: "Reading sources", emoji: null }, expect.any(Function), expect.any(Function));
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
