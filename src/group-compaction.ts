import { createCompactFunction, isCompactionMessage, type CompactionFunction } from "agents/sessions";
import type { UIMessage } from "ai";

/**
 * Compaction that keeps every person's own words.
 *
 * Agents' `createCompactFunction` summarizes the compacted range as one text.
 * In a group with several agents the agents write most of it: on a real
 * 1,797-message group, the person wrote 8.1% of the text (559 Messages,
 * about 46,000 tokens) and the agents 91.9%. Its summary recorded the agents'
 * advice as the person's decisions and brought back a figure the person had
 * asked the agents to stop raising. Role instructions in the prompt did not
 * change that.
 *
 * So the summary has two parts:
 *
 * 1. Every Message a person (sender kind `user`) wrote in the range, word for
 *    word and in order. A later compaction copies this block forward and
 *    adds to it; it is never summarized again.
 * 2. A model summary of only the agents' Messages, each point attributed to
 *    the agent that made it, as opinions, never decisions.
 *
 * The range is the one `createCompactFunction` picks (first three Messages
 * and the newest `keepRecentTokens` stay as they are), so tool-call groups
 * are never split. Session.compact keeps one summary for the whole compacted
 * span, so each summary must contain the one before it.
 */

export const PERSON_HEADING = "## The people's own Messages, word for word";
const PERSON_NOTE =
  "Every Message a person wrote in this part of the conversation, complete and in order. These lines are ground truth: only they say what a person thinks, wants, or decided.";
export const AGENT_HEADING = "## What the agents said (summary)";
const AGENT_NOTE =
  "A summary of the agents' Messages. Each point is that agent's opinion or suggestion, never a person's decision.";
const NO_AGENT_MESSAGES = "(No agent Messages in this part.)";

/**
 * The least new conversation, in estimated tokens (characters / 4, the
 * Session's estimate), one compaction summarizes. Session compacts whenever
 * its estimate passes `compactAfter`; once the person block is large, the
 * summary plus the kept recent Messages could pass it on its own, and every
 * new Message would start a paid summary call. Below this, the compaction
 * does nothing and costs nothing.
 */
const MIN_COMPACTED_TOKENS = 50_000;
/** Target length of the agents' summary (computeSummaryBudget's 20%, capped). */
const AGENT_SUMMARY_MAX_TOKENS = 8_000;
/**
 * Gemini 4 Hydrogen takes 1,048,576 tokens. A turn reads up to compactAfter
 * (200,000) plus this summary; with 65,536 output tokens and room for
 * thinking and tools, the person block fits up to 600,000 estimated tokens,
 * about 13 times the measured group's whole history. Past it a warning is
 * logged; nothing is dropped.
 */
export const PERSON_BLOCK_BUDGET_TOKENS = 600_000;

export interface GroupCompactionOptions {
  /** Writes the agents' summary from a prompt (the summary model). */
  summarize: (prompt: string) => Promise<string>;
  keepRecentTokens: number;
  /** How this agent's own Messages are named in the summary. */
  selfName: string;
  /** Overrides MIN_COMPACTED_TOKENS (tests use small conversations). */
  minCompactedTokens?: number;
}

interface SenderHandle {
  display_name?: unknown;
  handle?: unknown;
  kind?: unknown;
}

function relayMessageMeta(message: UIMessage): { sender?: SenderHandle; sentAt?: unknown } {
  const meta = (message.metadata as { turnMetadata?: { message?: { sender_handle?: SenderHandle; sent_at?: unknown } } } | undefined)
    ?.turnMetadata?.message;
  return { sender: meta?.sender_handle, sentAt: meta?.sent_at };
}

/** A person's Message: Relay's sender kind `user`. */
export function isPersonMessage(message: UIMessage): boolean {
  return message.role === "user" && relayMessageMeta(message).sender?.kind === "user";
}

function senderName(sender: SenderHandle | undefined): string | undefined {
  const name = typeof sender?.display_name === "string" && sender.display_name.trim()
    ? sender.display_name.trim()
    : typeof sender?.handle === "string" && sender.handle.trim() ? sender.handle.trim() : undefined;
  return name;
}

function textOf(message: UIMessage): string {
  return message.parts
    .flatMap((part) => part.type === "text" ? [(part as { text: string }).text] : [])
    .join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sentDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return undefined;
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * One person's Message as a line: `<Name> [<date>]: <text>`. Think labels a
 * group Message with its speaker (and src/index.ts may put a time header
 * before it); that label is the line's name, so it is not repeated. Later
 * lines of a multi-line Message are indented, so no line of a person's text
 * can read as a heading.
 */
export function personLine(message: UIMessage): string {
  const { sender, sentAt } = relayMessageMeta(message);
  const name = senderName(sender) ?? "Person";
  let text = textOf(message);
  const label = new RegExp(`^(?:\\[[^\\]\\n]*\\] )?${escapeRegExp(name)}: `, "u");
  text = text.replace(label, "");
  const date = sentDate(sentAt);
  const [first = "", ...rest] = text.split("\n");
  return [`${name}${date ? ` [${date}]` : ""}: ${first}`, ...rest.map((line) => `  ${line}`)].join("\n");
}

/** An agent's Message as the summary prompt reads it, named by its sender. */
function agentLine(message: UIMessage, selfName: string): string {
  if (message.role === "assistant") {
    const said = message.parts.flatMap((part) => {
      if (part.type === "text") return [(part as { text: string }).text];
      const input = (part as { input?: { text?: unknown } }).input;
      return part.type === "tool-send" && typeof input?.text === "string" ? [input.text] : [];
    }).filter((text) => text.trim());
    return said.length ? `${selfName}: ${said.join("\n")}` : "";
  }
  return textOf(message).replace(/^\[[^\]\n]*\] /u, "");
}

/** The two parts of a summary this function wrote; any other summary is all agents' part. */
export function parseSummary(summary: string): { personBlock: string[]; agentSummary: string } {
  const lines = summary.split("\n");
  const start = lines.indexOf(PERSON_HEADING);
  const end = lines.indexOf(AGENT_HEADING);
  if (start !== 0 || end < start) return { personBlock: [], agentSummary: summary.trim() };
  const personBlock = lines.slice(start + 1, end)
    .filter((line, index) => !(index === 0 && line === PERSON_NOTE))
    .join("\n").trim();
  const agentSummary = lines.slice(end + 1)
    .filter((line, index) => !(index === 0 && line === AGENT_NOTE))
    .join("\n").trim();
  return {
    personBlock: personBlock ? [personBlock] : [],
    agentSummary: agentSummary === NO_AGENT_MESSAGES ? "" : agentSummary,
  };
}

export function agentSummaryPrompt(lines: string[], previous: string, budget: number): string {
  return [
    "Summarize what the AI agents said in a chat with people. The people's own Messages are kept word for word elsewhere and are not shown here. Below are only the agents' Messages; each starts with the agent's name.",
    "",
    "Rules:",
    "- Attribute every point to the agent that made it: \"<agent> argued ...\", \"<agent> suggested ...\".",
    "- An agent's view is an opinion or a suggestion. Never write that anything was decided, agreed, settled, locked or concluded, and never write a suggestion as a plan.",
    "- Do not say what a person thinks, wants or decided: you cannot see their Messages.",
    "- Do not restate facts about the people, their money, their company or their plans, even when an agent repeated them: those live only in the people's own words.",
    "- Include only what was said. Do not invent details.",
    "",
    ...(previous ? ["SUMMARY OF THE AGENTS' EARLIER MESSAGES (keep what is still relevant):", previous, ""] : []),
    "AGENTS' MESSAGES:",
    lines.join("\n\n"),
    "",
    `Write only the summary body, grouped by topic, about ${budget} tokens.`,
  ].join("\n");
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function renderSummary(personBlock: string[], agentSummary: string): string {
  return [
    PERSON_HEADING,
    PERSON_NOTE,
    "",
    personBlock.length ? personBlock.join("\n") : "(No person Messages in this part.)",
    "",
    AGENT_HEADING,
    AGENT_NOTE,
    "",
    agentSummary.trim() || NO_AGENT_MESSAGES,
  ].join("\n");
}

export function createGroupCompactFunction(options: GroupCompactionOptions): CompactionFunction {
  // The reference function picks the range; its summarizer is never asked
  // for text here, so no model call happens before the range is known.
  const range = createCompactFunction({ keepRecentTokens: options.keepRecentTokens, summarize: async () => "range" });
  return async (messages) => {
    const picked = await range(messages);
    if (!picked) return null;
    const from = messages.findIndex((message) => message.id === picked.fromMessageId);
    const to = messages.findIndex((message) => message.id === picked.toMessageId);
    if (from < 0 || to < from) return null;
    const middle = (messages.slice(from, to + 1) as UIMessage[]).filter((message) => !isCompactionMessage(message));
    if (estimateTokens(JSON.stringify(middle)) < (options.minCompactedTokens ?? MIN_COMPACTED_TOKENS)) return null;
    const earlier = messages.find(isCompactionMessage) as UIMessage | undefined;
    const previous = earlier ? parseSummary(textOf(earlier)) : { personBlock: [], agentSummary: "" };

    const personLines = middle.filter(isPersonMessage).map(personLine);
    const agentLines = middle.filter((message) => !isPersonMessage(message))
      .map((message) => agentLine(message, options.selfName))
      .filter((line) => line.trim());
    const budget = Math.min(AGENT_SUMMARY_MAX_TOKENS, Math.max(100, Math.floor(estimateTokens(agentLines.join("\n")) * 0.2)));
    const agentSummary = agentLines.length
      ? (await options.summarize(agentSummaryPrompt(agentLines, previous.agentSummary, budget))).trim()
      : previous.agentSummary;
    if (agentLines.length && !agentSummary) return null;

    const personBlock = [...previous.personBlock, ...personLines];
    const summary = renderSummary(personBlock, agentSummary);
    const personTokens = estimateTokens(personBlock.join("\n"));
    console.log(JSON.stringify({
      event: "relay_compaction",
      compacted_messages: middle.length,
      person_messages: personLines.length,
      person_block_tokens: personTokens,
      summary_tokens: estimateTokens(summary),
    }));
    if (personTokens > PERSON_BLOCK_BUDGET_TOKENS) {
      console.warn(JSON.stringify({ event: "relay_compaction_person_block_over_budget", person_block_tokens: personTokens }));
    }
    return { fromMessageId: picked.fromMessageId, toMessageId: picked.toMessageId, summary };
  };
}
