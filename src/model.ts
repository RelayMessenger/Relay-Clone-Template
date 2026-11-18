import { createAiGateway } from "ai-gateway-provider";
import { createVertex } from "ai-gateway-provider/providers/google-vertex";

import type { Bindings } from "./env";
import { ConfigurationError, requireGatewayToken } from "./env";

// ai-gateway-provider replaces the Vertex model's fetch implementation before
// execution. Supplying its delegate sentinel selects the no-OAuth provider
// path; the sentinel is never a credential and is not sent to Google.
const AI_GATEWAY_DELEGATE_TOKEN = "CF_TEMP_TOKEN";

function relayVertex(env: Bindings) {
  const project = encodeURIComponent(env.VERTEX_PROJECT_ID);
  const location = encodeURIComponent(env.VERTEX_LOCATION);
  return createVertex({
    apiKey: AI_GATEWAY_DELEGATE_TOKEN,
    project: env.VERTEX_PROJECT_ID,
    location: env.VERTEX_LOCATION,
    baseURL:
      `https://aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google`,
  });
}

/** Grounding with Google Search, the Vertex provider's own tool (src/web-search.ts). */
export function relayWebSearchTool(
  env: Bindings,
): ReturnType<ReturnType<typeof createVertex>["tools"]["googleSearch"]> {
  return relayVertex(env).tools.googleSearch({});
}

/** URL context, the Vertex provider's own tool for reading a web page (src/web-search.ts). */
export function relayUrlContextTool(
  env: Bindings,
): ReturnType<ReturnType<typeof createVertex>["tools"]["urlContext"]> {
  return relayVertex(env).tools.urlContext({});
}

/** The small model for quick yes/no reads of the group (src/speak-gate.ts). */
export function relayFastModel(env: Bindings) {
  const id = env.VERTEX_FAST_MODEL?.trim();
  if (!id) throw new ConfigurationError("VERTEX_FAST_MODEL is not configured");
  return relayGateway(env)(relayVertex(env)(id));
}

function relayGateway(env: Bindings) {
  return createAiGateway({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    gateway: env.AI_GATEWAY_ID,
    apiKey: requireGatewayToken(env),
    options: {
      requestTimeoutMs: 60_000,
      retries: {
        maxAttempts: 2,
        retryDelayMs: 250,
        backoff: "exponential",
      },
    },
  });
}

/** The chat model: every turn, thought and reaction. */
export function relayModel(env: Bindings) {
  return relayGateway(env)(relayVertex(env)(env.VERTEX_MODEL));
}

/**
 * The small model that writes the conversation summary when Think compacts
 * the Session; chat stays on VERTEX_MODEL. Same Vertex-through-AI-Gateway
 * path as the chat model.
 */
export function relaySummaryModel(env: Bindings) {
  const model = env.VERTEX_SUMMARY_MODEL;
  if (!model?.trim()) throw new ConfigurationError("VERTEX_SUMMARY_MODEL is not configured");
  return relayGateway(env)(relayVertex(env)(model));
}
