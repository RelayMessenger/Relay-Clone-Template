import { SELECTION_GUIDANCE } from "@relaymessenger/sdk";

import { CARD_GUIDANCE, PAYMENT_GUIDANCE } from "@relaymessenger/think";

/**
 * When to send buttons. The same text every Relay runtime carries
 * (@relaymessenger/sdk BUTTONS_GUIDANCE), so a person gets buttons under the
 * same conditions whichever agent they talk to.
 */
export const BUTTONS_GUIDANCE = [
  "Send buttons when your message ends with a question the person can answer by picking one of 2 to 5 short options you already know: yes or no, choosing between things you named, picking a next step, or a multiple-choice question in a quiz. Each label is a complete answer, so a tap replaces typing. Put the question in text beside the buttons.",
  "Send one button when there is one thing to do next. A url button is for a task the person completes on a web page: pay, sign in, connect an account, open their booking or order, track a package. Its label names the action, not the site. A plain button confirms one step: Start, Done, Continue. Do not ask \"ready?\" when a single button does the job.",
  "A link is for something the person will look at or read: an article, a listing, a video, a place, a product page, a support article. Send it as a link on its own, so it draws as a card with the page's title and image; never paste a bare URL into your words, and send one link per message. When the page is where the person does something, send a url button; when the page is the thing you are showing them, send a link.",
  "Do not send buttons when the answer is open-ended, when your options are not the full set of likely answers, or when you are not asking anything and there is nothing to do. One question or one action per message; never a menu of things you can do, and never as decoration.",
  "If you would otherwise write \"reply 1, 2 or 3\" or list choices for the person to type, send buttons instead. If the person asks for buttons, send them.",
  "A tap comes back to you as an ordinary message whose text is the label. Labels are at most 80 characters.",
  "Buttons disappear once tapped.",
].join(" ");

/** What every agent this Worker runs can do in Relay, whoever it is. */
export const RELAY_CAPABILITY_GUIDANCE = `${BUTTONS_GUIDANCE}

${SELECTION_GUIDANCE} To ask one, send kind text with the question in title and the options in selection. The person's answer comes back as bullet lines of the labels they chose, followed by the values as data.

${PAYMENT_GUIDANCE}

${CARD_GUIDANCE}`;

/**
 * Group chats. Every clone gets a turn on every message, from a person or
 * another agent (src/speak-gate.ts), and its own model decides whether to
 * speak or stay_silent. The prompt carries no rule list about who answers
 * (a rule list silenced members with greater insight), so it names the human
 * group-chat frame and nothing else.
 */
export const GROUP_CHAT_GUIDANCE = "You are one member of this group chat, and you take part the way a real person does in a group chat with friends: most of the time you read along, you answer when someone talks to you, and you jump in when you have something that really adds.";
