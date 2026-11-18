/// <reference types="vite/client" />
import { RELAY_WEBHOOK_EVENT_TYPES } from "@relaymessenger/chat-sdk-adapter";
import { describe, expect, it } from "vitest";

import {
  RELAY_HANDLED_EVENT_TYPES,
  RELAY_SUBSCRIBED_EVENTS,
} from "../src/subscription";

// README.md's subscribe command, read as text at build time.
const README = Object.values(import.meta.glob<string>("../README.md", {
  query: "?raw",
  import: "default",
  eager: true,
}))[0]!;

// Every runtime source file, read as text at build time.
const SOURCES = import.meta.glob<string>("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Every quoted contract event name a runtime file mentions. */
function eventTypesNamedInSource(): Map<string, string[]> {
  const catalogue = new Set<string>(RELAY_WEBHOOK_EVENT_TYPES);
  const named = new Map<string, string[]>();
  for (const [path, text] of Object.entries(SOURCES)) {
    for (const match of text.matchAll(/["'`]([a-z_]+(?:\.[a-z_]+)+)["'`]/gu)) {
      const type = match[1]!;
      if (!catalogue.has(type)) continue;
      named.set(type, [...new Set([...(named.get(type) ?? []), path])]);
    }
  }
  return named;
}

describe("the agent's webhook subscription", () => {
  it("names every event type a file in src handles", () => {
    const sources = eventTypesNamedInSource();
    expect(sources.size).toBeGreaterThan(0);
    const missing = [...sources.keys()]
      .filter((type) => !(RELAY_SUBSCRIBED_EVENTS as readonly string[]).includes(type))
      .map((type) => `${type} (${sources.get(type)!.join(", ")})`);
    expect(missing).toEqual([]);
  });

  it("drops no handled type and invents none outside the contract", () => {
    expect(new Set(RELAY_SUBSCRIBED_EVENTS)).toEqual(RELAY_HANDLED_EVENT_TYPES);
  });

  it("is the list README.md subscribes to", () => {
    const body = /"subscribed_events": (\[[^\]]*\])/.exec(README)?.[1];
    expect(body && JSON.parse(body)).toEqual([...RELAY_SUBSCRIBED_EVENTS]);
  });

  it("is pinned", () => {
    expect(RELAY_SUBSCRIBED_EVENTS).toEqual([
      "message.received",
      "reaction.added",
      "reaction.removed",
      "participant.added",
      "participant.removed",
      "chat.created",
      "chat.group_name_updated",
      "chat.group_icon_updated",
      "call.created",
      "call.updated",
      "call.ended",
      "payment.succeeded",
      "payment.canceled",
      "payment.expired",
      "location.sharing.started",
      "location.sharing.stopped",
    ]);
  });
});
