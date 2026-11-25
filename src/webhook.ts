import {
  verifyWebhookSignature,
  WebhookVerificationError,
} from "@relaymessenger/chat-sdk-adapter";

import { PAYMENT_CHAT_METADATA_KEY } from "@relaymessenger/think";

const MAX_RELAY_WEBHOOK_BYTES = 8 * 1_048_576;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export const RELAY_MESSAGE_ADMISSION_HEADER = "x-relay-message-admission";
export const RELAY_MESSAGE_SERIAL_HEADER = "x-relay-message-serial";

export interface RelayMessageAdmission {
  messageId: string;
  sentAt: number;
  /** Sent by an agent: it never cancels a reply already being written. */
  fromAgent?: true;
}

/** Exact verified delivery persisted by the chat object (relay_event) before 2xx. */
export interface RelayWebhookDelivery {
  admission?: RelayMessageAdmission;
  body: string;
  eventId: string;
  eventType: string;
  headers: Record<string, string>;
  instanceName: string;
  serial?: RelayMessageAdmission;
  url: string;
}

function durableWebhookHeaders(headers: Headers): Record<string, string> {
  const durable: Record<string, string> = {};
  for (const name of [
    "content-type",
    "webhook-id",
    "webhook-timestamp",
    "webhook-signature",
  ]) {
    const value = headers.get(name);
    if (value !== null) durable[name] = value;
  }
  return durable;
}

export interface AuthenticatedRelayWebhook {
  admission?: RelayMessageAdmission;
  delivery?: RelayWebhookDelivery;
  serial?: RelayMessageAdmission;
  request(): Request;
  instanceName: string;
  /**
   * Identity of the delivery, when the envelope parsed.
   *
   * The Worker acknowledges a parseable delivery itself, so it needs the two
   * fields Relay expects echoed back. An unparseable envelope leaves this
   * undefined and the Agent answers with its canonical invalid_json instead.
   */
  event?: { id: string; type: string };
}

interface RelayMessageIngress extends RelayMessageAdmission {
  actionable: boolean;
}

function jsonError(status: number, code: string): Response {
  return Response.json({ error: { code } }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Format an admission/serial header value, preserving the agent-sender marker. */
export function formatRelayMessageIdentity(admission: RelayMessageAdmission): string {
  return `${admission.sentAt}:${admission.messageId}${admission.fromAgent ? ":agent" : ""}`;
}

function partMentionsOwner(part: Record<string, unknown>, ownerHandle: string): boolean {
  if (part.type !== "text") return false;
  if (Array.isArray(part.mentions)) {
    return part.mentions.some((entry) =>
      isRecord(entry)
      && (typeof entry.is_me === "boolean"
        ? entry.is_me
        : entry.handle === ownerHandle)
    );
  }
  return part.mention === ownerHandle;
}

function relayMessageIngress(
  envelope: Record<string, unknown>,
  everyGroupMessage: boolean,
): RelayMessageIngress | undefined {
  if (
    envelope.api_version !== "v1"
    || envelope.webhook_version !== "2026-08-30"
    || envelope.event_type !== "message.received"
    || typeof envelope.event_id !== "string"
    || !UUID.test(envelope.event_id)
    || typeof envelope.agent_id !== "string"
    || !UUID.test(envelope.agent_id)
    || typeof envelope.trace_id !== "string"
    || envelope.trace_id.length === 0
    || typeof envelope.created_at !== "string"
    || !Number.isFinite(Date.parse(envelope.created_at))
  ) {
    return;
  }
  const data = envelope.data;
  if (!isRecord(data) || data.direction !== "inbound") return;
  const messageId = data.id;
  const chat = data.chat;
  const sender = data.sender_handle;
  if (
    typeof messageId !== "string"
    || !UUID.test(messageId)
    || !isRecord(chat)
    || typeof chat.id !== "string"
    || !UUID.test(chat.id)
    || !isRecord(sender)
    || typeof sender.id !== "string"
    || !UUID.test(sender.id)
    || typeof sender.handle !== "string"
    || (sender.kind !== "user" && sender.kind !== "agent")
    || sender.is_me === true
    || !Array.isArray(data.parts)
  ) {
    return;
  }
  let actionable = true;
  if (chat.is_group === true && !everyGroupMessage) {
    const owner = chat.owner_handle;
    actionable = isRecord(owner)
      && typeof owner.handle === "string"
      && data.parts.some((part) =>
        isRecord(part) && partMentionsOwner(part, owner.handle as string)
      );
  }
  const sentAt = typeof data.sent_at === "string"
      && Number.isFinite(Date.parse(data.sent_at))
    ? Date.parse(data.sent_at)
    : Date.parse(envelope.created_at);
  return { actionable, messageId, sentAt, ...(sender.kind === "agent" ? { fromAgent: true as const } : {}) };
}

async function readExactBody(request: Request): Promise<Uint8Array | Response> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RELAY_WEBHOOK_BYTES) {
        await reader.cancel();
        return jsonError(413, "payload_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Authenticate the exact public request body before resolving a Durable
 * Object. RelayChatAgent repeats the adapter's verification when it parses the
 * event; this outer check is what keeps every unsigned request away from the
 * private Agent surface in the first place.
 */
export async function authenticateRelayWebhook(
  request: Request,
  secret: string,
  /** Admit every group Message; the speak gate and model may stay silent. */
  { everyGroupMessage = false }: { everyGroupMessage?: boolean } = {},
): Promise<AuthenticatedRelayWebhook | Response> {
  const body = await readExactBody(request);
  if (body instanceof Response) return body;
  let payload: string;
  try {
    payload = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return jsonError(400, "invalid_utf8");
  }
  try {
    await verifyWebhookSignature({
      headers: request.headers,
      payload,
      secret,
    });
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      return jsonError(401, "invalid_signature");
    }
    throw error;
  }
  let instanceName = "invalid";
  let admission: RelayMessageAdmission | undefined;
  let serial: RelayMessageAdmission | undefined;
  let event: { id: string; type: string } | undefined;
  try {
    const decoded: unknown = JSON.parse(payload);
    if (!isRecord(decoded)) throw new TypeError("Invalid webhook envelope");
    const envelope = decoded as {
      agent_id?: unknown;
      event_id?: unknown;
      event_type?: unknown;
      data?: {
        id?: unknown;
        chat?: {
          id?: unknown;
        };
        chat_id?: unknown;
        call?: {
          chat_id?: unknown;
        };
        // A payment.* event carries the PaymentRequest, whose metadata names
        // the Chat the agent sent it in (payment.ts PAYMENT_CHAT_METADATA_KEY).
        metadata?: Record<string, unknown>;
      };
    } & Record<string, unknown>;
    if (
      typeof envelope.event_id === "string"
      && typeof envelope.event_type === "string"
    ) {
      event = { id: envelope.event_id, type: envelope.event_type };
    }
    const chatId = envelope.data?.chat?.id ?? envelope.data?.chat_id
      ?? envelope.data?.call?.chat_id
      // chat.created carries the Chat itself as its data.
      ?? (envelope.event_type === "chat.created" ? envelope.data?.id : undefined)
      ?? (String(envelope.event_type).startsWith("payment.")
        ? envelope.data?.metadata?.[PAYMENT_CHAT_METADATA_KEY]
        : undefined);
    if (typeof chatId === "string" && UUID.test(chatId)) {
      instanceName = `chat:${chatId}`;
    } else if (
      typeof envelope.agent_id === "string"
      && UUID.test(envelope.agent_id)
    ) {
      instanceName = `agent:${envelope.agent_id}`;
    }
    const ingress = relayMessageIngress(envelope, everyGroupMessage);
    if (ingress) {
      serial = {
        messageId: ingress.messageId,
        sentAt: ingress.sentAt,
        ...(ingress.fromAgent ? { fromAgent: true as const } : {}),
      };
      if (ingress.actionable) admission = serial;
    }
  } catch {
    // The adapter returns the canonical invalid_json response inside the
    // authenticated Agent. This fallback only chooses its isolated instance.
  }
  const url = request.url;
  const headers = new Headers(request.headers);
  if (serial) {
    headers.set(
      RELAY_MESSAGE_SERIAL_HEADER,
      formatRelayMessageIdentity(serial),
    );
  } else {
    headers.delete(RELAY_MESSAGE_SERIAL_HEADER);
  }
  if (admission) {
    headers.set(
      RELAY_MESSAGE_ADMISSION_HEADER,
      formatRelayMessageIdentity(admission),
    );
  } else {
    headers.delete(RELAY_MESSAGE_ADMISSION_HEADER);
  }
  const relayBody = body.slice().buffer as ArrayBuffer;
  return {
    instanceName,
    ...(admission ? { admission } : {}),
    ...(event
      ? {
        delivery: {
          ...(admission ? { admission } : {}),
          body: payload,
          eventId: event.id,
          eventType: event.type,
          // Persist only what the adapter needs to parse and repeat Standard
          // Webhooks verification. Arbitrary client/Cloudflare headers do not
          // become durable data.
          headers: durableWebhookHeaders(headers),
          instanceName,
          ...(serial ? { serial } : {}),
          url,
        },
      }
      : {}),
    ...(event ? { event } : {}),
    ...(serial ? { serial } : {}),
    // Construct the body stream only for the Agent fetch context. A Request
    // created earlier cannot safely cross a Durable Object I/O ownership
    // boundary under workerd.
    request: () =>
      new Request(url, {
        method: "POST",
        headers,
        body: relayBody,
      }),
  };
}
