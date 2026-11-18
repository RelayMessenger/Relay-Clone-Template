import {
  defaultContextOverflowClassifier,
  type Session,
  Think,
  type PrepareStepContext,
  type PrepareStepResult,
  type StepConfig,
  type StepContext,
  type ToolCallContext,
  type TurnConfig,
  type TurnContext,
} from "@cloudflare/think";
import {
  chatSdkMessenger,
  defaultChatSdkEvent,
  normalizeMessengers,
  ThinkMessengerStateAgent,
  type ThinkMessengers,
  toMessengerUserMessage,
} from "@cloudflare/think/messengers";
import {
  createRelayAdapter,
  decodeRelayThreadId,
  type RelayAdapter,
} from "@relaymessenger/chat-sdk-adapter";
import { getAgentByName } from "agents";
import type Relay from "@relaymessenger/sdk";
import { type Message, RelayAPIError } from "@relaymessenger/sdk";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  createRelayTurnSettled,
  RELAY_TURN_MAX_STEPS,
  relayActions,
  type RelayActionDependencies,
  type RelayTurnIdentity,
} from "@relaymessenger/think/actions";
import { searchSourcesActions } from "./search-sources-action";
import { chatEventContext, RELAY_CHAT_CONTEXT_EVENT_TYPES } from "@relaymessenger/think";
import { RELAY_CHAT_OPENED_EVENT } from "./chat-opened";
import { RelayGenerationActivities } from "@relaymessenger/think";
import {
  type InboundMedia,
  type DocumentReader,
  inlineInboundMedia,
  NO_INBOUND_MEDIA,
  withInboundMedia,
} from "@relaymessenger/think";
import { generateText, type LanguageModel, type ToolSet, type UIMessage, wrapLanguageModel } from "ai";

import type { Bindings } from "./env";
import {
  configurationErrors,
  everyGroupMessageEnabled,
  relayMarkReadOnReceipt,
  requireRelayToken,
  requireRelayWebhookSecret,
} from "./env";
import { withoutPastThoughtSignatures } from "@relaymessenger/think";
import { relayModel, relaySummaryModel, relayUrlContextTool, relayWebSearchTool } from "./model";
import { groupTimeHeader, mergeGroupHistory, relaySessionId, validTimezone } from "./group-history";
import {
  URL_CONTEXT_TOOL,
  WEB_SEARCH_GUIDANCE,
  WEB_SEARCH_TOOL,
  urlContextUse,
  webSearchEnabled,
  webSearchUse,
} from "./web-search";
import { withEveryGroupMessage } from "./every-group-message";
import { createGroupCompactFunction } from "./group-compaction";
import { asksEveryMember, pickCloneReaction, prepareSpeakGate, type SpeakDecision } from "./speak-gate";
import { AGENT_THINKING_LEVEL, agentSystemPrompt } from "./personas";
import { paymentEventContext, RELAY_PAYMENT_EVENT_TYPES } from "@relaymessenger/think";
import { RELAY_WEBHOOK_PATH } from "./subscription";
import { withLocationShares } from "@relaymessenger/think";
import { withCardReplies } from "@relaymessenger/think";
import { withSelectionReplies } from "@relaymessenger/think";
import { RELAY_MESSENGER_DELIVERY, replyContext } from "@relaymessenger/think";
import {
  relayTurnMetadata,
  storedMessage,
  storedProviderMetadata,
  withoutMessengerEvent,
} from "@relaymessenger/think";
import {
  newRelayInstanceId,
  type RelayChatTiming,
  relayChatTimingLine,
  resumeRelayChatTiming,
  startRelayChatTiming,
  timedRelayModel,
} from "@relaymessenger/think";
import {
  createRelayClient,
  startRelayTypingLifecycle,
} from "@relaymessenger/think";
import {
  callEventSchema,
  isLiveRelayCallEvent,
  type RelayCallEvent,
  RELAY_CALL_EVENT_TYPES,
} from "@relaymessenger/think";
import {
  type PersonReaction,
  personReaction,
  reactionContext,
  RELAY_REACTION_DEBOUNCE_SECONDS,
  RELAY_REACTION_EVENT_TYPES,
} from "@relaymessenger/think";
import {
  authenticateRelayWebhook,
  RELAY_MESSAGE_ADMISSION_HEADER,
  RELAY_MESSAGE_SERIAL_HEADER,
  type RelayMessageAdmission,
  type RelayWebhookDelivery,
} from "./webhook";

import {
  chatLabel,
  personMemory,
  personMemoryLines,
  personMemoryName,
  personMemoryRow,
  personMemoryWrites,
  type PersonMemoryChat,
  RelayPersonMemory,
} from "@relaymessenger/think/memory";

export { RelayPersonMemory, ThinkMessengerStateAgent };

/** First request time: module-scope clocks are not real on Workers. */
let isolateBorn: number | null = null;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const RELAY_ADMISSION_TTL_MS = 10 * 60_000;
const RELAY_SENT_PARTS_TTL_MS = 30 * 24 * 60 * 60_000;
const RELAY_INTERNAL_SIGNATURE_TOLERANCE_SECONDS = 24 * 60 * 60;
const RELAY_EVENT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const RELAY_EVENT_MAX_ATTEMPTS = 6;
/**
 * Actions that put something in the chat when they succeed; after one, the
 * turn may end with no tool call. A refused send throws, so it is no result,
 * and a refused location request returns not_requested.
 */
const RELAY_VISIBLE_ACTIONS: ReadonlySet<string> = new Set([
  "send",
  "react",
  "request_location",
  "share_contact_card",
]);
/**
 * A person's reaction turn: the model may write, react back on the part they
 * reacted to, or stay silent.
 */
const REACTION_TURN_ACTIONS: ReadonlySet<string> = new Set([
  "send",
  "react",
  "stay_silent",
]);
const RELAY_EVENT_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 60_000, 5 * 60_000];
/**
 * Durable Object KV key: the stored-history format this Chat's rows were last
 * rewritten to (src/stored-history.ts). Bump the value to run the pass again.
 */
const RELAY_STORED_HISTORY_KEY = "relay_stored_history";
const RELAY_STORED_HISTORY_VERSION = 1;
/**
 * Durable Object KV key: this group Chat's Session holds every Message of
 * the group, the ones said before it did included (backfillRelayGroup).
 */
const RELAY_GROUP_HISTORY_KEY = "relay_group_history";
const RELAY_GROUP_HISTORY_VERSION = 1;
/** KV: the newest group Message's send time, and the newest person's timezone,
 * for the next Message's time header (group-history.ts groupTimeHeader). */
const RELAY_GROUP_LAST_AT_KEY = "relay_group_last_at";
const RELAY_GROUP_TIMEZONE_KEY = "relay_group_timezone";
/**
 * When Think compacts the Session (src/group-compaction.ts, on the range
 * agents/sessions `createCompactFunction` picks): past RELAY_COMPACT_AFTER
 * estimated tokens, everything but the first three Messages and the newest
 * RELAY_KEEP_RECENT_TOKENS becomes one summary: every person's Message word
 * for word, and the agents' Messages summarized by the small summary model
 * (src/model.ts relaySummaryModel).
 *
 * Gemini 4 Hydrogen takes 1,048,576 tokens, input and output together, and
 * writes up to 65,536 per segment (Vertex model page). The recent
 * tail stays the 100,000 tokens a replay of a real seven-clone group measured
 * reply quality on (300-message history, 400,000 characters, the cap
 * src/speak-gate.ts applied before this change). 200,000 keeps a turn's input at or
 * under what a clone sent before (the 100,000-token cap plus up to 100,000 of
 * pasted group history), so cost per turn does not rise, and it leaves the
 * Session's character-based estimate (chars / 4) five times its size in
 * headroom under the window, for thinking, tool results and media.
 *
 * The summary counts toward the threshold. Its person part grows with every
 * compaction (on a real 1,797-message group: about 44,000 tokens), so a turn
 * reads up to the threshold plus that part; src/group-compaction.ts states
 * the person part's budget (PERSON_BLOCK_BUDGET_TOKENS) and skips a
 * compaction that would summarize under 50,000 tokens, so a large summary
 * never starts a summary call on every Message.
 */
const RELAY_COMPACT_AFTER = 200_000;
const RELAY_KEEP_RECENT_TOKENS = 100_000;
/** Relay's page size maximum (the Relay API's OpenAPI contract). */
const RELAY_PAGE_LIMIT = 100;
/**
 * How long a group Message waits for a running turn to finish before it is
 * written: a row written mid-turn would sit before that turn's reply. A newer
 * Message supersedes the running turn at receipt, so the wait is short.
 */
const RELAY_GROUP_WRITE_WAIT_MS = 30_000;
type RelayEventState = "pending" | "processing" | "settled" | "terminal";

interface RelayEventRow {
  [column: string]: string | number | null;
  admission_message_id: string | null;
  admission_sent_at: number | null;
  attempts: number;
  body: string;
  event_id: string;
  event_type: string;
  headers_json: string;
  received_at: number;
  serial_message_id: string | null;
  serial_sent_at: number | null;
  state: RelayEventState;
  url: string;
}

interface RelayCallEventRow {
  [column: string]: string | number | null;
  attempts: number;
  body: string;
  call_id: string;
  event_id: string;
  event_type: string;
  received_at: number;
  state: RelayEventState;
}

class RetryableRelayDeliveryError extends Error {
  constructor(readonly status: number) {
    super(`Relay Chat SDK delivery returned HTTP ${status}`);
    this.name = "RetryableRelayDeliveryError";
  }
}
const ABORT_TEXT =
  /\b(?:abort(?:ed|ing)?|cancel(?:ed|led|ation)?|interrupt(?:ed|ion)|supersed(?:ed|ing))\b/iu;

function isAbortLikeError(error: unknown, seen = new Set<object>()): boolean {
  if (typeof error === "string") return ABORT_TEXT.test(error);
  if (typeof error !== "object" || error === null || seen.has(error)) {
    return false;
  }
  seen.add(error);
  const candidate = error as {
    cause?: unknown;
    code?: unknown;
    message?: unknown;
    name?: unknown;
  };
  if (
    candidate.name === "AbortError"
    || candidate.code === "ABORT_ERR"
    || candidate.code === DOMException.ABORT_ERR
    || (
      typeof candidate.message === "string"
      && ABORT_TEXT.test(candidate.message)
    )
  ) {
    return true;
  }
  return isAbortLikeError(candidate.cause, seen);
}

interface RelayReactionRow {
  [column: string]: string | number | null;
  event_id: string;
  received_at: number;
  base_message_id: string | null;
  reaction_json: string;
  turn_id: string | null;
}

interface ActiveRelayTurn extends RelayTurnIdentity {
  supersessionSignal: AbortSignal;
  /**
   * Started by an event (an unanswered Call, a person's reaction), not a
   * Message: only these Actions are offered to the model.
   */
  actions?: ReadonlySet<string>;
  // Started when the turn is admitted so the downloads overlap Think's context
  // assembly, and awaited in beforeTurn. It never rejects.
  inboundMedia: Promise<InboundMedia>;
  /**
   * Starts the typing indicator once per turn. A group turn calls it at the
   * model's first tool call that is not stay_silent, so a clone that decides
   * to stay silent never shows typing.
   */
  startTyping?: () => Promise<unknown>;
}

export class RelayChatAgent extends Think<Bindings> {
  // No hydrationByteBudget override: Think's default (32 MiB) bounds isolate
  // memory, which is its only purpose (think.js _syncMessages). The
  // 256 KiB override hydrated 85 of 396 stored Messages in a real chat
  // (934 KB, mostly adapter metadata and Gemini thought signatures), so the
  // model lost history the Session keeps (configureSession); the
  // cold-start saving it was set for was not measurable.
  override includeMcpTools = false;
  override maxSteps = 1;
  override sendReasoning = false;
  override actionLedgerPendingRetryLeaseMs: number | false = false;
  override chatRecovery = {
    maxAttempts: 6,
    terminalMessage: "",
  };
  // A turn the provider rejects for length is compacted and run again once
  // (Think "Context-window overflow recovery").
  override contextOverflow = { reactive: true };
  // No read-time truncation (Think "Prompt caching": Infinity turns it off,
  // paired with compaction). It cuts every older text part to 10,000
  // characters, the compaction summary included, and the summary carries
  // every person's Message word for word (src/group-compaction.ts).
  // Compaction keeps the conversation bounded (RELAY_COMPACT_AFTER).
  override truncationStep = Number.POSITIVE_INFINITY;
  override classifyChatError = defaultContextOverflowClassifier;

  /**
   * Think keeps the whole conversation in its Session; past the threshold the
   * older middle becomes a summary instead of being dropped.
   */
  override configureSession(session: Session): Session {
    return session
      .onCompaction(createGroupCompactFunction({
        summarize: async (prompt) => (await generateText({ model: relaySummaryModel(this.env), prompt })).text,
        keepRecentTokens: RELAY_KEEP_RECENT_TOKENS,
        selfName: `You (@${this.env.RELAY_AGENT_HANDLE})`,
      }))
      .compactAfter(RELAY_COMPACT_AFTER);
  }

  // In a Chat with one person, the turn also reads what that person said in
  // their other Chats with this agent (@relaymessenger/think/memory), reading
  // each shared group's recent talk from Relay, as a member would see it.
  private readonly memory = personMemory(this, {
    binding: this.env.RelayPersonMemory,
    chat: () => this.relayMemoryChat(),
    relay: createRelayClient(this.env),
  });
  private readonly relayConstructedAt: number;
  private relayOnStartAt!: number;
  private relayHandledRequest = false;

  constructor(ctx: DurableObjectState, env: Bindings) {
    const started = performance.now();
    super(ctx, env);
    this.relayConstructedAt = started;
  }

  override async onStart(
    props: Parameters<Think<Bindings>["onStart"]>[0],
  ): Promise<void> {
    this.relayOnStartAt = performance.now();
    await super.onStart?.(props);
    // Think calls this hook after its session is set up and hydrated, before
    // recovery runs, so no turn writes while the rows are rewritten.
    await this.slimStoredHistory();
  }

  /**
   * Rewrite rows stored before src/stored-history.ts to the stored form, once
   * per Chat: the person's Messages lose the adapter's raw webhook, tool calls
   * lose the second copy of their Gemini thought signature. Only rows that
   * change are written, through Think's own update path, so its live message
   * cache stays in step. What the model is sent does not change.
   */
  private async slimStoredHistory(): Promise<void> {
    const kv = this.ctx.storage.kv;
    if (kv.get(RELAY_STORED_HISTORY_KEY) === RELAY_STORED_HISTORY_VERSION) return;
    const started = performance.now();
    try {
      const rewritten: UIMessage[] = [];
      for await (const message of this.session.history()) {
        const stored = storedMessage(message as UIMessage);
        if (stored !== message) rewritten.push(stored);
      }
      for (const message of rewritten) {
        await this.updateMessageInHistory(message);
      }
      kv.put(RELAY_STORED_HISTORY_KEY, RELAY_STORED_HISTORY_VERSION);
      console.log(JSON.stringify({
        event: "relay_stored_history_slimmed",
        rewritten: rewritten.length,
        ms: Math.round(performance.now() - started),
      }));
    } catch (error) {
      // The rows are still valid, only larger; the next start tries again.
      console.error(JSON.stringify({
        event: "relay_stored_history_slim_failed",
        error_type: error instanceof Error ? error.name : typeof error,
      }));
    }
  }

  private noteRelayRequest(): boolean {
    const cold = !this.relayHandledRequest;
    this.relayHandledRequest = true;
    if (cold) {
      // Think captures our hook and calls it between session setup and recovery.
      const firstRequestAt = performance.now();
      console.log(JSON.stringify({
        event: "relay_object_start",
        instance: this.relayInstanceId,
        ms: {
          constructed_to_on_start: Math.round(this.relayOnStartAt - this.relayConstructedAt),
          on_start_to_first_request: Math.round(firstRequestAt - this.relayOnStartAt),
          total: Math.round(firstRequestAt - this.relayConstructedAt),
        },
      }));
    }
    return cold;
  }
  private irreversibleSend = false;
  private readonly relayActivities = new RelayGenerationActivities();
  private relayAdapter?: RelayAdapter;
  private relayAdmissionSchemaReady = false;
  private relayActionChoicesDropped = false;
  private relayEventSchemaReady = false;
  private relayCallEventSchemaReady = false;
  private relayLiveCallSchemaReady = false;
  private relayReactionSchemaReady = false;
  private relayWebhookTail: Promise<void> = Promise.resolve();
  private readonly activeRelayTurns = new Map<string, AbortController>();
  /**
   * Turns started by an event rather than a Message, with the latest Message
   * id when they began: such a turn is superseded once a newer Message lands.
   */
  private readonly relayEventTurnBases = new Map<string, string | undefined>();
  private readonly relayCallbackMessages = new WeakMap<object, string>();
  private readonly trustedRelayTurns =
    new AsyncLocalStorage<ActiveRelayTurn>();
  // One id per object instance, so a cold start shows in relay_chat_timing.
  private readonly relayInstanceId = newRelayInstanceId();
  private readonly relayChatTimings = new Map<string, RelayChatTiming>();
  private readonly relayTurnTiming = new AsyncLocalStorage<RelayChatTiming>();
  private readonly relayStampTasks = new Map<string, Promise<unknown>>();
  /** Call events being processed in this object, by event_id. */
  private readonly relayCallEventRuns = new Map<string, Promise<void>>();

  override getModel(): LanguageModel {
    // resolveModel runs inside the turn, so the record is captured here and
    // read again at stream time; whichever is present wins.
    const captured = this.relayTurnTiming.getStore();
    return wrapLanguageModel({
      model: relayModel(this.env),
      middleware: [
        storedProviderMetadata,
        timedRelayModel(() => this.relayTurnTiming.getStore() ?? captured),
      ],
    });
  }

  override getSystemPrompt(): string {
    const env = this.env as { RELAY_WEB_SEARCH?: string };
    return [
      agentSystemPrompt(),
      ...(webSearchEnabled(env) ? [WEB_SEARCH_GUIDANCE] : []),
    ].join("\n\n");
  }

  /**
   * Grounding with Google Search (src/web-search.ts), where the Worker offers
   * it (RELAY_WEB_SEARCH). Every other tool is an Action.
   */
  /**
   * A group turn starts typing once the model acts on something other than
   * stay_silent. The reply never waits for the typing request to finish.
   */
  override beforeToolCall(context: ToolCallContext): void {
    if (context.toolName !== "stay_silent") {
      void this.trustedRelayTurns.getStore()?.startTyping?.();
    }
  }

  /** Google Search runs at the provider, so no beforeToolCall fires for it. */
  override onChunk(context: Parameters<Think<Bindings>["onChunk"]>[0]): void {
    const { chunk } = context;
    if (chunk.type === "tool-call" && chunk.toolName !== "stay_silent") {
      void this.trustedRelayTurns.getStore()?.startTyping?.();
    }
  }

  override getTools(): ToolSet {
    return webSearchEnabled(this.env as { RELAY_WEB_SEARCH?: string })
      ? {
        [WEB_SEARCH_TOOL]: relayWebSearchTool(this.env),
        [URL_CONTEXT_TOOL]: relayUrlContextTool(this.env),
      }
      : {};
  }

  /**
   * A step that searched Google says so in the Worker's logs: its queries and
   * any sources Gemini returned. The grounding data itself is never stored.
   */
  override onStepFinish(step: StepContext): void {
    const eventId = this.trustedRelayTurns.getStore()?.eventId;
    const use = webSearchUse(step.providerMetadata);
    if (use) {
      console.log(JSON.stringify({ event: "relay_web_search", event_id: eventId, ...use }));
    }
    const pages = urlContextUse(step.providerMetadata);
    if (pages) {
      console.log(JSON.stringify({ event: "relay_url_context", event_id: eventId, ...pages }));
    }
  }

  override onChatError(
    ...args: Parameters<Think<Bindings>["onChatError"]>
  ): unknown {
    const [error, context] = args;
    const candidate = (
      typeof error === "object" && error !== null
    )
      ? error as {
        cause?: unknown;
        name?: unknown;
        status?: unknown;
        statusCode?: unknown;
      }
      : undefined;
    const cause = (
      typeof candidate?.cause === "object" && candidate.cause !== null
    )
      ? candidate.cause as { name?: unknown }
      : undefined;
    console.error(JSON.stringify({
      event: "relay_agent_chat_error",
      stage: context?.stage ?? "unknown",
      classification: context?.classification ?? "unknown",
      error_type: typeof candidate?.name === "string"
        ? candidate.name
        : typeof error,
      ...(typeof candidate?.statusCode === "number"
        ? { status_code: candidate.statusCode }
        : typeof candidate?.status === "number"
        ? { status_code: candidate.status }
        : {}),
      ...(typeof cause?.name === "string"
        ? { cause_type: cause.name }
        : {}),
    }));
    return error;
  }

  override async fetch(request: Request): Promise<Response> {
    this.noteRelayRequest();
    const serial = this.relayMessageIdentity(
      request.headers,
      RELAY_MESSAGE_SERIAL_HEADER,
    );
    if (!serial) return super.fetch(request);

    const admission = this.relayMessageIdentity(
      request.headers,
      RELAY_MESSAGE_ADMISSION_HEADER,
    );
    if (admission) this.admitRelayMessage(admission);
    // Relay admissions update the durable chronological latest immediately,
    // but only one signed webhook may enter Chat SDK at a time. This prevents
    // its arrival-based burst queue from selecting an older request and
    // discarding a newer one. Stale queued requests still pass through Chat
    // SDK for its ack, while chatWithMessengerContext rejects them before
    // model work.
    return this.serializeRelayWebhook(() => super.fetch(request));
  }

  /**
   * Worker RPC, awaited before the public 2xx: commit the exact verified
   * delivery in this Chat's own relay_event table (deduplicated by event_id),
   * publish its chronological admission, and schedule processRelayEvent on
   * the Agents SDK scheduler (a SQLite row over the DO alarm). The Chat object
   * is the durable store; there is no second object between the webhook and
   * the turn. A throw here makes the Worker answer 503 so Relay redelivers.
   */
  async receiveRelayEvent(
    delivery: RelayWebhookDelivery,
  ): Promise<{ duplicate: boolean }> {
    const started = performance.now();
    const coldObject = this.noteRelayRequest();
    const receiveMs = { dedupe_lookup: 0, insert: 0, schedule: 0 };
    let phase: keyof typeof receiveMs | undefined = "dedupe_lookup";
    let phaseStart = started;
    try {
      this.ensureRelayEventSchema();
      const sql = this.ctx.storage.sql;
      const existing = sql.exec<{
        state: RelayEventState;
        attempts: number;
        event_type: string;
      }>(
        "SELECT state, attempts, event_type FROM relay_event WHERE event_id = ?",
        delivery.eventId,
      ).toArray()[0];
      if (existing) {
        // The event can survive a failure before the first job was inserted.
        // The SDK's idempotent schedule repairs that gap, or rearms an existing
        // job without changing its due time. Once processing has started, its
        // retry ladder owns scheduling; settled/terminal events stay finished.
        if (existing.state === "pending" && existing.attempts === 0) {
          await this.schedule(
            RELAY_REACTION_EVENT_TYPES.has(existing.event_type)
              ? RELAY_REACTION_DEBOUNCE_SECONDS : 0,
            "processRelayEvent",
            { event_id: delivery.eventId },
            { idempotent: true },
          );
        }
        return { duplicate: true };
      }

      receiveMs.dedupe_lookup = performance.now() - phaseStart;
      phase = "insert";
      phaseStart = performance.now();
      const now = Date.now();
      const timing = startRelayChatTiming({
        instance: this.relayInstanceId,
        eventId: delivery.eventId,
        receivedAt: now,
      });
      if (delivery.admission) timing.messageId = delivery.admission.messageId;
      const reaction = RELAY_REACTION_EVENT_TYPES.has(delivery.eventType)
        ? personReaction(JSON.parse(delivery.body))
        : undefined;
      // The latest Message when the reaction landed: a newer one from the
      // person supersedes the reaction's turn, as it does a Message's.
      const reactionBase = reaction ? this.latestRelayMessageId() : undefined;
      if (reaction) this.ensureRelayReactionSchema();
      this.ctx.storage.transactionSync(() => {
        if (reaction) {
          sql.exec(
            `INSERT INTO relay_reaction (
               event_id, received_at, base_message_id, reaction_json, turn_id
             ) VALUES (?, ?, ?, ?, NULL)`,
            delivery.eventId,
            now,
            reactionBase ?? null,
            JSON.stringify(reaction),
          );
          sql.exec(
            "DELETE FROM relay_reaction WHERE turn_id IS NOT NULL AND received_at < ?",
            now - RELAY_EVENT_RETENTION_MS,
          );
        }
        sql.exec(
          `INSERT INTO relay_event (
             event_id, received_at, body, state, event_type, url, headers_json,
             serial_message_id, serial_sent_at,
             admission_message_id, admission_sent_at, attempts
           ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, 0)`,
          delivery.eventId,
          now,
          delivery.body,
          delivery.eventType,
          delivery.url,
          JSON.stringify(delivery.headers),
          delivery.serial?.messageId ?? null,
          delivery.serial?.sentAt ?? null,
          delivery.admission?.messageId ?? null,
          delivery.admission?.sentAt ?? null,
        );
        sql.exec(
          `DELETE FROM relay_event
           WHERE state IN ('settled', 'terminal') AND completed_at < ?`,
          now - RELAY_EVENT_RETENTION_MS,
        );
      });
      timing.mark("stored");
      // Read at receipt, like a person: the message is marked read the moment
      // it arrives, before the turn thinks and replies. Not awaited; the
      // adapter's markReadOnReceipt would block dispatch on the REST call.
      this.markRelayMessageRead(delivery);
      // Chronological admission before 2xx: the newest eligible Message cancels
      // recoverable older model work right away, before its own turn is queued.
      if (delivery.admission) this.admitRelayMessage(delivery.admission);
      receiveMs.insert = performance.now() - phaseStart;
      phase = "schedule";
      phaseStart = performance.now();
      // Awaited: the schedule row and its alarm are the durable proof behind 2xx.
      // A person's reaction waits briefly, so a burst of them is one turn.
      await this.schedule(
        reaction ? RELAY_REACTION_DEBOUNCE_SECONDS : 0,
        "processRelayEvent",
        { event_id: delivery.eventId },
        { idempotent: true },
      );
      receiveMs.schedule = performance.now() - phaseStart;
      phase = undefined;
      timing.mark("scheduled");
      timing.scheduledAt = Date.now();
      this.relayChatTimings.set(delivery.eventId, timing);
      return { duplicate: false };
    } finally {
      if (phase) receiveMs[phase] = performance.now() - phaseStart;
      console.log(JSON.stringify({
        event: "relay_receive_timing",
        event_id: delivery.eventId,
        instance: this.relayInstanceId,
        cold_object: coldObject,
        ms: {
          dedupe_lookup: Math.round(receiveMs.dedupe_lookup),
          insert: Math.round(receiveMs.insert),
          schedule: Math.round(receiveMs.schedule),
          total: Math.round(performance.now() - started),
        },
      }));
    }
  }

  /**
   * Commit call webhook identity before the public acknowledgement. This
   * template has no voice service: a created Call schedules one durable job
   * that ends it while it rings, so the caller sees at once that the agent
   * cannot take calls. Updates and terminal events are durable tombstones.
   */
  async receiveRelayCallEvent(
    delivery: RelayWebhookDelivery,
    event: RelayCallEvent,
  ): Promise<{ duplicate: boolean }> {
    this.noteRelayRequest();
    this.ensureRelayCallEventSchema();
    const sql = this.ctx.storage.sql;
    const existing = sql.exec<{ state: RelayEventState }>(
      "SELECT state FROM relay_call_event WHERE event_id = ?",
      delivery.eventId,
    ).toArray()[0];
    if (existing) return { duplicate: true };

    this.ensureRelayLiveCallSchema();
    const now = Date.now();
    // call.created is the one durable job: the agent ends the ringing Call.
    const pending = event.event_type === "call.created";
    const call = event.data.call;
    this.ctx.storage.transactionSync(() => {
      this.recordRelayCallState(
        call.id,
        call.revision,
        isLiveRelayCallEvent(event),
        now,
      );
      sql.exec(
        "DELETE FROM relay_live_call WHERE live = 0 AND updated_at < ?",
        now - RELAY_EVENT_RETENTION_MS,
      );
      sql.exec(
        `INSERT INTO relay_call_event (
           event_id, received_at, event_type, call_id, body, state, attempts
         ) VALUES (?, ?, ?, ?, ?, ?, 0)`,
        delivery.eventId,
        now,
        event.event_type,
        event.data.call.id,
        pending ? delivery.body : "",
        pending ? "pending" : "settled",
      );
      sql.exec(
        `DELETE FROM relay_call_event
         WHERE state IN ('settled', 'terminal') AND received_at < ?`,
        now - RELAY_EVENT_RETENTION_MS,
      );
    });

    if (pending) {
      try {
        await this.schedule(0, "processRelayCallEvent", {
          event_id: delivery.eventId,
        });
      } catch (error) {
        // A 2xx requires both durable facts: the event tombstone and the
        // scheduler row. If the latter fails, remove this brand-new event so
        // Relay's redelivery can retry the whole commit instead of being
        // mistaken for an already-scheduled duplicate.
        sql.exec(
          `DELETE FROM relay_call_event
           WHERE event_id = ? AND state = 'pending' AND attempts = 0`,
          delivery.eventId,
        );
        throw error;
      }
    }
    return { duplicate: false };
  }

  /**
   * Durable scheduler callback for a call.created event, and the dispatch the
   * Worker starts once receiveRelayCallEvent has accepted it.
   * One run per event at a time in this object: a second caller waits for
   * the run in flight, whose own failure path schedules the retry. After an
   * eviction the map is empty and the scheduler's run re-claims the row.
   */
  async processRelayCallEvent(payload: { event_id: string }): Promise<void> {
    const inFlight = this.relayCallEventRuns.get(payload.event_id);
    if (inFlight) return await inFlight;
    const run = this.runRelayCallEvent(payload.event_id).finally(() => {
      this.relayCallEventRuns.delete(payload.event_id);
    });
    this.relayCallEventRuns.set(payload.event_id, run);
    return await run;
  }

  private async runRelayCallEvent(eventId: string): Promise<void> {
    this.noteRelayRequest();
    const row = this.claimRelayCallEvent(eventId);
    if (!row) return;
    try {
      callEventSchema.parse(JSON.parse(row.body));
      await this.endUnanswerableRelayCall(row);
    } catch (error) {
      const errorType = error instanceof Error ? error.name : typeof error;
      if (row.attempts >= RELAY_EVENT_MAX_ATTEMPTS) {
        this.settleRelayCallEvent(row.event_id, "terminal", errorType);
        console.warn(JSON.stringify({
          event: "relay_call_dispatch_terminal",
          event_id: row.event_id,
          call_id: row.call_id,
          attempts: row.attempts,
          error_type: errorType,
        }));
        return;
      }
      this.ctx.storage.sql.exec(
        `UPDATE relay_call_event SET state = 'pending', last_error_type = ?
         WHERE event_id = ? AND state = 'processing'`,
        errorType,
        row.event_id,
      );
      const delay = RELAY_EVENT_RETRY_DELAYS_MS[
        Math.min(row.attempts - 1, RELAY_EVENT_RETRY_DELAYS_MS.length - 1)
      ]!;
      await this.schedule(delay / 1_000, "processRelayCallEvent", {
        event_id: row.event_id,
      });
    }
  }

  /**
   * Scheduler callback (public for the Agents SDK, never routed from the
   * Worker). Runs the committed delivery through Chat SDK exactly as the
   * public request would have, then settles the row. relay_event is the one
   * dedupe; a re-run reaches the turn again, and the native Action key,
   * keyed by the Message, keeps it one logical reply.
   * Retries with the bounded backoff ladder; a lifecycle
   * re-dispatch after a crash re-claims a 'processing' row.
   */
  async processRelayEvent(payload: { event_id: string }): Promise<void> {
    this.noteRelayRequest();
    const row = this.claimRelayEvent(payload.event_id);
    if (!row) return;
    // The record survives only in memory: after an eviction the alarm lands on
    // a fresh instance, and the row's received_at is all that dates the wait.
    const timing = resumeRelayChatTiming(
      this.relayChatTimings.get(row.event_id) ?? startRelayChatTiming({
        instance: this.relayInstanceId,
        eventId: row.event_id,
        cold: true,
        receivedAt: row.received_at,
      }),
      row.attempts,
    );
    this.relayChatTimings.delete(row.event_id);
    timing.messageId ??= row.admission_message_id ?? undefined;
    let waitedBase: string | undefined;
    try {
      // payment.* events carry a PaymentRequest, not a Message; the receipt a
      // person sees arrives on its own as message.received. The Chat SDK has
      // no payment primitive, so the event is committed and settled here.
      if (RELAY_PAYMENT_EVENT_TYPES.has(row.event_type)) {
        // The request's state joins the history as data, with no turn: a paid
        // request also arrives as the payer's receipt Message, which starts one.
        const envelope = JSON.parse(row.body) as { data: Parameters<typeof paymentEventContext>[1] };
        await this.appendMessageToHistory({
          id: `relay-event:${row.event_id}`,
          role: "user",
          parts: [{ type: "text", text: paymentEventContext(row.event_type, envelope.data) }],
        });
        this.settleRelayEvent(row.event_id, "settled");
        console.log(JSON.stringify({
          event: "relay_payment_event",
          event_id: row.event_id,
          event_type: row.event_type,
        }));
        return;
      }
      // A member joining or leaving, and a group's new name or photo, join the
      // history as data with no turn; the next Message's turn reads them.
      if (RELAY_CHAT_CONTEXT_EVENT_TYPES.has(row.event_type)) {
        const context = chatEventContext(row.event_type, JSON.parse(row.body));
        if (context) {
          await this.appendMessageToHistory({
            id: `relay-event:${row.event_id}`,
            role: "user",
            parts: [{ type: "text", text: context }],
          });
        }
        this.settleRelayEvent(row.event_id, "settled");
        return;
      }
      // Opening a Chat is acknowledged without starting a turn.
      if (row.event_type === RELAY_CHAT_OPENED_EVENT) {
        this.settleRelayEvent(row.event_id, "settled");
        return;
      }
      // Reactions never enter Chat SDK: Think registers no reaction handler,
      // so the Chat object turns a person's reaction into model context here.
      if (RELAY_REACTION_EVENT_TYPES.has(row.event_type)) {
        await this.processRelayReaction(row.event_id);
        this.settleRelayEvent(row.event_id, "settled");
        return;
      }
      await this.rememberRelayMessage(row);
      await this.recordRelayGroupMessage(row);
      // A clone that chose to speak and waited out its stagger takes its turn
      // on the fresh history (src/speak-gate.ts). The peers' replies that
      // landed during the wait are what it answers or stays silent on, so
      // they must not drop its turn unread.
      const waited = this.env.RELAY_SPEAK_GATE === "clef" && row.admission_message_id !== null
        && this.ctx.storage.kv.get<SpeakDecision>(`speak-gate:${row.event_id}`)?.spoke === true
        ? row.admission_message_id
        : undefined;
      const gated = this.env.RELAY_SPEAK_GATE === "clef"
        && row.admission_message_id !== null && row.admission_sent_at !== null
        && (waited !== undefined || !this.isRelayMessageSuperseded(row.admission_message_id, row.admission_sent_at));
      // From the gate on, the turn stays current until a person's newer
      // Message lands (agents' Messages never become the latest).
      if (gated) {
        this.relayEventTurnBases.set(row.admission_message_id!, this.latestRelayMessageId());
        waitedBase = row.admission_message_id!;
      }
      const gate = gated
        ? await prepareSpeakGate(this.env, JSON.parse(row.body), {
          relay: createRelayClient(this.env),
          get: () => this.ctx.storage.kv.get<SpeakDecision>(`speak-gate:${row.event_id}`),
          put: (decision) => this.ctx.storage.kv.put(`speak-gate:${row.event_id}`, decision),
          waitUntil: (task) => this.ctx.waitUntil(task),
          pickReaction: (history) => pickCloneReaction(this.env, this.getSystemPrompt(), history),
          asksEveryone: (members, history) => asksEveryMember(this.env, members, history),
        })
        : { kind: "turn" as const };
      if (gate.kind === "silent") {
        this.settleRelayEvent(row.event_id, "settled");
        return;
      }
      if (gate.kind === "deferred") {
        await this.schedule(gate.delay, "processRelayEvent", { event_id: row.event_id });
        this.ctx.storage.sql.exec(
          "UPDATE relay_event SET state = 'pending', attempts = attempts - 1 WHERE event_id = ?",
          row.event_id,
        );
        return;
      }
      const headers = new Headers(
        JSON.parse(row.headers_json) as Record<string, string>,
      );
      if (row.serial_message_id !== null && row.serial_sent_at !== null) {
        headers.set(
          RELAY_MESSAGE_SERIAL_HEADER,
          `${row.serial_sent_at}:${row.serial_message_id}`,
        );
      }
      if (
        row.admission_message_id !== null
        && row.admission_sent_at !== null
      ) {
        headers.set(
          RELAY_MESSAGE_ADMISSION_HEADER,
          `${row.admission_sent_at}:${row.admission_message_id}`,
        );
      }
      const response = await this.relayTurnTiming.run(timing, () =>
        this.fetch(new Request(row.url, {
          body: row.body,
          headers,
          method: "POST",
        })));
      if (!response.ok) {
        if (
          response.status === 408
          || response.status === 429
          || response.status >= 500
        ) {
          throw new RetryableRelayDeliveryError(response.status);
        }
        this.settleRelayEvent(row.event_id, "terminal", `http_${response.status}`);
        console.warn(JSON.stringify({
          event: "relay_event_terminal",
          event_id: row.event_id,
          event_type: row.event_type,
          http_status: response.status,
        }));
        return;
      }
      this.settleRelayEvent(row.event_id, "settled");
    } catch (error) {
      const errorType = error instanceof Error ? error.name : typeof error;
      if (row.attempts >= RELAY_EVENT_MAX_ATTEMPTS) {
        this.settleRelayEvent(row.event_id, "terminal", errorType);
        console.warn(JSON.stringify({
          event: "relay_event_terminal",
          event_id: row.event_id,
          event_type: row.event_type,
          attempts: row.attempts,
          error_type: errorType,
        }));
        return;
      }
      const delay = RELAY_EVENT_RETRY_DELAYS_MS[
        Math.min(row.attempts - 1, RELAY_EVENT_RETRY_DELAYS_MS.length - 1)
      ]!;
      this.ctx.storage.sql.exec(
        `UPDATE relay_event SET state = 'pending', last_error_type = ?
         WHERE event_id = ? AND state = 'processing'`,
        errorType,
        row.event_id,
      );
      await this.schedule(delay / 1_000, "processRelayEvent", {
        event_id: row.event_id,
      });
    } finally {
      if (waitedBase) this.relayEventTurnBases.delete(waitedBase);
      if (timing.marks.post_returned !== undefined) {
        console.log(relayChatTimingLine(timing));
      }
    }
  }

  /**
   * Stamp Read for a newly committed inbound Message without awaiting the
   * REST call. Silent and unmentioned-group deliveries count too. The
   * promise is retained in relayStampTasks (tests join it) and registered
   * with waitUntil so it survives the RPC return; a failure only warns.
   */
  private markRelayMessageRead(delivery: RelayWebhookDelivery): void {
    if (delivery.eventType !== "message.received") return;
    if (!relayMarkReadOnReceipt(this.env)) return;
    const data = JSON.parse(delivery.body).data;
    if (data.direction === "outbound" || data.sender_handle.is_me === true) return;
    const key = `read:${delivery.eventId}`;
    const task = createRelayClient(this.env).chats.markAsRead(data.chat.id)
      .catch((error: unknown) => {
        console.warn(JSON.stringify({
          event: "relay_agent_read_failed",
          chat_id: data.chat.id,
          error: error instanceof Error ? error.message : String(error),
        }));
      })
      .finally(() => { this.relayStampTasks.delete(key); });
    this.relayStampTasks.set(key, task);
    this.ctx.waitUntil(task);
  }

  private ensureRelayEventSchema(): void {
    if (this.relayEventSchemaReady) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS relay_event (
        event_id TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL,
        body TEXT NOT NULL,
        state TEXT NOT NULL
          CHECK (state IN ('pending', 'processing', 'settled', 'terminal')),
        event_type TEXT NOT NULL,
        url TEXT NOT NULL,
        headers_json TEXT NOT NULL,
        serial_message_id TEXT,
        serial_sent_at INTEGER,
        admission_message_id TEXT,
        admission_sent_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        completed_at INTEGER,
        last_error_type TEXT
      )
    `);
    this.relayEventSchemaReady = true;
  }

  private ensureRelayCallEventSchema(): void {
    if (this.relayCallEventSchemaReady) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS relay_call_event (
        event_id TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        call_id TEXT NOT NULL,
        body TEXT NOT NULL,
        state TEXT NOT NULL
          CHECK (state IN ('pending', 'processing', 'settled', 'terminal')),
        attempts INTEGER NOT NULL DEFAULT 0,
        completed_at INTEGER,
        last_error_type TEXT
      )
    `);
    this.relayCallEventSchemaReady = true;
  }

  private ensureRelayLiveCallSchema(): void {
    if (this.relayLiveCallSchemaReady) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS relay_live_call (
        call_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        live INTEGER NOT NULL CHECK (live IN (0, 1)),
        updated_at INTEGER NOT NULL
      )
    `);
    this.relayLiveCallSchemaReady = true;
  }

  /**
   * The Call's own revision orders its states, so a late call.updated can
   * never reopen a Call whose call.ended already landed.
   */
  private recordRelayCallState(
    callId: string,
    revision: number,
    live: boolean,
    now: number,
  ): void {
    this.ensureRelayLiveCallSchema();
    this.ctx.storage.sql.exec(
      `INSERT INTO relay_live_call (call_id, revision, live, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(call_id) DO UPDATE SET
         revision = excluded.revision,
         live = excluded.live,
         updated_at = excluded.updated_at
       WHERE excluded.revision > relay_live_call.revision`,
      callId,
      revision,
      live ? 1 : 0,
      now,
    );
  }

  private relaySentParts(): { has(key: string): boolean; add(key: string): void } {
    const sql = this.ctx.storage.sql;
    const ensure = () => {
      sql.exec(`
        CREATE TABLE IF NOT EXISTS relay_sent_parts (
          idempotency_key TEXT PRIMARY KEY,
          sent_at INTEGER NOT NULL
        )
      `);
    };
    return {
      has: (key) => {
        ensure();
        return sql.exec("SELECT 1 FROM relay_sent_parts WHERE idempotency_key = ?", key)
          .toArray().length > 0;
      },
      add: (key) => {
        ensure();
        const now = Date.now();
        sql.exec(
          "INSERT OR IGNORE INTO relay_sent_parts (idempotency_key, sent_at) VALUES (?, ?)",
          key,
          now,
        );
        sql.exec(
          "DELETE FROM relay_sent_parts WHERE sent_at < ?",
          now - RELAY_SENT_PARTS_TTL_MS,
        );
      },
    };
  }

  private ensureRelayReactionSchema(): void {
    if (this.relayReactionSchemaReady) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS relay_reaction (
        event_id TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL,
        base_message_id TEXT,
        reaction_json TEXT NOT NULL,
        turn_id TEXT
      )
    `);
    this.relayReactionSchemaReady = true;
  }

  /**
   * One committed reaction event, after its debounce. The newest reaction of
   * a burst claims every earlier one still waiting and runs one turn for all
   * of them; an older one finds a newer one waiting and leaves it the turn.
   * The agent's own reactions and other agents' were never recorded.
   */
  private async processRelayReaction(eventId: string): Promise<void> {
    this.ensureRelayReactionSchema();
    const sql = this.ctx.storage.sql;
    const own = sql.exec<RelayReactionRow>(
      `SELECT event_id, received_at, base_message_id, reaction_json, turn_id
       FROM relay_reaction WHERE event_id = ?`,
      eventId,
    ).toArray()[0];
    if (!own || (own.turn_id !== null && own.turn_id !== eventId)) return;
    if (own.turn_id === null) {
      const newer = sql.exec<{ event_id: string }>(
        `SELECT event_id FROM relay_reaction
         WHERE turn_id IS NULL
           AND (received_at > ? OR (received_at = ? AND event_id > ?))
         LIMIT 1`,
        own.received_at,
        own.received_at,
        own.event_id,
      ).toArray()[0];
      if (newer) {
        console.log(JSON.stringify({
          event: "relay_reaction_folded",
          event_id: eventId,
          into: newer.event_id,
        }));
        return;
      }
      sql.exec(
        `UPDATE relay_reaction SET turn_id = ?
         WHERE turn_id IS NULL
           AND (received_at < ? OR (received_at = ? AND event_id <= ?))`,
        eventId,
        own.received_at,
        own.received_at,
        own.event_id,
      );
    }
    const reactions = sql.exec<RelayReactionRow>(
      `SELECT reaction_json FROM relay_reaction
       WHERE turn_id = ? ORDER BY received_at, event_id`,
      eventId,
    ).toArray().map(({ reaction_json }) =>
      JSON.parse(reaction_json) as PersonReaction
    );
    const last = reactions.at(-1);
    if (!last) return;
    const relay = createRelayClient(this.env);
    // Relay is the source of truth for what each Message says and which
    // reactions it has now; a Message that is gone is named by its id only.
    const messages = new Map<string, Message | undefined>();
    for (const { messageId } of reactions) {
      if (messages.has(messageId)) continue;
      try {
        messages.set(messageId, await relay.messages.retrieve(messageId));
      } catch (error) {
        if (!(error instanceof RelayAPIError) || error.status !== 404) throw error;
        messages.set(messageId, undefined);
      }
    }
    // In a group, a reaction starts a turn only on the agent's own Message.
    const onOwnMessage = reactions.some(({ messageId }) =>
      messages.get(messageId)?.is_from_me === true
    );
    const directed = onOwnMessage
      || !(await relay.chats.retrieve(last.chatId)).is_group;
    if (!directed) {
      console.log(JSON.stringify({
        event: "relay_reaction_not_directed",
        event_id: eventId,
        reactions: reactions.length,
      }));
      return;
    }
    const history = {
      id: `relay-reaction:${eventId}`,
      role: "user" as const,
      parts: [{ type: "text" as const, text: reactionContext(reactions, messages) }],
    };
    // A newer Message from the person, or a live Call, answers instead: the
    // reaction still joins the history as data, and no turn starts for it.
    const base = own.base_message_id ?? undefined;
    if (this.latestRelayMessageId() !== base || this.liveRelayCallId()) {
      await this.appendMessageToHistory(history);
      console.log(JSON.stringify({
        event: "relay_reaction_superseded",
        event_id: eventId,
        reactions: reactions.length,
      }));
      return;
    }
    await this.runRelayReactionTurn(eventId, base, last, history);
    console.log(JSON.stringify({
      event: "relay_reaction_turn",
      event_id: eventId,
      reactions: reactions.length,
    }));
  }

  /**
   * The person's reactions go into the conversation as data and run one
   * ordinary model turn (Think's saveMessages, as for an unanswered Call). The
   * turn's identity is the newest reaction's event id, so a re-run finds the
   * Action it already chose; a newer Message from the person supersedes it.
   */
  private async runRelayReactionTurn(
    eventId: string,
    base: string | undefined,
    last: PersonReaction,
    message: { id: string; role: "user"; parts: Array<{ type: "text"; text: string }> },
  ): Promise<void> {
    const supersession = new AbortController();
    this.relayEventTurnBases.set(eventId, base);
    this.activeRelayTurns.set(eventId, supersession);
    try {
      await this.trustedRelayTurns.run(
        {
          chatId: last.chatId,
          eventId,
          reactTo: { messageId: last.messageId, partIndex: last.partIndex },
          replyTo: { messageId: last.messageId, partIndex: last.partIndex },
          inboundMedia: Promise.resolve(NO_INBOUND_MEDIA),
          supersessionSignal: supersession.signal,
          actions: REACTION_TURN_ACTIONS,
        },
        () => this.saveMessages([message], { signal: supersession.signal }),
      );
    } catch (error) {
      // Superseded mid-turn: the newer Message's own turn answers.
      if (!supersession.signal.aborted) throw error;
    } finally {
      if (this.activeRelayTurns.get(eventId) === supersession) {
        this.activeRelayTurns.delete(eventId);
      }
      this.relayEventTurnBases.delete(eventId);
    }
  }

  /** The Call live in this Chat, from call.created until call.ended. */
  private liveRelayCallId(): string | undefined {
    this.ensureRelayLiveCallSchema();
    return this.ctx.storage.sql.exec<{ call_id: string }>(
      `SELECT call_id FROM relay_live_call WHERE live = 1
       ORDER BY updated_at DESC LIMIT 1`,
    ).toArray()[0]?.call_id;
  }

  /**
   * Nobody can answer this Call: the agent has no voice service. The agent,
   * its callee, ends it while it rings, which
   * Relay records as no-answer (Twilio <Reject>), so the caller sees the
   * agent is unavailable at once instead of ringing out. Ending a Call that is
   * already over changes nothing. A failed end throws into the retry ladder.
   */
  private async endUnanswerableRelayCall(
    row: RelayCallEventRow,
  ): Promise<void> {
    const { call } = await createRelayClient(this.env).calls.end(row.call_id);
    this.settleRelayCallEvent(row.event_id, "settled");
    console.log(JSON.stringify({
      event: "relay_call_ended_unanswerable",
      event_id: row.event_id,
      call_id: row.call_id,
      reason: "no_voice",
      status: call.status,
    }));
  }

  private claimRelayCallEvent(eventId: string): RelayCallEventRow | undefined {
    this.ensureRelayCallEventSchema();
    const sql = this.ctx.storage.sql;
    const candidate = sql.exec<RelayCallEventRow>(
      `SELECT event_id, received_at, event_type, call_id, body, state, attempts
       FROM relay_call_event
       WHERE event_id = ? AND state IN ('pending', 'processing')`,
      eventId,
    ).toArray()[0];
    if (!candidate) return;
    const attempts = candidate.attempts + 1;
    sql.exec(
      "UPDATE relay_call_event SET state = 'processing', attempts = ? WHERE event_id = ?",
      attempts,
      eventId,
    );
    return { ...candidate, attempts, state: "processing" };
  }

  private settleRelayCallEvent(
    eventId: string,
    state: "settled" | "terminal",
    errorType?: string,
  ): void {
    this.ctx.storage.sql.exec(
      `UPDATE relay_call_event
       SET state = ?, body = '', completed_at = ?, last_error_type = ?
       WHERE event_id = ?`,
      state,
      Date.now(),
      errorType ?? null,
      eventId,
    );
  }

  private claimRelayEvent(eventId: string): RelayEventRow | undefined {
    this.ensureRelayEventSchema();
    const sql = this.ctx.storage.sql;
    const candidate = sql.exec<RelayEventRow>(
      `SELECT event_id, event_type, url, headers_json, body,
              serial_message_id, serial_sent_at,
              admission_message_id, admission_sent_at, state, attempts,
              received_at
       FROM relay_event
       WHERE event_id = ? AND state IN ('pending', 'processing')`,
      eventId,
    ).toArray()[0];
    if (!candidate) return;
    const attempts = candidate.attempts + 1;
    sql.exec(
      "UPDATE relay_event SET state = 'processing', attempts = ? WHERE event_id = ?",
      attempts,
      eventId,
    );
    return { ...candidate, attempts, state: "processing" };
  }

  private settleRelayEvent(
    eventId: string,
    state: "settled" | "terminal",
    errorType?: string,
  ): void {
    // Keep the event_id tombstone for webhook dedupe, but discard payload and
    // signature material once no recovery can need them.
    this.ctx.storage.kv.delete(`speak-gate:${eventId}`);
    this.ctx.storage.kv.delete(`person-memory:${eventId}`);
    this.ctx.storage.sql.exec(
      `UPDATE relay_event
       SET state = ?, body = '', headers_json = '{}', completed_at = ?,
           last_error_type = ?
       WHERE event_id = ?`,
      state,
      Date.now(),
      errorType ?? null,
      eventId,
    );
  }

  private async serializeRelayWebhook(
    operation: () => Promise<Response>,
  ): Promise<Response> {
    const previous = this.relayWebhookTail;
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.relayWebhookTail = previous.then(() => current);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  override getActions() {
    const hooks = this.relayActionHooks();
    return {
      ...relayActions(this, {
        ...hooks,
        env: this.env,
        ctx: this.ctx,
        sentParts: this.relaySentParts(),
        // No voice service in this template, so no start_call Action.
        voice: false,
        webSearch: webSearchEnabled(this.env as { RELAY_WEB_SEARCH?: string }),
        timing: (phase) => {
          const timing = this.relayTurnTiming.getStore();
          if (!timing) return;
          timing.mark(phase);
        },
      }),
      ...searchSourcesActions({ ...hooks, env: this.env }),
    };
  }

  /** The turn hooks the Relay Actions and this agent's own search_sources share. */
  private relayActionHooks(): Pick<
    RelayActionDependencies,
    "activities" | "turn" | "signal" | "assertCurrentTurn" | "setIrreversibleSend" | "waitUntil" | "runChosenAction"
  > {
    return {
      activities: this.relayActivities,
      turn: () => this.relayTurn(),
      signal: (platformSignal) => {
        const supersessionSignal = this.relaySupersessionSignal();
        return platformSignal
          ? AbortSignal.any([platformSignal, supersessionSignal])
          : supersessionSignal;
      },
      assertCurrentTurn: (identity) => {
        this.assertCurrentRelayTurn(identity);
      },
      setIrreversibleSend: (active) => {
        this.irreversibleSend = active;
      },
      waitUntil: (task) => {
        this.ctx.waitUntil(task);
      },
      runChosenAction: (_actionName, operation) => this.runRelayAction(operation),
    };
  }

  override getMessengers(): ThinkMessengers {
    const relay = chatSdkMessenger({
      adapter: this.adapter(),
      adapterName: "relay",
      provider: "relay",
      userName: this.env.RELAY_AGENT_HANDLE,
      path: RELAY_WEBHOOK_PATH,
      // The Worker resolves a separate RelayChatAgent instance from the
      // signed Chat ID, so messenger delivery stays local to that instance.
      // Avoid Think 0.17's generic sub-agent/RPC delivery path entirely.
      conversation: "self",
      // The Relay adapter verifies Standard Webhooks over the exact raw body
      // before it emits a Chat SDK event.
      verifyWebhook: false,
      respondTo: ["direct-message", "mention"],
      capabilities: {
        canEditMessages: false,
        canStream: false,
        supportsActions: false,
        supportsAttachments: true,
      },
      delivery: {
        // Visible Relay output is created only by the send Action, as many
        // Messages as the model sends. Think's final model text, and its
        // empty, error and interrupted fallbacks, are never posted.
        ...RELAY_MESSENGER_DELIVERY,
        isExpectedDeliveryCompletion: (error, callback) => {
          const messageId = this.relayCallbackMessages.get(callback);
          return isAbortLikeError(error)
            || (
              messageId !== undefined
              && this.isRelayTurnSuperseded(messageId)
            );
        },
      },
    });
    // Think's default event, with the Message a swipe-reply answers
    // (src/replies.ts) written into the text the model reads. toEvent is
    // Think's hook for this; its default is reused through Think's own
    // normalizer.
    const [normalized] = normalizeMessengers({ relay });
    return {
      relay: {
        ...relay,
        toEvent: (input) => {
          const event = defaultChatSdkEvent(normalized!, input);
          const context = input.message
            && replyContext(input.message as Parameters<typeof replyContext>[0]);
          if (event.message && context) {
            event.message.text = [event.message.text, context].filter(Boolean).join("\n\n");
          }
          return event;
        },
      },
    };
  }

  /**
   * Once the turn has put something in the chat, the model may stop calling
   * tools: Think ends the turn on a step with no tool call
   * (createRelayTurnSettled), and RELAY_MESSENGER_DELIVERY keeps any plain
   * text from becoming a Message. Before that, a tool stays required, so a
   * read, or a refused send, card, call or payment, is still answered.
   */
  override beforeStep(context: PrepareStepContext): StepConfig | void {
    const acted = context.steps.some((step) =>
      step.toolResults.some((result) =>
        RELAY_VISIBLE_ACTIONS.has(result.toolName)
        && (result.output as { status?: unknown } | undefined)?.status !== "not_requested"
      )
    );
    // Think 0.20.1 types StepConfig as Omit<PrepareStepResult | undefined>,
    // which keeps only `model`; its prepareStep passes toolChoice through.
    if (acted) return { toolChoice: "auto" } as NonNullable<PrepareStepResult<ToolSet>> as StepConfig;
  }

  /**
   * Every person's and agent's Message in a group joins this Chat's Session
   * as Think's turn would store it, whether or not a turn follows: the speak
   * gate's silence, a stagger and a superseded turn included. The turn that
   * answers it then finds it already there (appends are idempotent by id).
   * The agent's own Messages are its assistant turns already.
   */
  private async recordRelayGroupMessage(row: RelayEventRow): Promise<void> {
    if (row.event_type !== "message.received") return;
    const { data } = JSON.parse(row.body) as { data: Message & {
      chat?: { id?: string; is_group?: boolean };
      direction?: string;
      sender_handle?: { is_me?: boolean; kind?: string; timezone?: string | null };
    } };
    const chatId = data.chat?.id;
    if (!chatId || data.chat?.is_group !== true) return;
    const kv = this.ctx.storage.kv;
    try {
      await this.backfillRelayGroup(chatId);
    } catch (error) {
      // A failed Relay read must not hold the Message or its turn; the next
      // group Message tries the backfill again.
      console.warn(JSON.stringify({
        event: "relay_group_history_backfill_failed",
        chat_id: chatId,
        error_type: error instanceof Error ? error.name : typeof error,
      }));
    }
    const at = Date.parse(data.sent_at ?? data.created_at);
    const own = data.direction === "outbound" || data.sender_handle?.is_me === true;
    const personZone = data.sender_handle?.kind === "user" ? validTimezone(data.sender_handle.timezone) : undefined;
    if (!own && !await this.session.getMessage(relaySessionId(data.id))) {
      await this.waitUntilStable({ timeout: RELAY_GROUP_WRITE_WAIT_MS });
      const target = data.reply_to
        ? await createRelayClient(this.env).messages.retrieve(data.reply_to.message_id).catch(() => undefined)
        : undefined;
      const header = groupTimeHeader(kv.get<number>(RELAY_GROUP_LAST_AT_KEY), at,
        personZone ?? kv.get<string>(RELAY_GROUP_TIMEZONE_KEY));
      await this.addMessages([await this.relayGroupRow(chatId, data, target, header)]);
    }
    if (!Number.isNaN(at) && at >= (kv.get<number>(RELAY_GROUP_LAST_AT_KEY) ?? -Infinity)) kv.put(RELAY_GROUP_LAST_AT_KEY, at);
    if (personZone) kv.put(RELAY_GROUP_TIMEZONE_KEY, personZone);
  }

  /**
   * A group Message as Think's messenger turn stores it: the event Relay's
   * messenger builds (getMessengers toEvent, with the swipe-reply line), the
   * text Think labels with its speaker (`toMessengerUserMessage`), and the
   * metadata chatWithMessengerContext keeps.
   */
  private async relayGroupRow(chatId: string, data: Message, replyTarget?: Message, timeHeader?: string): Promise<UIMessage> {
    const adapter = this.adapter();
    const raw = { chatId, eventType: "message.received" as const, message: data } as Parameters<RelayAdapter["parseMessage"]>[0];
    const message = adapter.parseMessage(raw);
    if (replyTarget && replyTarget.chat_id === chatId && data.reply_to) {
      // Relay's iOS app quotes only the swiped part of a multi-part Message
      // (@relaymessenger/chat-sdk-adapter replyTarget).
      const parts = replyTarget.parts ?? [];
      const part = parts.length > 1 && data.reply_to.part_index !== undefined
        ? parts[data.reply_to.part_index]
        : undefined;
      message.replyTo = adapter.parseMessage({ chatId, message: part ? { ...replyTarget, parts: [part] } : replyTarget });
    }
    const threadId = adapter.encodeThreadId({ chatId });
    const thread = { id: threadId, channelId: threadId, channel: {}, isDM: false };
    const event = await this.getMessengers().relay!.toEvent!({
      eventKind: "mention",
      message,
      thread: thread as unknown as Parameters<NonNullable<ThinkMessengers[string]["toEvent"]>>[0]["thread"],
    });
    const built = toMessengerUserMessage(event);
    const turnMetadata = relayTurnMetadata(
      (built.metadata as { messenger?: unknown } | undefined)?.messenger, data,
    );
    const row = withoutMessengerEvent(built);
    return {
      ...row,
      parts: timeHeader
        ? row.parts.map((part, index) => index === 0 && part.type === "text" ? { ...part, text: `[${timeHeader}] ${part.text}` } : part)
        : row.parts,
      metadata: {
        ...(row.metadata as object | undefined),
        channel: "relay",
        ...(turnMetadata ? { turnMetadata } : {}),
      },
    };
  }

  /**
   * Once per group Chat: the group's earlier Messages that the Session lacks
   * (from before this Chat stored every Message) are read from Relay, oldest
   * first, and put back where they were said. No turn starts. The Session is
   * written again in that order, from Messages already read, with no network
   * call between clearing and writing it; compaction waits until the whole
   * path is written, then runs once.
   */
  private async backfillRelayGroup(chatId: string): Promise<void> {
    const kv = this.ctx.storage.kv;
    if (kv.get(RELAY_GROUP_HISTORY_KEY) === RELAY_GROUP_HISTORY_VERSION) return;
    const started = performance.now();
    const relayMessages: Message[] = [];
    let page: Awaited<ReturnType<Relay["chats"]["messages"]["list"]>> | null =
      await createRelayClient(this.env).chats.messages.list(chatId, { order: "asc", limit: RELAY_PAGE_LIMIT });
    while (page) {
      if (!Array.isArray(page.data)) throw new TypeError("Relay returned no message page");
      relayMessages.push(...page.data);
      page = await page.getNextPage();
    }
    const byId = new Map(relayMessages.map((message) => [message.id, message]));
    // Never rewrite the Session under a running turn.
    await this.waitUntilStable({ timeout: RELAY_GROUP_WRITE_WAIT_MS });
    const stored = await this.session.getHistory() as UIMessage[];
    const storedIds = new Set(stored.map((row) => row.id));
    const missing: Array<{ message: Message; row: UIMessage }> = [];
    let previousAt: number | undefined;
    let timezone = kv.get<string>(RELAY_GROUP_TIMEZONE_KEY);
    for (const message of relayMessages) {
      const at = Date.parse(message.sent_at ?? message.created_at);
      const personZone = message.from_handle?.kind === "user" ? validTimezone(message.from_handle.timezone) : undefined;
      if (!message.is_from_me && !message.is_system_message && !storedIds.has(relaySessionId(message.id))) {
        const target = message.reply_to ? byId.get(message.reply_to.message_id) : undefined;
        const header = groupTimeHeader(previousAt, at, personZone ?? timezone);
        missing.push({ message, row: await this.relayGroupRow(chatId, message, target, header) });
      }
      if (!Number.isNaN(at)) previousAt = at;
      timezone = personZone ?? timezone;
    }
    if (previousAt !== undefined) kv.put(RELAY_GROUP_LAST_AT_KEY, previousAt);
    if (timezone) kv.put(RELAY_GROUP_TIMEZONE_KEY, timezone);
    if (missing.length) {
      const merged = mergeGroupHistory(stored, missing, byId);
      this.session.compactAfter(Infinity);
      try {
        await this.session.clearMessages();
        // appendMessageToHistory, not addMessages: addMessages names each
        // row's parent, and an explicit parent makes Think re-read the whole
        // path into its cache on every row.
        for (const row of merged) await this.appendMessageToHistory(row);
      } finally {
        this.session.compactAfter(RELAY_COMPACT_AFTER);
      }
      await this.session.compact();
    }
    kv.put(RELAY_GROUP_HISTORY_KEY, RELAY_GROUP_HISTORY_VERSION);
    console.log(JSON.stringify({
      event: "relay_group_history_backfilled",
      chat_id: chatId,
      relay_messages: relayMessages.length,
      imported: missing.length,
      ms: Math.round(performance.now() - started),
    }));
  }

  /** Remember an admitted line even if its model turn is deferred or superseded. */
  private async rememberRelayMessage(row: RelayEventRow): Promise<void> {
    const binding = this.env.RelayPersonMemory;
    if (!binding || !row.admission_message_id) return;
    const key = `person-memory:${row.event_id}`;
    if (this.ctx.storage.kv.get<boolean>(key)) return;
    const chat = await this.relayMemoryChat();
    if (!chat) throw new Error("Chat unavailable for person memory");
    // Backfill using this successful membership read, before the new line.
    // A failed lookup must leave the event pending, not discard its payload.
    await personMemory(this, { binding, chat: async () => chat }).ingest();
    const { data } = JSON.parse(row.body) as {
      data: NonNullable<Parameters<RelayAdapter["parseMessage"]>[0]["message"]>;
    };
    const message = this.adapter().parseMessage({
      chatId: chat.id, eventType: "message.received", message: data,
    });
    const incoming: UIMessage = {
      id: `relay:${message.id}`,
      role: "user",
      parts: [{ type: "text", text: message.text }],
      metadata: { turnMetadata: relayTurnMetadata({ message }, data) },
    };
    // This is only a memory write. Do not put a superseded Message back into
    // Think's active conversation or start a turn for it.
    const lines = personMemoryLines(chat, [
      ...this.messages.filter((item) => item.id !== incoming.id), incoming,
    ]);
    for (const [person, own] of personMemoryWrites(chat, lines)) {
      const rows = own.filter((line) => line.key === `${chat.id}:${message.id}`)
        .map((line) => ({ key: line.key, content: personMemoryRow(chatLabel(chat), line), at: line.at }));
      if (rows.length) {
        const memory = await getAgentByName(binding, personMemoryName(person));
        await memory.remember(chat.id, chatLabel(chat), rows);
      }
    }
    this.ctx.storage.kv.put(key, true);
  }

  /** Read current membership: another person's arrival must stop private recall. */
  private async relayMemoryChat(): Promise<PersonMemoryChat | undefined> {
    const chatId = this.name.startsWith("chat:") ? this.name.slice("chat:".length) : "";
    if (!UUID.test(chatId)) return undefined;
    return createRelayClient(this.env).chats.retrieve(chatId).catch(() => undefined);
  }

  override async onChatResponse(): Promise<void> {
    await this.memory.ingest();
  }

  override async beforeTurn(context: TurnContext): Promise<TurnConfig> {
    // Think has assembled history and memory by the time this hook runs.
    this.relayTurnTiming.getStore()?.mark("history_loaded");
    const actionNames = new Set(Object.keys(this.getActions()));
    // Google Search and URL context are provider tools, not Actions; getTools
    // offers them only where the Worker has search on.
    if (WEB_SEARCH_TOOL in context.tools) actionNames.add(WEB_SEARCH_TOOL);
    if (URL_CONTEXT_TOOL in context.tools) actionNames.add(URL_CONTEXT_TOOL);
    // Think renders inbound attachments as a text line naming the file. Replace
    // the assembled user Message with one that also carries the real bytes, so
    // Gemini looks at the photo, video, or voice memo instead of reading about
    // it.
    const media = await this.relayInboundMedia();
    const remembered = await this.memory.turn(context.messages);
    const messages = remembered?.messages ?? context.messages;
    return {
      // Think's Session holds the whole conversation and compacts it
      // (configureSession), so nothing is cut here.
      messages: withoutPastThoughtSignatures(withInboundMedia(messages, media)),
      ...(remembered ? { tools: remembered.tools } : {}),
      activeTools: [
        ...Object.keys(context.tools).filter((name) => {
          const eventActions = this.trustedRelayTurns.getStore()?.actions;
          return actionNames.has(name) && (!eventActions || eventActions.has(name));
        }),
        ...(remembered && !this.trustedRelayTurns.getStore()?.actions
          ? Object.keys(remembered.tools)
          : []),
      ],
      // A tool on every step until the turn has sent, so a plain-text answer
      // never ends the turn silently; beforeStep relaxes it after a send.
      toolChoice: "required",
      // The model sends as many Messages as it chooses. The turn ends when it
      // calls no tool, calls stay_silent, or starts a ringing call.
      maxSteps: RELAY_TURN_MAX_STEPS,
      stopWhen: createRelayTurnSettled(),
      // No output cap: on Gemini the cap counts thinking tokens too, and a
      // card turn thinks for about 2,000 of them before it calls send. Under a
      // 2,000 cap the model stopped at MAX_TOKENS with no tool call, and the
      // turn went silent. The model's own limit applies.
      // Gemini 3 and later ignore temperature, top_p and top_k.
      providerOptions: { vertex: { thinkingConfig: { thinkingLevel: AGENT_THINKING_LEVEL } } },
      sendReasoning: false,
    };
  }

  override async chatWithMessengerContext(
    ...args: Parameters<Think<Bindings>["chatWithMessengerContext"]>
  ): Promise<void> {
    const context = args[2];
    if (
      context.provider !== "relay"
      || context.messengerId !== "relay"
      || context.action
      || !context.message
      || context.message.id !== context.message.providerMessageId
      || context.thread.id !== context.thread.providerThreadId
    ) {
      throw new Error("Untrusted Relay messenger context");
    }
    const providerThreadId = context.thread.providerThreadId;
    const eventId = context.message.providerMessageId;
    if (!providerThreadId || !eventId || !UUID.test(eventId)) {
      throw new Error("Invalid Relay messenger context");
    }
    const identity = {
      chatId: decodeRelayThreadId(providerThreadId).chatId,
      eventId,
      // A quote-reply answers this Message, at its first part.
      replyTo: { messageId: eventId, partIndex: 0 },
    };
    this.relayCallbackMessages.set(args[1], eventId);
    // A signed ingress admission may supersede this fiber while Chat SDK is
    // still debouncing or draining its queue. Never start stale model work.
    if (this.isRelayTurnSuperseded(eventId)) return;
    const supersession = new AbortController();
    const previousTurn = this.activeRelayTurns.get(eventId);
    this.activeRelayTurns.set(eventId, supersession);
    const callerSignal = args[3]?.signal;
    const turnSignal = callerSignal
      ? AbortSignal.any([callerSignal, supersession.signal])
      : supersession.signal;
    const timing = this.relayTurnTiming.getStore();
    const composingSince = Date.now();
    const typingKey = `typing:${eventId}`;
    let typing: ReturnType<typeof startRelayTypingLifecycle> | undefined;
    const startTyping = () => {
      if (typing) return typing;
      const typingStarted = performance.now();
      typing = startRelayTypingLifecycle(
        createRelayClient(this.env),
        identity.chatId,
      ).finally(() => {
        if (timing) timing.typingStampMs = performance.now() - typingStarted;
      });
      this.relayStampTasks.set(typingKey, typing);
      return typing;
    };
    // In a group most turns end in stay_silent, so typing waits for the
    // model's first other tool call (beforeToolCall, onChunk). A direct chat
    // types from the start of the turn.
    const group = (this.committedRelayMessage(eventId) as
      { chat?: { is_group?: unknown } } | undefined)?.chat?.is_group === true;
    if (!group) void startTyping();
    try {
      turnSignal.throwIfAborted();
      // Relay's attachment URLs are sealed capabilities that expire, so the
      // bytes are fetched once for this turn only, never persisted, and never
      // retried from a recovered transcript.
      const inboundMedia = inlineInboundMedia(
        context.message.attachments,
        turnSignal,
        this.relayDocumentReader(),
      );
      // Think stamps the whole messenger event, the raw webhook included, on
      // the stored user Message. The agent keeps only its own facts about the
      // Message, through Think's per-turn carrier (src/stored-history.ts).
      const userMessage = args[0];
      const messenger = typeof userMessage === "string"
        ? undefined
        : (userMessage.metadata as { messenger?: { message?: { raw?: unknown } } } | undefined)
          ?.messenger;
      // Think 0.20 hands the turn a messenger event without the raw webhook,
      // so reply_to and thread come from the verified, committed Message.
      const turnMetadata = messenger
        && relayTurnMetadata(messenger, this.committedRelayMessage(eventId));
      await this.trustedRelayTurns.run(
        { ...identity, composingSince, inboundMedia, supersessionSignal: supersession.signal, startTyping },
        () =>
          super.chatWithMessengerContext(
            typeof userMessage === "string"
              ? userMessage
              : withoutMessengerEvent(userMessage),
            args[1],
            context,
            {
              ...args[3],
              signal: turnSignal,
              ...(turnMetadata ? { metadata: turnMetadata } : {}),
            },
          ),
      );
    } finally {
      if (typing) await (await typing).stop();
      this.relayStampTasks.delete(typingKey);
      if (this.activeRelayTurns.get(eventId) === supersession) {
        if (previousTurn) this.activeRelayTurns.set(eventId, previousTurn);
        else this.activeRelayTurns.delete(eventId);
      }
    }
  }

  /** The `data` of the committed, signature-verified message.received for one Message. */
  private committedRelayMessage(messageId: string): unknown {
    this.ensureRelayEventSchema();
    const row = this.ctx.storage.sql.exec<{ body: string }>(
      `SELECT body FROM relay_event
       WHERE event_type = 'message.received' AND admission_message_id = ?
       ORDER BY received_at DESC LIMIT 1`,
      messageId,
    ).toArray()[0];
    return row ? (JSON.parse(row.body) as { data?: unknown }).data : undefined;
  }

  private admitRelayMessage(admission: RelayMessageAdmission): boolean {
    if (!this.recordRelayAdmission(admission)) return false;
    // The outer Worker adds this admission only after signature verification,
    // before the same request enters Chat SDK. It can therefore cancel model
    // work even though Chat SDK serializes the newer Message behind that
    // handler.
    this.cancelSupersededRelayTurns(admission.messageId);
    return true;
  }

  private relayTurn(): RelayTurnIdentity {
    const identity = this.trustedRelayTurns.getStore();
    if (!identity) throw new Error("No authenticated Relay turn is active");
    return identity;
  }

  private adapter(): RelayAdapter {
    this.relayAdapter ??= withCardReplies(withLocationShares(withSelectionReplies(withEveryGroupMessage(createRelayAdapter({
      token: requireRelayToken(this.env),
      webhookSecret: requireRelayWebhookSecret(this.env),
      baseUrl: this.env.RELAY_API_ORIGIN,
      userName: this.env.RELAY_AGENT_HANDLE,
      typing: false,
      // The public Worker verifies the normal five-minute Standard Webhooks
      // window before durable acceptance. This Chat's own scheduled
      // processRelayEvent replays that same verified body after a transient
      // outage, so the internal Chat SDK hop allows its bounded recovery
      // horizon.
      signatureToleranceSeconds: RELAY_INTERNAL_SIGNATURE_TOLERANCE_SECONDS,
      // Supersession is owned by the durable chronological admission below;
      // Think 0.17 does not consume Chat SDK's adapter cancellation signal.
      abortActiveTurnOnReceipt: false,
      // This adapter option awaits the REST call before dispatch. Read is
      // issued by processRelayEvent after delivery instead.
      markReadOnReceipt: false,
    }), () => everyGroupMessageEnabled(this.env)))));
    // relay_event owns delivery dedupe: each event_id is committed once and
    // reaches Chat SDK only through processRelayEvent. Chat SDK's own dedupe
    // key is written before its lock and handlers run, so a first pass that
    // failed after that write turned the durable retry into an acknowledged
    // duplicate and the Message was never answered.
    // deduplicate is Chat SDK's WebhookOptions switch for a caller that
    // deduplicates for itself; the native Action ledger stays keyed by the
    // Message, so a re-run is still one reply.
    const handleWebhook = this.relayAdapter.handleWebhook.bind(this.relayAdapter);
    this.relayAdapter.handleWebhook = (request, options) =>
      handleWebhook(request, { ...options, deduplicate: false });
    return this.relayAdapter;
  }

  /**
   * Workers AI Markdown Conversion over the Worker's AI binding; a Worker
   * without one reads no files as text.
   */
  private relayDocumentReader(): DocumentReader | undefined {
    const ai = (this.env as { AI?: Ai }).AI;
    if (!ai) return undefined;
    return (document) => ai.toMarkdown(document);
  }

  private async relayInboundMedia(): Promise<InboundMedia> {
    const turn = this.trustedRelayTurns.getStore();
    return turn ? await turn.inboundMedia : NO_INBOUND_MEDIA;
  }

  private relaySupersessionSignal(): AbortSignal {
    const turn = this.trustedRelayTurns.getStore();
    if (!turn) throw new Error("No authenticated Relay turn is active");
    return turn.supersessionSignal;
  }

  private ensureRelayAdmissionSchema(): void {
    if (this.relayAdmissionSchemaReady) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS relay_turn_admissions (
        message_id TEXT PRIMARY KEY,
        admitted_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS relay_turn_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        latest_message_id TEXT NOT NULL,
        latest_message_sent_at INTEGER NOT NULL
      )
    `);
    this.relayAdmissionSchemaReady = true;
  }

  /**
   * Times each Relay Action. A turn may send, react and send again: every
   * call is its own Action with its own key (the package's per-call
   * idempotency key and relay_sent_parts), so nothing here limits a turn to
   * one choice.
   */
  private async runRelayAction<T>(operation: () => Promise<T>): Promise<T> {
    this.dropRelayActionChoices();
    const timing = this.relayTurnTiming.getStore();
    const actionStart = performance.now();
    // Counted before it runs: the send action emits the line from inside its
    // own operation, when the reply POST returns. Its compose and POST spans
    // are their own phases, so tools.ms carries only the actions that ended
    // before the line was written.
    if (timing) timing.toolCount += 1;
    const result = await operation();
    if (timing) timing.toolMs += performance.now() - actionStart;
    return result;
  }

  /** The one-choice-per-turn ledger the agent kept before many sends; it is unused now. */
  private dropRelayActionChoices(): void {
    if (this.relayActionChoicesDropped) return;
    this.ctx.storage.sql.exec("DROP TABLE IF EXISTS relay_action_choices");
    this.relayActionChoicesDropped = true;
  }

  private recordRelayAdmission(admission: RelayMessageAdmission): boolean {
    this.ensureRelayAdmissionSchema();
    const sql = this.ctx.storage.sql;
    const existing = sql.exec<{ message_id: string }>(
      "SELECT message_id FROM relay_turn_admissions WHERE message_id = ?",
      admission.messageId,
    ).toArray()[0];
    if (existing) return false;
    const current = sql.exec<{
      latest_message_id: string;
      latest_message_sent_at: number;
    }>(
      `SELECT latest_message_id, latest_message_sent_at
       FROM relay_turn_state WHERE singleton = 1`,
    ).toArray()[0];
    // Only a person's Message becomes the latest: another agent's reply never
    // cancels a reply being written (one clone's reply once cancelled two
    // other clones' answers to the person).
    const becameLatest = !admission.fromAgent && (current === undefined
      || admission.sentAt > current.latest_message_sent_at
      || (
        admission.sentAt === current.latest_message_sent_at
        && admission.messageId.toLowerCase()
          > current.latest_message_id.toLowerCase()
      ));

    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        "INSERT INTO relay_turn_admissions (message_id, admitted_at) VALUES (?, ?)",
        admission.messageId,
        now,
      );
      if (becameLatest) {
        sql.exec(
          `INSERT INTO relay_turn_state (
             singleton, latest_message_id, latest_message_sent_at
           )
           VALUES (1, ?, ?)
           ON CONFLICT(singleton) DO UPDATE SET
             latest_message_id = excluded.latest_message_id,
             latest_message_sent_at = excluded.latest_message_sent_at`,
          admission.messageId,
          admission.sentAt,
        );
      }
      sql.exec(
        "DELETE FROM relay_turn_admissions WHERE admitted_at < ?",
        now - RELAY_ADMISSION_TTL_MS,
      );
    });
    return becameLatest;
  }

  private relayMessageIdentity(
    headers: Headers,
    header: string,
  ): RelayMessageAdmission | undefined {
    const value = headers.get(header);
    if (!value) return;
    const separator = value.indexOf(":");
    if (separator <= 0) return;
    const sentAt = Number(value.slice(0, separator));
    const messageId = value.slice(separator + 1);
    return Number.isSafeInteger(sentAt) && sentAt >= 0 && UUID.test(messageId)
      ? { messageId, sentAt }
      : undefined;
  }

  /** A person's Message newer than this one has landed. */
  private isRelayMessageSuperseded(messageId: string, sentAt: number): boolean {
    this.ensureRelayAdmissionSchema();
    const current = this.ctx.storage.sql.exec<{ latest_message_id: string; latest_message_sent_at: number }>(
      "SELECT latest_message_id, latest_message_sent_at FROM relay_turn_state WHERE singleton = 1",
    ).toArray()[0];
    return current !== undefined && current.latest_message_id !== messageId
      && current.latest_message_sent_at > sentAt;
  }

  private isRelayTurnSuperseded(messageId: string): boolean {
    const latestMessageId = this.latestRelayMessageId();
    if (this.relayEventTurnBases.has(messageId)) {
      return latestMessageId !== this.relayEventTurnBases.get(messageId);
    }
    return latestMessageId !== undefined && latestMessageId !== messageId;
  }

  private latestRelayMessageId(): string | undefined {
    this.ensureRelayAdmissionSchema();
    const current = this.ctx.storage.sql.exec<{ latest_message_id: string }>(
      "SELECT latest_message_id FROM relay_turn_state WHERE singleton = 1",
    ).toArray()[0];
    return current?.latest_message_id;
  }

  private assertCurrentRelayTurn(identity: RelayTurnIdentity): void {
    if (this.isRelayTurnSuperseded(identity.eventId)) {
      throw new DOMException("Relay turn superseded", "AbortError");
    }
  }

  private cancelSupersededRelayTurns(latestMessageId: string): void {
    if (this.irreversibleSend) return;
    for (const [messageId, controller] of this.activeRelayTurns) {
      if (messageId !== latestMessageId) {
        controller.abort(
          new DOMException("Relay turn superseded", "AbortError"),
        );
      }
    }
  }
}

export default {
  async fetch(
    request: Request,
    env: Bindings,
    ctx: ExecutionContext,
  ): Promise<Response> {
    isolateBorn ??= Date.now();
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      const errors = configurationErrors(env);
      return errors.length === 0
        ? Response.json({ ok: true })
        : Response.json(
            { ok: false, error: "misconfigured", details: errors },
            { status: 503 },
          );
    }

    if (request.method === "POST" && url.pathname === RELAY_WEBHOOK_PATH) {
      const t0 = performance.now();
      const authenticated = await authenticateRelayWebhook(
        request,
        requireRelayWebhookSecret(env),
        { everyGroupMessage: everyGroupMessageEnabled(env) },
      );
      const authMs = performance.now() - t0;
      if (authenticated instanceof Response) return authenticated;
      // An envelope without an event identity cannot be deduplicated. Let the
      // adapter return its canonical invalid_json response synchronously.
      if (!authenticated.delivery) {
        const agent = await getAgentByName(
          env.RelayChat,
          authenticated.instanceName,
        );
        return agent.fetch(authenticated.request());
      }

      const ack = Response.json({
        acknowledged: true,
        event_id: authenticated.delivery.eventId,
        event_type: authenticated.delivery.eventType,
      });
      if (RELAY_CALL_EVENT_TYPES.has(authenticated.delivery.eventType)) {
        const parsed = callEventSchema.safeParse(
          JSON.parse(authenticated.delivery.body),
        );
        if (!parsed.success) {
          return Response.json({ error: "invalid_call_event" }, { status: 400 });
        }
        try {
          const agent = await getAgentByName(
            env.RelayChat,
            authenticated.instanceName,
          );
          const { duplicate } = await agent.receiveRelayCallEvent(
            authenticated.delivery,
            parsed.data,
          );
          if (!duplicate && parsed.data.event_type === "call.created") {
            // The Agents SDK scheduler drives due jobs one at a time inside
            // one alarm, so a call.created job queued while a text turn ran
            // waited for that turn to end: 51 s in one measured case, past
            // the ~35 s a phone rings. The event is committed and its job
            // scheduled; after that acceptance its dispatch starts at once,
            // beside any running turn. The job stays as the durable backstop
            // and finds the event settled or in flight. A call.created
            // touches no chat history, so it cannot interleave with a turn.
            ctx.waitUntil(
              agent.processRelayCallEvent({ event_id: authenticated.delivery.eventId })
                .catch(() => undefined),
            );
          }
        } catch (error) {
          console.error(JSON.stringify({
            event: "relay_call_event_commit_failed",
            event_id: authenticated.delivery.eventId,
            event_type: authenticated.delivery.eventType,
            error_type: error instanceof Error ? error.name : typeof error,
          }));
          return Response.json({ error: "event_commit_failed" }, { status: 503 });
        }
        console.log(JSON.stringify({
          event: "relay_call_event",
          type: authenticated.delivery.eventType,
          call: parsed.data.data.call.id,
        }));
        return ack;
      }

      // A chat message commits straight into the chat's own object, which
      // stores the event in relay_event (dedupe by event_id) and schedules its
      // processing on the DO alarm before this RPC returns: the commit-before-
      // 2xx boundary, with one cold object instead of two (the per-agent inbox
      // added 1.2 s+ per message, 9/18). Thinking and replying happen after
      // this boundary; event_id and the native Action key make retries one
      // logical turn and one logical reply. A failed commit answers 503 so
      // Relay's webhook queue redelivers it.
      const t1 = performance.now();
      let initMs = 0;
      let rpcMs = 0;
      try {
        const agent = await getAgentByName(
          env.RelayChat,
          authenticated.instanceName,
        );
        initMs = performance.now() - t1;
        const rpcStarted = performance.now();
        await agent.receiveRelayEvent(authenticated.delivery);
        rpcMs = performance.now() - rpcStarted;
      } catch (error) {
        console.error(JSON.stringify({
          event: "relay_event_commit_failed",
          event_id: authenticated.delivery.eventId,
          event_type: authenticated.delivery.eventType,
          error_type: error instanceof Error ? error.name : typeof error,
        }));
        return Response.json({ error: "event_commit_failed" }, { status: 503 });
      }
      console.log(JSON.stringify({
        event: "relay_webhook_timing",
        init_ms: Math.round(initMs),
        event_type: authenticated.delivery.eventType,
        ms: {
          auth: Math.round(authMs),
          rpc: Math.round(rpcMs),
          total: Math.round(performance.now() - t0),
        },
        isolate_age_ms: Date.now() - isolateBorn,
      }));
      return ack;
    }

    // Intentionally no routeAgentRequest fallthrough. In particular, public
    // /agents/* HTTP, WebSocket, get-messages, callable RPC, and sub-agent
    // paths must never resolve a RelayChatAgent Durable Object.
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Bindings>;
