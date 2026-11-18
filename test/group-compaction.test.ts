import { COMPACTION_PREFIX } from "agents/sessions";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

import { AGENT_HEADING, createGroupCompactFunction, PERSON_HEADING } from "../src/group-compaction";

// Each filler Message is about 100 estimated tokens, so a small
// keepRecentTokens leaves a real middle to compact.
const pad = (tag: string) => `${tag} ${"x".repeat(400)}`;

const person = (id: string, text: string, minute: number): UIMessage => ({
  id, role: "user",
  parts: [{ type: "text", text: `[Today 12:${String(minute).padStart(2, "0")} PM] Ada: ${text}` }],
  metadata: { turnMetadata: { message: {
    id, sent_at: `2026-09-01T12:${String(minute).padStart(2, "0")}:00.000Z`,
    sender_handle: { id: "h-ada", handle: "ada", display_name: "Ada", kind: "user" },
  } } },
} as UIMessage);
const agent = (id: string, name: string, text: string): UIMessage => ({
  id, role: "user",
  parts: [{ type: "text", text: `${name}: ${text}` }],
  metadata: { turnMetadata: { message: { id, sender_handle: { handle: name.toLowerCase(), display_name: name, kind: "agent" } } } },
} as UIMessage);
const own = (id: string, text: string): UIMessage => ({
  id, role: "assistant",
  parts: [{ type: "tool-send", toolCallId: `t-${id}`, state: "output-available", input: { text }, output: { status: "sent" } } as never],
});

function conversation(prefix: string, start: number): UIMessage[] {
  const rows: UIMessage[] = [];
  for (let index = 0; index < 12; index += 1) {
    const n = start + index;
    rows.push(person(`${prefix}p${n}`, index === 4 ? `I keep the desk box.\nLine two of ${n}.` : pad(`ada-${n}`), n % 60));
    rows.push(agent(`${prefix}a${n}`, "Grace", pad(`grace-${n}: ship the pocket device`)));
    rows.push(own(`${prefix}o${n}`, pad(`self-${n}`)));
  }
  return rows;
}

function compactor(prompts: string[]) {
  return createGroupCompactFunction({
    keepRecentTokens: 600,
    minCompactedTokens: 0,
    selfName: "You (@self)",
    summarize: async (prompt) => {
      prompts.push(prompt);
      return `AGENT SUMMARY ${prompts.length}: Grace argued for the pocket device.`;
    },
  });
}

/** The Session's view after a compaction: head, the summary overlay, the rest. */
function applied(messages: UIMessage[], result: { fromMessageId: string; toMessageId: string; summary: string }): UIMessage[] {
  const from = messages.findIndex(({ id }) => id === result.fromMessageId);
  const to = messages.findIndex(({ id }) => id === result.toMessageId);
  const head = messages.slice(0, from).filter(({ id }) => !id.startsWith(COMPACTION_PREFIX));
  const overlay: UIMessage = { id: `${COMPACTION_PREFIX}1`, role: "assistant", parts: [{ type: "text", text: result.summary }] };
  return [...head, overlay, ...messages.slice(to + 1)];
}

function compactedRange(messages: UIMessage[], result: { fromMessageId: string; toMessageId: string }) {
  const from = messages.findIndex(({ id }) => id === result.fromMessageId);
  const to = messages.findIndex(({ id }) => id === result.toMessageId);
  return messages.slice(from, to + 1);
}

describe("compaction keeps every person's words", () => {
  it("puts each person's Message in the summary word for word, in order, and none in the model prompt", async () => {
    const prompts: string[] = [];
    const messages = conversation("", 0);
    const result = await compactor(prompts)(messages);
    expect(result).not.toBeNull();
    const range = compactedRange(messages, result!);
    const people = range.filter(({ id }) => id.startsWith("p"));
    expect(people.length).toBeGreaterThan(3);

    const [personPart, agentPart] = result!.summary.split(AGENT_HEADING);
    expect(result!.summary.startsWith(PERSON_HEADING)).toBe(true);
    let at = 0;
    for (const row of people) {
      const n = row.id.slice(1);
      const minute = String(Number(n) % 60).padStart(2, "0");
      const text = Number(n) === 4 ? "I keep the desk box.\n  Line two of 4." : pad(`ada-${n}`);
      const expected = `Ada [2026-09-01 12:${minute} UTC]: ${text}`;
      const found = personPart!.indexOf(expected, at);
      expect(found, `person Message ${row.id}`).toBeGreaterThanOrEqual(0);
      at = found + expected.length;
    }
    // People's words never go to the model; the agents' do, by name.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain("ada-");
    expect(prompts[0]).not.toContain("I keep the desk box");
    expect(prompts[0]).toContain("Grace: grace-");
    expect(prompts[0]).toContain("You (@self): self-");
    // The agents' part holds only the model's summary.
    expect(agentPart).toContain("AGENT SUMMARY 1");
    expect(agentPart).not.toContain("ada-");
    expect(personPart).not.toContain("grace-");
    expect(personPart).not.toContain("self-");
  });

  it("copies the earlier summary's person block forward word for word and adds the new Messages", async () => {
    const prompts: string[] = [];
    const compact = compactor(prompts);
    const first = conversation("", 0);
    const once = await compact(first);
    const firstBlock = once!.summary.split(AGENT_HEADING)[0]!.trim();

    const second = [...applied(first, once!), ...conversation("n", 20)];
    const twice = await compact(second);
    expect(twice).not.toBeNull();
    const [personPart, agentPart] = twice!.summary.split(AGENT_HEADING);
    expect(personPart!.startsWith(firstBlock)).toBe(true);
    const newPeople = compactedRange(second, twice!).filter(({ id }) => id.startsWith("np"));
    expect(newPeople.length).toBeGreaterThan(0);
    for (const row of newPeople) {
      const n = Number(row.id.slice(2));
      expect(personPart, row.id).toContain(n === 24 ? "Line two of 24." : pad(`ada-${n}`));
    }
    // The earlier agents' summary is the model's context; the earlier person block is not.
    expect(prompts[1]).toContain("AGENT SUMMARY 1");
    expect(prompts[1]).not.toContain("ada-");
    expect(prompts[1]).not.toContain(PERSON_HEADING);
    expect(agentPart).toContain("AGENT SUMMARY 2");
  });

  it("makes no model call and no compaction when the span is under the minimum", async () => {
    const prompts: string[] = [];
    const compact = createGroupCompactFunction({
      keepRecentTokens: 600, selfName: "You", summarize: async (prompt) => { prompts.push(prompt); return "s"; },
    });
    expect(await compact(conversation("", 0))).toBeNull();
    expect(prompts).toEqual([]);
  });
});
