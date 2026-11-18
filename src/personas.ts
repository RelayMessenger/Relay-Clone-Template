// The person this agent speaks as: persona/persona.md, one file per Worker.
import persona from "../persona/persona.md";
import { ConfigurationError } from "./env";
import { GROUP_CHAT_GUIDANCE, RELAY_CAPABILITY_GUIDANCE } from "./prompt";

/** The persona file's words. */
export const PERSONA: string = persona;

/**
 * Capability guidance for an agent with no voice calls. This is guidance the
 * model reads, never text sent to the person.
 */
export const VOICE_OFF_GUIDANCE = "Calls are not available for you yet: you cannot place, take or schedule a voice or video call, and you have no Action for one. Never offer, promise, suggest or schedule a call, and never ask the person to call you or to start one. Where your own instructions describe doing something on a call, do it by text in this chat instead: ask for a photo or a short video to send, and write the check-in, review or story as messages.";

/**
 * The system prompt for this Worker's agent: the persona file, then what the
 * agent can do in Relay, then how it takes part in a group chat. An empty
 * persona file fails closed. This template has no voice calls, so the model
 * is told it has none.
 */
export function agentSystemPrompt(words: string = PERSONA): string {
  const text = words.trim();
  if (!text) throw new ConfigurationError("persona/persona.md is empty");
  return `${text}\n\n${RELAY_CAPABILITY_GUIDANCE}\n\n${GROUP_CHAT_GUIDANCE}\n\n${VOICE_OFF_GUIDANCE}`;
}

/**
 * Gemini's thinking level for a persona agent's turns: `high`. Measured on a
 * real group chat of seven clones (10 real messages each from its person, a
 * 300-message history, a blind judge of whether the reply engages the
 * person's actual premise): a Flash model at `low` scored 37/70 and put words
 * in the person's mouth 17/70 times, median 7 s; a Hydrogen model at `low`
 * 43/70 and 10/70, 5 s; Hydrogen at `high` 51/70 and 7/70, 12 s.
 */
export const AGENT_THINKING_LEVEL = "high";
