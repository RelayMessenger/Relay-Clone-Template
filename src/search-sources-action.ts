import { action, type Action } from "@cloudflare/think";
import { createRelayClient, type RelayGenerationActivities } from "@relaymessenger/think";
import type { RelayTurnIdentity } from "@relaymessenger/think/actions";

import type { Bindings } from "./env";
import { SEARCH_SOURCES_DESCRIPTION, searchSources, searchSourcesInputSchema } from "./search-sources";

/** What the search_sources Action runs on: a subset of the Relay Actions' hooks. */
export interface SearchSourcesActionDependencies {
  env: Bindings;
  activities: RelayGenerationActivities;
  turn(): RelayTurnIdentity;
  signal(platformSignal?: AbortSignal): AbortSignal | undefined;
  assertCurrentTurn(identity: RelayTurnIdentity): void;
  waitUntil(task: Promise<void>): void;
}

/** This agent's own tool beside the Relay Actions: a read of its source archive. */
export function searchSourcesActions(deps: SearchSourcesActionDependencies): Record<string, Action> {
  if (!deps.env.CLONE_INDEX) return {};
  return {
    search_sources: action({
      description: SEARCH_SOURCES_DESCRIPTION,
      inputSchema: searchSourcesInputSchema,
      execute: async (input, context) => {
        const identity = deps.turn();
        const signal = deps.signal(context.signal);
        const assertCurrent = () => {
          signal?.throwIfAborted();
          deps.assertCurrentTurn(identity);
        };
        assertCurrent();
        const activity = deps.activities.start(
          createRelayClient(deps.env).chats,
          identity.chatId,
          { text: input.activity, emoji: null },
          assertCurrent,
          (task) => deps.waitUntil(task),
        );
        try {
          return await searchSources(deps.env, input.query, signal);
        } finally {
          await activity.stop();
        }
      },
    }),
  };
}
