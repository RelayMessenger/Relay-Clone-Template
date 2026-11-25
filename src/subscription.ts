// The agent's webhook subscription is data on Relay, changed only through
// POST and PUT /v1/webhook-subscriptions. This list is its one source: use it
// as `subscribed_events` (README.md), and test/subscription.test.ts fails
// when src names an event type this list leaves out. A subscription that
// names fewer events leaves their handlers idle: one that named only
// message, call and location events never ran the reaction handler.
import {
  RELAY_WEBHOOK_EVENT_TYPES,
  type RelayWebhookEventType,
} from "@relaymessenger/chat-sdk-adapter";

import {
  RELAY_CALL_EVENT_TYPES,
  RELAY_CHAT_CONTEXT_EVENT_TYPES,
  RELAY_LOCATION_EVENT_TYPES,
  RELAY_PAYMENT_EVENT_TYPES,
  RELAY_REACTION_EVENT_TYPES,
} from "@relaymessenger/think";

/** The event that opens a Chat. */
export const RELAY_CHAT_OPENED_EVENT = "chat.created";

/** Where Relay delivers the agent's webhooks on this Worker's own hostname. */
export const RELAY_WEBHOOK_PATH = "/webhooks/relay";

/** Every event type a handler in src acts on. */
export const RELAY_HANDLED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "message.received",
  ...RELAY_CALL_EVENT_TYPES,
  ...RELAY_REACTION_EVENT_TYPES,
  ...RELAY_PAYMENT_EVENT_TYPES,
  ...RELAY_LOCATION_EVENT_TYPES,
  ...RELAY_CHAT_CONTEXT_EVENT_TYPES,
  RELAY_CHAT_OPENED_EVENT,
]);

/** The subscription's `subscribed_events`, in the contract catalogue's order. */
export const RELAY_SUBSCRIBED_EVENTS: readonly RelayWebhookEventType[] =
  RELAY_WEBHOOK_EVENT_TYPES.filter((type) => RELAY_HANDLED_EVENT_TYPES.has(type));
