import type { RelayAdapter } from "@relaymessenger/chat-sdk-adapter";

/**
 * RELAY_EVERY_GROUP_MESSAGE lets an agent hear every group Message and
 * decide whether to answer or stay_silent. Chat SDK
 * routes an unsubscribed group Message to a handler only when it mentions the
 * bot, and Think registers no handler for the rest, so the adapter marks
 * each group Message as addressed to the agent, whether a person or another agent
 * sent it.
 */
export function withEveryGroupMessage(adapter: RelayAdapter, enabled: () => boolean): RelayAdapter {
  const parse = adapter.parseMessage.bind(adapter);
  adapter.parseMessage = (raw) => {
    const message = parse(raw);
    const chat = (raw.message as { chat?: { is_group?: unknown } } | undefined)?.chat;
    if (enabled() && raw.eventType === "message.received" && chat?.is_group === true) message.isMention = true;
    return message;
  };
  return adapter;
}
