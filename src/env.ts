/** Bindings are generated from wrangler.jsonc by `wrangler types`. */
export type Bindings = Cloudflare.Env & CloneBindings;

/** Optional bindings and settings; `wrangler types` marks only some of them. */
export interface CloneBindings {
  AI?: Ai;
  CLONE_INDEX?: VectorizeIndex;
  RELAY_EVERY_GROUP_MESSAGE?: string;
  RELAY_SPEAK_GATE?: string;
  RELAY_SPEAK_STAGGER_S?: string;
  /** Comma-separated handles of the other agents running the same speak gate. */
  RELAY_SPEAK_PEERS?: string;
}

export function everyGroupMessageEnabled(env: CloneBindings): boolean {
  return env.RELAY_EVERY_GROUP_MESSAGE === "true";
}

export class ConfigurationError extends Error {}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new ConfigurationError(`${name} is not configured`);
  return value;
}

export function requireRelayWebhookSecret(env: Bindings): string {
  return required(env.RELAY_WEBHOOK_SECRET, "RELAY_WEBHOOK_SECRET");
}

export function requireRelayToken(env: Pick<Bindings, "RELAY_AGENT_TOKEN">): string {
  return required(env.RELAY_AGENT_TOKEN, "RELAY_AGENT_TOKEN");
}

/** Whether the agent marks a person's Message read the moment it arrives. */
export function relayMarkReadOnReceipt(
  env: { RELAY_MARK_READ_ON_RECEIPT?: string },
): boolean {
  return env.RELAY_MARK_READ_ON_RECEIPT === "true";
}

export function requireGatewayToken(
  env: Pick<Bindings, "CLOUDFLARE_AI_GATEWAY_TOKEN">,
): string {
  return required(
    env.CLOUDFLARE_AI_GATEWAY_TOKEN,
    "CLOUDFLARE_AI_GATEWAY_TOKEN",
  );
}

// Loopback hosts only, so `wrangler dev` can point RELAY_API_ORIGIN at a
// server on the same machine while still refusing plain HTTP to any real
// origin.
const RELAY_API_ORIGIN_LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function configurationErrors(
  env: Bindings,
): string[] {
  const errors: string[] = [];
  for (const [name, value] of Object.entries({
    RELAY_AGENT_TOKEN: env.RELAY_AGENT_TOKEN,
    RELAY_WEBHOOK_SECRET: env.RELAY_WEBHOOK_SECRET,
    CLOUDFLARE_AI_GATEWAY_TOKEN: env.CLOUDFLARE_AI_GATEWAY_TOKEN,
    AI_GATEWAY_ID: env.AI_GATEWAY_ID,
    CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
    VERTEX_PROJECT_ID: env.VERTEX_PROJECT_ID,
    VERTEX_LOCATION: env.VERTEX_LOCATION,
    VERTEX_MODEL: env.VERTEX_MODEL,
    VERTEX_FAST_MODEL: env.VERTEX_FAST_MODEL,
    VERTEX_SUMMARY_MODEL: env.VERTEX_SUMMARY_MODEL,
    RELAY_AGENT_HANDLE: env.RELAY_AGENT_HANDLE,
    RELAY_MARK_READ_ON_RECEIPT: env.RELAY_MARK_READ_ON_RECEIPT,
  })) {
    if (!value?.trim()) errors.push(`${name} is not configured`);
  }
  if (env.AI_GATEWAY_ID?.startsWith("UNCONFIGURED_")) {
    errors.push("AI_GATEWAY_ID is not configured");
  }
  if (env.VERTEX_PROJECT_ID?.startsWith("UNCONFIGURED_")) {
    errors.push("VERTEX_PROJECT_ID is not configured");
  }
  if (env.CLOUDFLARE_ACCOUNT_ID?.startsWith("UNCONFIGURED_")) {
    errors.push("CLOUDFLARE_ACCOUNT_ID is not configured");
  }
  if (env.RELAY_AGENT_HANDLE?.startsWith("UNCONFIGURED_")) {
    errors.push("RELAY_AGENT_HANDLE is not configured");
  }
  const markReadOnReceipt: string | undefined =
    env.RELAY_MARK_READ_ON_RECEIPT;
  if (markReadOnReceipt !== "true" && markReadOnReceipt !== "false") {
    errors.push("RELAY_MARK_READ_ON_RECEIPT must be true or false");
  }
  try {
    const origin = new URL(env.RELAY_API_ORIGIN);
    const isLoopbackHttp = origin.protocol === "http:"
      && RELAY_API_ORIGIN_LOOPBACK_HOSTS.has(origin.hostname);
    if (origin.protocol !== "https:" && !isLoopbackHttp) {
      errors.push("RELAY_API_ORIGIN must use HTTPS");
    }
  } catch {
    errors.push("RELAY_API_ORIGIN is invalid");
  }
  return errors;
}
