import type { Message } from "@relaymessenger/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { everyGroupMessageEnabled, type CloneBindings } from "../src/env";
import { clefState, isOneEmoji, prepareSpeakGate, type SpeakDecision, type SpeakGateDependencies } from "../src/speak-gate";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** Scores for [Charles Babbage (this agent), Mary Somerville, Michael Faraday]. */
function setup(p = 0.6, others: [number, number] = [0.1, 0.1], react = 0.1, emoji: string | null = "🚀") {
  let saved: SpeakDecision | undefined;
  const run = vi.fn(async () => ({ answers: {
    a0: { type: "noul", noul: p }, a1: { type: "noul", noul: others[0] }, a2: { type: "noul", noul: others[1] },
    r0: { type: "noul", noul: react }, r1: { type: "noul", noul: 0.1 }, r2: { type: "noul", noul: 0.1 },
  } }));
  const addReaction = vi.fn(async () => ({}));
  const pickReaction = vi.fn(async () => emoji);
  const env = {
    RELAY_SPEAK_GATE: "clef", RELAY_SPEAK_PEERS: "marysomerville, michaelfaraday",
    AI: { run } as unknown as Ai,
  } satisfies CloneBindings;
  const messages = Array.from({ length: 15 }, (_, index) => ({
    id: `${index}`, is_from_me: false, from_handle: { display_name: `Person ${index}` },
    parts: [{ type: "text", value: `line ${index}` }],
  })) as Message[];
  const list = vi.fn(async (_chat: string, query: { limit: number }) => pages([...messages].reverse(), query.limit));
  const retrieve = vi.fn(async (): Promise<{ is_from_me: boolean; from_handle?: { handle: string } }> => ({ is_from_me: true }));
  const chat = vi.fn(async () => ({ handles: [
    { kind: "user", handle: "ada", display_name: "Ada", status: "active" },
    { kind: "agent", handle: "charlesbabbage", display_name: "Charles Babbage", status: "active" },
    { kind: "agent", handle: "marysomerville", display_name: "Mary Somerville", status: "active" },
    { kind: "agent", handle: "michaelfaraday", display_name: "Michael Faraday", status: "active" },
    { kind: "agent", handle: "gone", display_name: "Gone", status: "left" },
  ] }));
  const deps: SpeakGateDependencies = {
    relay: { chats: { messages: { list }, retrieve: chat }, messages: { retrieve, addReaction } } as unknown as SpeakGateDependencies["relay"],
    get: () => saved,
    pickReaction,
    put: (value) => { saved = value; },
  };
  const event = {
    event_type: "message.received",
    data: {
      id: "14", direction: "inbound", sender_handle: { is_me: false, kind: "user" },
      chat: { id: "group", is_group: true, owner_handle: { display_name: "Charles Babbage", handle: "charlesbabbage" } },
      parts: [{ type: "text", value: "line 14" }],
    },
  };
  return { run, env, event, deps, list, messages, retrieve, chat, addReaction, pickReaction, saved: () => saved };
}

/** Relay's MessagesPage over a newest-first list, `size` per page. */
function pages(newestFirst: Message[], size: number, from = 0): { data: Message[]; getNextPage: () => Promise<unknown> } {
  return {
    data: newestFirst.slice(from, from + size),
    getNextPage: vi.fn(async () => from + size < newestFirst.length ? pages(newestFirst, size, from + size) : null),
  };
}

const fromAgent = (event: ReturnType<typeof setup>["event"], extra: Record<string, unknown> = {}) =>
  ({ ...event, data: { ...event.data, sender_handle: { is_me: false, kind: "agent" }, ...extra } });

describe("speak gate", () => {
  it("asks Clef once about every active agent, with the members and 15 messages newest last", async () => {
    const test = setup(0.8752);
    expect(await prepareSpeakGate(test.env, test.event, test.deps)).toMatchObject({ kind: "turn" });
    const reactionQuestion = (name: string) => ({
      type: "noul",
      instructions: `Does ${name} agree with or appreciate the latest message enough to tap a reaction on it?`,
    });
    const question = (name: string) => ({ type: "noul", instructions: `How much is the latest message meant for ${name}, either because it names ${name} or because it is about ${name}'s own work and expertise?` });
    expect(test.run).toHaveBeenCalledWith("@cf/cloudflare/clef-flash", {
      model: "clef-flash",
      state: [
        "Group chat members: Ada, Charles Babbage, Mary Somerville, Michael Faraday.",
        "",
        "Earlier messages, context only:",
        ...test.messages.slice(0, -1).map((_, i) => `Person ${i}: line ${i}`),
        "",
        "Latest message:",
        "Person 14: line 14",
      ].join("\n"),
      questions: {
        a0: question("Charles Babbage"), r0: reactionQuestion("Charles Babbage"),
        a1: question("Mary Somerville"), r1: reactionQuestion("Mary Somerville"),
        a2: question("Michael Faraday"), r2: reactionQuestion("Michael Faraday"),
      },
    }, { signal: expect.any(AbortSignal) });
    expect(test.list).toHaveBeenCalledExactlyOnceWith("group", { order: "desc", limit: 15 });
  });

  it("reads one 15-message page for Clef and returns no history", async () => {
    const test = setup(0.8752);
    test.messages.unshift(...Array.from({ length: 335 }, (_, index) => ({
      id: `old-${index}`, is_from_me: false, from_handle: { display_name: "Ada" },
      parts: [{ type: "text", value: `premise ${index}` }],
    })) as Message[]);
    const result = await prepareSpeakGate(test.env, fromAgent(test.event), test.deps);
    expect(result).toEqual({ kind: "turn" });
    expect(test.list).toHaveBeenCalledExactlyOnceWith("group", { order: "desc", limit: 15 });
    const state = (test.run.mock.calls[0] as unknown as [string, { state: string }])[1].state;
    expect(state).not.toContain("premise");
    expect(state.split("\n").filter((line) => line.startsWith("Person "))).toHaveLength(15);
  });

  it("uses a custom stagger, including zero delay", async () => {
    const test = setup(0.25, [0.3, 0.1]);
    expect(await prepareSpeakGate({ ...test.env, RELAY_SPEAK_STAGGER_S: "4" }, test.event, test.deps))
      .toEqual({ kind: "deferred", delay: 4 });
    const zero = setup(0.25, [0.3, 0.1]);
    expect(await prepareSpeakGate({ ...zero.env, RELAY_SPEAK_STAGGER_S: "0" }, zero.event, zero.deps))
      .toMatchObject({ kind: "turn" });
  });

  it("reuses a saved decision across restart and reloads history only after the stagger", async () => {
    vi.useFakeTimers();
    const test = setup(0.25, [0.3, 0.1]);
    expect(await prepareSpeakGate(test.env, test.event, test.deps)).toEqual({ kind: "deferred", delay: 10 });
    // A new dependency object, backed by the same durable value.
    const resumed = { ...test.deps, get: () => test.saved() };
    expect(await prepareSpeakGate(test.env, test.event, resumed)).toEqual({ kind: "deferred", delay: 10 });
    expect(test.list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await prepareSpeakGate(test.env, test.event, resumed)).toEqual({ kind: "turn" });
    expect(test.run).toHaveBeenCalledTimes(1);
    expect(test.list).toHaveBeenCalledTimes(2);
  });

  it("waits a whole scheduler second on an early alarm rather than spinning", async () => {
    vi.useFakeTimers();
    const test = setup(0.25, [0.3, 0.1]);
    await prepareSpeakGate(test.env, test.event, test.deps);
    await vi.advanceTimersByTimeAsync(9_900);
    expect(await prepareSpeakGate(test.env, test.event, test.deps)).toEqual({ kind: "deferred", delay: 1 });
    expect(test.run).toHaveBeenCalledTimes(1);
  });

  it("fails open at three seconds and aborts an unresponsive Clef call", async () => {
    vi.useFakeTimers();
    const test = setup();
    test.run.mockImplementation(() => new Promise(() => {}));
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    let finished = false;
    const result = prepareSpeakGate(test.env, test.event, test.deps).then((value) => { finished = true; return value; });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ kind: "turn" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"error_type":"TimeoutError"'));
    expect(test.saved()?.spoke).toBe(true);
  });

  it.each([NaN, -0.1, 1.1])("fails open for an invalid probability %s", async (p) => {
    const test = setup(p);
    expect(await prepareSpeakGate(test.env, test.event, test.deps)).toMatchObject({ kind: "turn" });
    expect(test.saved()?.spoke).toBe(true);
  });

  it("still gives a turn, in Clef's order, on a reply to someone else", async () => {
    const test = setup(0.25, [0.3, 0.28]);
    expect(await prepareSpeakGate(test.env, { ...test.event, data: { ...test.event.data, reply_to: { message_id: "12" } } }, test.deps))
      .toEqual({ kind: "deferred", delay: 20 });
    expect(test.run).toHaveBeenCalledTimes(1);
  });

  it("does not call Clef when disabled or for direct, outbound, or own messages", async () => {
    const test = setup();
    await prepareSpeakGate({}, test.event, test.deps);
    for (const data of [
      { ...test.event.data, chat: { ...test.event.data.chat, is_group: false } },
      { ...test.event.data, direction: "outbound" },
      { ...test.event.data, sender_handle: { is_me: true } },
    ]) expect(await prepareSpeakGate(test.env, { ...test.event, data }, test.deps)).toEqual({ kind: "turn" });
    expect(test.run).not.toHaveBeenCalled();
    expect(test.list).not.toHaveBeenCalled();
  });

  it("sets the latest message apart from earlier ones, even when it has several lines", () => {
    const state = clefState(["Ada", "Michael Faraday"], ["Ada: hi", "Charles Babbage: hello", "Ada: How do I cut costs?\nWe spend $40k a month."]);
    expect(state.endsWith("Latest message:\nAda: How do I cut costs?\nWe spend $40k a month.")).toBe(true);
    expect(state).toContain("Earlier messages, context only:\nAda: hi\nCharles Babbage: hello\n");
    expect(clefState(["Ada", "Michael Faraday"], ["Ada: first"])).toBe("Group chat members: Ada, Michael Faraday.\n\nLatest message:\nAda: first");
  });


  const fromPerson = (event: ReturnType<typeof setup>["event"], extra: Record<string, unknown> = {}) =>
    ({ ...event, data: { ...event.data, sender_handle: { is_me: false, kind: "user" }, ...extra } });

  // In a seven-clone group, every clone took a turn on every message and
  // the person said "there are too many people".
  it("speaks only when Clef scores it within 0.8 of the top among the other agents", async () => {
    const quiet = setup(0.2, [0.3, 0.1]);
    expect(await prepareSpeakGate(quiet.env, fromPerson(quiet.event), quiet.deps)).toEqual({ kind: "silent" });
    expect(quiet.saved()?.spoke).toBe(false);
    const close = setup(0.25, [0.3, 0.1]);
    expect(await prepareSpeakGate(close.env, fromPerson(close.event), close.deps)).toEqual({ kind: "deferred", delay: 10 });
    const first = setup(0.9, [0.1, 0.1]);
    expect(await prepareSpeakGate(first.env, fromPerson(first.event), first.deps)).toMatchObject({ kind: "turn" });
  });

  it("always speaks when named, mentioned or replied to, behind only the other speakers", async () => {
    const cases: Array<[Record<string, unknown>, ((test: ReturnType<typeof setup>) => void)?]> = [
      [{ parts: [{ type: "text", value: "charles what do you think" }] }],
      [{ parts: [{ type: "text", value: "Charles", mention: "charlesbabbage" }] }],
      [{ parts: [{ type: "text", value: "@marysomerville @charlesbabbage thoughts?", mention: "marysomerville", mentions: [{ handle: "marysomerville", is_me: false }, { handle: "charlesbabbage", is_me: true }] }] }],
      [{ reply_to: { message_id: "old" } }, (test) => test.retrieve.mockResolvedValueOnce({ is_from_me: true })],
    ];
    for (const [extra, prepare] of cases) {
      // Mary ranks first and speaks; Michael is far below the top and does not,
      // so Charles waits one step, not two.
      const test = setup(0.05, [0.9, 0.1]);
      prepare?.(test);
      expect(await prepareSpeakGate(test.env, fromPerson(test.event, extra), test.deps)).toEqual({ kind: "deferred", delay: 10 });
    }
    const unnamed = setup(0.05, [0.9, 0.1]);
    expect(await prepareSpeakGate(unnamed.env, fromPerson(unnamed.event), unnamed.deps)).toEqual({ kind: "silent" });
  });

  // In a seven-clone group, "that inspired all of you guys" got four of seven
  // clones; the other three stayed silent.
  it("gives every clone a turn when a person's message asks every member", async () => {
    const asked = setup(0.05, [0.9, 0.1]);
    const asksEveryone = vi.fn(async () => true);
    expect(await prepareSpeakGate(asked.env, fromPerson(asked.event), { ...asked.deps, asksEveryone }))
      .toEqual({ kind: "deferred", delay: 20 });
    expect(asksEveryone).toHaveBeenCalledExactlyOnceWith(["Ada", "Charles Babbage", "Mary Somerville", "Michael Faraday"], expect.stringContaining("Person 14: line 14"));
    const notAsked = setup(0.05, [0.9, 0.1]);
    expect(await prepareSpeakGate(notAsked.env, fromPerson(notAsked.event), { ...notAsked.deps, asksEveryone: vi.fn(async () => false) }))
      .toEqual({ kind: "silent" });
    const failed = setup(0.05, [0.9, 0.1]);
    expect(await prepareSpeakGate(failed.env, fromPerson(failed.event), { ...failed.deps, asksEveryone: vi.fn(async () => { throw new Error("down"); }) }))
      .toEqual({ kind: "silent" });
    const fromClone = setup(0.05, [0.9, 0.1]);
    const notCalled = vi.fn(async () => true);
    expect(await prepareSpeakGate(fromClone.env, fromAgent(fromClone.event), { ...fromClone.deps, asksEveryone: notCalled }))
      .toEqual({ kind: "silent" });
    expect(notCalled).not.toHaveBeenCalled();
  });

  it("is not given the turn when another agent only names it", async () => {
    const named = { parts: [{ type: "text", value: "Charles named the Difference Engine, and Michael named the motor." }] };
    const byClone = setup(0.05, [0.9, 0.1]);
    expect(await prepareSpeakGate(byClone.env, fromAgent(byClone.event, named), byClone.deps)).toEqual({ kind: "silent" });
    const byPerson = setup(0.05, [0.9, 0.1]);
    // Mary ranks first; Michael is named too, so Charles speaks third.
    expect(await prepareSpeakGate(byPerson.env, fromPerson(byPerson.event, named), byPerson.deps)).toEqual({ kind: "deferred", delay: 20 });
  });

  it("after answering the person, speaks again on another agent's message only when tagged or replied to", async () => {
    const answeredAlready = (test: ReturnType<typeof setup>) => {
      test.messages[12] = { ...test.messages[12]!, from_handle: { display_name: "Ada", kind: "user" } } as Message;
      test.messages[13] = { ...test.messages[13]!, is_from_me: true } as Message;
    };
    const again = setup(0.9, [0.1, 0.1]);
    answeredAlready(again);
    expect(await prepareSpeakGate(again.env, fromAgent(again.event), again.deps)).toEqual({ kind: "silent" });
    const tagged = setup(0.9, [0.1, 0.1]);
    answeredAlready(tagged);
    expect(await prepareSpeakGate(tagged.env, fromAgent(tagged.event, { parts: [{ type: "text", value: "Charles?", mention: "charlesbabbage" }] }), tagged.deps))
      .toMatchObject({ kind: "turn" });
    const notYet = setup(0.9, [0.1, 0.1]);
    expect(await prepareSpeakGate(notYet.env, fromAgent(notYet.event), notYet.deps)).toMatchObject({ kind: "turn" });
    const person = setup(0.9, [0.1, 0.1]);
    answeredAlready(person);
    expect(await prepareSpeakGate(person.env, fromPerson(person.event), person.deps)).toMatchObject({ kind: "turn" });
  });

  it("re-checks after the wait and holds back on a clone's message when it answered meanwhile", async () => {
    vi.useFakeTimers();
    const test = setup(0.25, [0.3, 0.1]);
    test.messages[12] = { ...test.messages[12]!, from_handle: { display_name: "Ada", kind: "user" } } as Message;
    expect(await prepareSpeakGate(test.env, fromAgent(test.event), test.deps)).toEqual({ kind: "deferred", delay: 10 });
    // While it waited, this agent answered the person's message.
    test.messages.push({ id: "15", is_from_me: true, from_handle: { display_name: "Charles Babbage" }, parts: [{ type: "text", value: "my answer" }] } as Message);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await prepareSpeakGate(test.env, fromAgent(test.event), test.deps)).toEqual({ kind: "silent" });
    expect(test.saved()?.spoke).toBe(false);
    const tagged = setup(0.25, [0.3, 0.1]);
    const tag = { parts: [{ type: "text", value: "Mary and Charles?", mention: "marysomerville", mentions: [{ handle: "marysomerville", is_me: false }, { handle: "charlesbabbage", is_me: true }] }] };
    expect(await prepareSpeakGate(tagged.env, fromAgent(tagged.event, tag), tagged.deps)).toEqual({ kind: "deferred", delay: 10 });
    tagged.messages.push({ id: "15", is_from_me: true, from_handle: { display_name: "Charles Babbage" }, parts: [{ type: "text", value: "my answer" }] } as Message);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await prepareSpeakGate(tagged.env, fromAgent(tagged.event, tag), tagged.deps)).toMatchObject({ kind: "turn" });
    // A reply to one of its messages older than the 15 read is looked up in Relay.
    for (const [isFromMe, kind] of [[true, "turn"], [false, "silent"]] as const) {
      const replied = setup(0.25, [0.3, 0.1]);
      replied.messages[12] = { ...replied.messages[12]!, from_handle: { display_name: "Ada", kind: "user" } } as Message;
      const reply = { reply_to: { message_id: "older-than-the-page" } };
      expect(await prepareSpeakGate(replied.env, fromAgent(replied.event, reply), replied.deps)).toEqual({ kind: "deferred", delay: 10 });
      replied.messages.push({ id: "15", is_from_me: true, from_handle: { display_name: "Charles Babbage" }, parts: [{ type: "text", value: "my answer" }] } as Message);
      replied.retrieve.mockResolvedValueOnce({ is_from_me: isFromMe });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await prepareSpeakGate(replied.env, fromAgent(replied.event, reply), replied.deps)).toMatchObject({ kind });
      expect(replied.retrieve).toHaveBeenLastCalledWith("older-than-the-page");
    }
  });

  it("holds back its waited turn on the person's message when it already answered during the wait", async () => {
    vi.useFakeTimers();
    const test = setup(0.25, [0.3, 0.1]);
    expect(await prepareSpeakGate(test.env, fromPerson(test.event), test.deps)).toEqual({ kind: "deferred", delay: 10 });
    test.messages.push({ id: "15", is_from_me: true, from_handle: { display_name: "Charles Babbage" }, parts: [{ type: "text", value: "my answer" }] } as Message);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await prepareSpeakGate(test.env, fromPerson(test.event), test.deps)).toEqual({ kind: "silent" });
    const quiet = setup(0.25, [0.3, 0.1]);
    expect(await prepareSpeakGate(quiet.env, fromPerson(quiet.event), quiet.deps)).toEqual({ kind: "deferred", delay: 10 });
    quiet.messages.push({ id: "15", is_from_me: false, from_handle: { display_name: "Mary Somerville", kind: "agent" }, parts: [{ type: "text", value: "Mary's answer" }] } as Message);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await prepareSpeakGate(quiet.env, fromPerson(quiet.event), quiet.deps)).toMatchObject({ kind: "turn" });
  });

  it("never lets the sender answer itself or set the top score", async () => {
    const test = setup(0.3, [0.9, 0.1]);
    const fromMary = fromAgent(test.event, { sender_handle: { is_me: false, kind: "agent", handle: "marysomerville" } });
    expect(await prepareSpeakGate(test.env, fromMary, test.deps)).toMatchObject({ kind: "turn" });
  });

  it("breaks a tied score by the order of agents in the chat, the same on every peer", async () => {
    const ahead = setup(0.4, [0.4, 0.4]);
    expect(await prepareSpeakGate(ahead.env, fromPerson(ahead.event), ahead.deps)).toMatchObject({ kind: "turn" });
    const behind = setup(0.4, [0.4, 0.4]);
    behind.chat.mockResolvedValueOnce({ handles: [
      { kind: "agent", handle: "marysomerville", display_name: "Mary Somerville", status: "active" },
      { kind: "agent", handle: "charlesbabbage", display_name: "Charles Babbage", status: "active" },
    ] });
    expect(await prepareSpeakGate(behind.env, fromPerson(behind.event), behind.deps)).toEqual({ kind: "deferred", delay: 10 });
  });

  it("orders only agents that run the gate", async () => {
    const test = setup(0.3, [0.2, 0.25]);
    test.chat.mockResolvedValueOnce({ handles: [
      { kind: "user", handle: "ada", display_name: "Ada", status: "active" },
      { kind: "agent", handle: "relay", display_name: "Relay", status: "active" },
      { kind: "agent", handle: "charlesbabbage", display_name: "Charles Babbage", status: "active" },
      { kind: "agent", handle: "marysomerville", display_name: "Mary Somerville", status: "active" },
      { kind: "agent", handle: "michaelfaraday", display_name: "Michael Faraday", status: "active" },
    ] });
    expect(await prepareSpeakGate(test.env, fromPerson(test.event), test.deps)).toMatchObject({ kind: "turn" });
    const questions = (test.run.mock.calls[0] as unknown as [string, { questions: Record<string, { instructions: string }> }])[1].questions;
    expect(Object.keys(questions)).toEqual(["a0", "r0", "a1", "r1", "a2", "r2"]);
    expect([questions.a0, questions.a1, questions.a2].map((q) => q!.instructions)).toEqual(["Charles Babbage", "Mary Somerville", "Michael Faraday"].map((name) => `How much is the latest message meant for ${name}, either because it names ${name} or because it is about ${name}'s own work and expertise?`));
  });

  it("keeps Clef's lines plain, with no time", async () => {
    const test = setup(0.9);
    test.messages.forEach((message, index) => {
      message.sent_at = index < 14 ? "2026-11-05T08:14:00Z" : "2026-11-05T16:13:00Z";
    });
    const data = { ...test.event.data, sender_handle: { is_me: false, kind: "user", timezone: "America/Detroit" } };
    await prepareSpeakGate(test.env, { ...test.event, data }, test.deps);
    const state = (test.run.mock.calls[0] as unknown as [string, { state: string }])[1].state;
    expect(state).not.toContain("AM");
  });

  it("scores only up to the triggering message, so every clone sends Clef the same text", async () => {
    const test = setup(0.6);
    await prepareSpeakGate(test.env, { ...test.event, data: { ...test.event.data, id: "12" } }, test.deps);
    const state = (test.run.mock.calls[0] as unknown as [string, { state: string }])[1].state;
    expect(state.endsWith("Latest message:\nPerson 12: line 12")).toBe(true);
    expect(state).not.toContain("line 13");
  });

  it("Clef decides whether to react; the agent's own model picks the emoji, tapped as a custom reaction", async () => {
    const test = setup(0.25, [0.3, 0.28], 0.82, "🚀");
    const kept: Promise<unknown>[] = [];
    expect(await prepareSpeakGate(test.env, test.event, { ...test.deps, waitUntil: (task) => kept.push(task) })).toEqual({ kind: "deferred", delay: 20 });
    await Promise.all(kept);
    expect(test.pickReaction).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Person 14: line 14"));
    expect(test.addReaction).toHaveBeenCalledExactlyOnceWith("14", { operation: "add", type: "custom", custom_emoji: "🚀" });
  });

  it("accepts exactly one emoji, flags and keycaps included, within 32 code points", () => {
    for (const ok of ["🚀", "👍🏽", "👨‍💻", "🇺🇸", "1️⃣", "❤️"]) expect(isOneEmoji(ok), ok).toBe(true);
    for (const no of ["NONE", "ok 👍", "🚀🚀", "#", "a", `🚀${"\uFE0F".repeat(32)}`]) expect(isOneEmoji(no), no).toBe(false);
  });

  it("taps Relay's own tapback when the model picks one of its emoji", async () => {
    const test = setup(0.25, [0.3, 0.28], 0.7, "👍");
    const kept: Promise<unknown>[] = [];
    await prepareSpeakGate(test.env, test.event, { ...test.deps, waitUntil: (task) => kept.push(task) });
    await Promise.all(kept);
    expect(test.addReaction).toHaveBeenCalledExactlyOnceWith("14", { operation: "add", type: "like" });
  });

  it("asks the model nothing below 0.7, and taps nothing when the model picks none", async () => {
    // 0.65 would have fired under the old 0.5 bar; the bar is 0.7 now.
    const low = setup(0.25, [0.3, 0.28], 0.65);
    await prepareSpeakGate(low.env, low.event, low.deps);
    expect(low.pickReaction).not.toHaveBeenCalled();
    const none = setup(0.25, [0.3, 0.28], 0.9, null);
    const kept: Promise<unknown>[] = [];
    await prepareSpeakGate(none.env, none.event, { ...none.deps, waitUntil: (task) => kept.push(task) });
    await Promise.all(kept);
    expect(none.addReaction).not.toHaveBeenCalled();
  });

  it("does not react when the triggering message is not in the fetched history", async () => {
    const test = setup(0.25, [0.3, 0.28], 0.9);
    await prepareSpeakGate(test.env, { ...test.event, data: { ...test.event.data, id: "older" } }, test.deps);
    expect(test.addReaction).not.toHaveBeenCalled();
  });

  it("does not wait for the reaction before deciding", async () => {
    const test = setup(0.9, [0.1, 0.1], 0.8);
    let release!: () => void;
    test.addReaction.mockImplementationOnce(() => new Promise((ok) => { release = () => ok({}); }));
    const kept: Promise<unknown>[] = [];
    const result = await prepareSpeakGate(test.env, test.event, { ...test.deps, waitUntil: (task) => kept.push(task) });
    expect(result).toMatchObject({ kind: "turn" });
    expect(kept).toHaveLength(1);
    release();
    await kept[0];
  });

  it("a failed reaction never blocks the reply decision", async () => {
    const test = setup(0.9, [0.1, 0.1], 0.8);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    test.addReaction.mockRejectedValueOnce(new Error("refused"));
    expect(await prepareSpeakGate(test.env, test.event, test.deps)).toMatchObject({ kind: "turn" });
  });

  it("keeps its decision after the stagger and takes the turn without asking Clef again", async () => {
    vi.useFakeTimers();
    const waits = setup(0.25, [0.3, 0.1]);
    expect(await prepareSpeakGate(waits.env, fromPerson(waits.event), waits.deps)).toEqual({ kind: "deferred", delay: 10 });
    waits.messages.push({ id: "15", is_from_me: false, from_handle: { display_name: "Mary Somerville" }, parts: [{ type: "text", value: "the reply" }] } as Message);
    await vi.advanceTimersByTimeAsync(10_000);
    const resumed = await prepareSpeakGate(waits.env, fromPerson(waits.event), waits.deps);
    expect(resumed).toEqual({ kind: "turn" });
    expect(waits.run).toHaveBeenCalledTimes(1);
  });

  it("taps a reaction only on a person's message", async () => {
    const test = setup(0.9, [0.1, 0.1], 0.95, "🚀");
    const kept: Promise<unknown>[] = [];
    await prepareSpeakGate(test.env, fromAgent(test.event), { ...test.deps, waitUntil: (task) => kept.push(task) });
    await Promise.all(kept);
    expect(test.pickReaction).not.toHaveBeenCalled();
  });

  it("fails open when this agent is not an active member", async () => {
    const test = setup(0.1);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    test.chat.mockResolvedValueOnce({ handles: [{ kind: "agent", handle: "marysomerville", display_name: "Mary Somerville", status: "active" }] });
    expect(await prepareSpeakGate(test.env, test.event, test.deps)).toMatchObject({ kind: "turn" });
  });

  it("enables every-group ingress only with the explicit true flag", () => {
    expect(everyGroupMessageEnabled({})).toBe(false);
    expect(everyGroupMessageEnabled({ RELAY_EVERY_GROUP_MESSAGE: "false" })).toBe(false);
    expect(everyGroupMessageEnabled({ RELAY_EVERY_GROUP_MESSAGE: "true" })).toBe(true);
  });
});
