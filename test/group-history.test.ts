import { env } from "cloudflare:test";
import type { Message } from "@relaymessenger/sdk";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

import { ConfigurationError } from "../src/env";
import { mergeGroupHistory } from "../src/group-history";
import { relaySummaryModel } from "../src/model";

const relay = (id: string, minute: number): Message => ({
  id, chat_id: "c", is_from_me: false, is_system_message: false, delivery_status: "delivered",
  parts: [{ type: "text", value: id }],
  created_at: `2026-09-01T12:${String(minute).padStart(2, "0")}:00.000Z`,
  updated_at: `2026-09-01T12:${String(minute).padStart(2, "0")}:00.000Z`,
  sent_at: `2026-09-01T12:${String(minute).padStart(2, "0")}:00.000Z`,
} as Message);
const row = (id: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text: id }] });

describe("group history backfill order", () => {
  it("puts each missing Message where it was said, before the reply that came after it", () => {
    // Stored: the person at 12:02, the clone's reply (its send posted r at
    // 12:03), a call note with no Relay Message, then the person at 12:05.
    const reply: UIMessage = {
      id: "assistant-1", role: "assistant",
      parts: [{ type: "tool-send", toolCallId: "t", state: "output-available", input: {}, output: { status: "sent", messageId: "r" } } as never],
    };
    const stored = [row("relay:p2"), reply, row("relay-call:x"), row("relay:p5")];
    const byId = new Map([relay("p2", 2), relay("r", 3), relay("p5", 5), relay("a1", 1), relay("a4", 4), relay("a6", 6)]
      .map((message) => [message.id, message]));
    const missing = ["a4", "a1", "a6"].map((id) => ({ message: byId.get(id)!, row: row(`relay:${id}`) }));
    expect(mergeGroupHistory(stored, missing, byId).map(({ id }) => id)).toEqual([
      "relay:a1", "relay:p2", "assistant-1", "relay-call:x", "relay:a4", "relay:p5", "relay:a6",
    ]);
  });
});

describe("the summary model", () => {
  it("refuses to run without VERTEX_SUMMARY_MODEL", () => {
    expect(() => relaySummaryModel({ ...env, VERTEX_SUMMARY_MODEL: "" } as never)).toThrow(ConfigurationError);
    expect(() => relaySummaryModel(env as never)).not.toThrow();
  });
});
