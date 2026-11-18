/**
 * Facts from the web: Gemini's own Grounding with Google Search, as the AI
 * SDK's provider tool (`google.google_search`), offered in the same request
 * as this agent's Actions, on Vertex through the AI Gateway.
 *
 * The send Action strips Gemini's citation markers ([1.2]) when relayActions
 * gets `webSearch: true` (@relaymessenger/think withoutSearchMarkers).
 */

/** A Worker without the flag offers no search. */
export function webSearchEnabled(env: { RELAY_WEB_SEARCH?: string }): boolean {
  return env.RELAY_WEB_SEARCH === "true";
}

/** The tool's name in the turn's tool set. */
export const WEB_SEARCH_TOOL = "google_search";

/** Gemini's URL context tool, offered beside Google Search under the same flag. */
export const URL_CONTEXT_TOOL = "url_context";

export const WEB_SEARCH_GUIDANCE = "You can look things up on Google Search. Search before you state a fact that "
  + "changes or that you are not sure of: a price, a fare, a law, a rule, a schedule, today's news, whether "
  + "something is a scam. Never invent a number or a source. Your words are what the person reads: never write "
  + "search citation markers such as [1.2]; say where the fact comes from in plain words (the site, the "
  + "company or the law), and never make up a web address. You can also open and read a web page someone sends you.";

interface GroundingMetadata {
  webSearchQueries?: string[];
  groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
}

/**
 * What one model step searched, read from the Vertex provider's metadata
 * (`googleVertex.groundingMetadata`, the Gemini response field): the queries
 * and any web sources. Undefined when the step did not search.
 */
export function webSearchUse(
  providerMetadata: Record<string, Record<string, unknown>> | undefined,
): { queries: string[]; sources: Array<{ title?: string; uri?: string }> } | undefined {
  const grounding = (providerMetadata?.googleVertex ?? providerMetadata?.vertex)
    ?.groundingMetadata as GroundingMetadata | undefined;
  const queries = grounding?.webSearchQueries ?? [];
  if (queries.length === 0) return undefined;
  return {
    queries,
    sources: (grounding?.groundingChunks ?? [])
      .flatMap(({ web }) => web ? [{ title: web.title, uri: web.uri }] : []),
  };
}

interface UrlContextMetadata {
  urlMetadata?: Array<{ retrievedUrl?: string; urlRetrievalStatus?: string }> | null;
}

/**
 * The pages one model step opened with URL context, read from the Vertex
 * provider's metadata (`urlContextMetadata`, the Gemini response field): each
 * URL and its retrieval status. Undefined when the step opened no page.
 */
export function urlContextUse(
  providerMetadata: Record<string, Record<string, unknown>> | undefined,
): { urls: Array<{ url?: string; status?: string }> } | undefined {
  const metadata = (providerMetadata?.googleVertex ?? providerMetadata?.vertex)
    ?.urlContextMetadata as UrlContextMetadata | undefined;
  const urls = (metadata?.urlMetadata ?? [])
    .map(({ retrievedUrl, urlRetrievalStatus }) => ({ url: retrievedUrl, status: urlRetrievalStatus }));
  return urls.length === 0 ? undefined : { urls };
}
