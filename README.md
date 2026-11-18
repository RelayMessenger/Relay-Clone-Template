# Relay Clone Template

Build a [Relay](https://relayapp.im) agent that talks as one person, from that person's own writing.

Make your clone in six steps: write the persona, add the person's writing, set up Cloudflare, build the source index, deploy, and connect it to Relay. The example persona is Ada Lovelace, from her 1843 Notes on the Analytical Engine.

## Before you start

- Node.js 22.22.3 or newer.
- A Cloudflare account with Workers AI and Vectorize.
- A Google Cloud project with the Vertex AI API on.
- A Relay agent from [Relay Console](https://console.relayapp.im) and its Agent Token.

## 1. Use the template

Choose **Use this template** on GitHub, then clone your new repository and install it:

```sh
git clone https://github.com/<you>/<your-clone>.git
cd <your-clone>
npm ci
```

## 2. Write the persona

[`persona/persona.md`](persona/persona.md) is the first line of the agent's system prompt. Keep it short and name the person:

```md
You are Ada Lovelace, an AI clone built from her public words.
```

The agent learns how the person thinks from their sources, not from rules in this file.

## 3. Add the person's writing

Put their writing in [`persona/sources/`](persona/sources) as `.txt` or `.md` files. Each file can start with front matter that the agent reads with every passage:

```md
---
title: Notes by the Translator
date: 1843
url: https://en.wikisource.org/wiki/...
kind: notes
attribution: own-writing
---
```

`attribution` tells the agent whose words a passage holds: `own-writing`, `monologue`, `speaker-labeled` (set `speaker` too), `unlabeled-dialogue` or `about-person`. The agent quotes exact words only from the first three. Use only text you have the right to use.

## 4. Set up Cloudflare

Create the source index. The name must match `index_name` in [`wrangler.jsonc`](wrangler.jsonc):

```sh
npx wrangler login
npx wrangler vectorize create my-clone-sources --dimensions=1024 --metric=cosine
```

Create an [AI Gateway](https://developers.cloudflare.com/ai-gateway/) with authentication on. Add your Google service account under **Provider Keys** as a [Google Vertex AI key](https://developers.cloudflare.com/ai-gateway/usage/providers/vertex/), and create a gateway token.

In `wrangler.jsonc`, replace every `UNCONFIGURED_` value: your Cloudflare account ID, gateway ID, Vertex project ID, and your agent's handle without the `@`. Rename the Worker if you like.

## 5. Build the source index

Embed every passage with Workers AI `@cf/baai/bge-m3` and write it to your index:

```sh
export CLOUDFLARE_ACCOUNT_ID=<your account ID>
export CLOUDFLARE_API_TOKEN=<token with Workers AI and Vectorize edit>
npm run sources -- persona/sources
```

Add `--dry-run` to count passages without calling Cloudflare. Run it again whenever the sources change; a passage keeps its ID, so a rerun replaces it.

## 6. Deploy and connect to Relay

Copy [`.dev.vars.example`](.dev.vars.example) to `.dev.vars`, fill in the Agent Token and gateway token, then send the secrets and deploy:

```sh
cp .dev.vars.example .dev.vars
npx wrangler secret bulk .dev.vars
npm run deploy
```

Subscribe the agent to the Worker's `/webhooks/relay` route. Use the `workers.dev` address the deploy printed:

```sh
export RELAY_AGENT_TOKEN=<your Agent Token>
curl -sS -X POST https://api.relayapp.im/v1/webhook-subscriptions \
  -H "Authorization: Bearer $RELAY_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "target_url": "https://my-clone-agent.<subdomain>.workers.dev/webhooks/relay",
    "subscribed_events": ["message.received","reaction.added","reaction.removed","participant.added","participant.removed","chat.created","chat.group_name_updated","chat.group_icon_updated","call.created","call.updated","call.ended","payment.succeeded","payment.canceled","payment.expired","location.sharing.started","location.sharing.stopped"]
  }'
npx wrangler secret put RELAY_WEBHOOK_SECRET
```

Relay shows `signing_secret` once, in that response. Paste it into the last command. Check that `https://my-clone-agent.<subdomain>.workers.dev/healthz` answers `{"ok":true}`, then open Relay on your phone and message your agent's handle.

## What it does

| Feature | How |
| --- | --- |
| Talk as the person | The persona file starts the system prompt. `search_sources` finds the person's passages before the agent gives a view. |
| Group chats | The agent hears every message, works out who it is for, and answers once. It can stay silent. |
| Long chats | Think keeps the chat history. Compaction keeps every person's message word for word and summarizes the agents' own. |
| Web search | Google Search and page reading through Vertex. Set `RELAY_WEB_SEARCH` to `false` to turn it off. |
| Voice calls | Not included. The agent ends a call while it rings, so the caller sees it is unavailable. |

## Group chats with other clones

In a group chat, the agent asks a small Workers AI model (`@cf/cloudflare/clef-flash`) which member a message is for. When several agents built from this template share a group, list the other handles in `RELAY_SPEAK_PEERS`, separated by commas. Each agent then gives the same text to the check, and only the agents a message is for answer. Set `RELAY_SPEAK_GATE` to empty to turn the check off.

## Change the models

`VERTEX_MODEL` is the chat model. `VERTEX_FAST_MODEL` runs the quick checks and `VERTEX_SUMMARY_MODEL` writes the summaries. Change them in `wrangler.jsonc`. [`src/model.ts`](src/model.ts) builds each one through AI Gateway.

## Run the tests

Tests use mocks and make no paid model calls:

```sh
npm run types:check
npm run check
npm test
npm run dry-run
```

## When it fails

- `401` on `/webhooks/relay`: `RELAY_WEBHOOK_SECRET` does not match the subscription's `signing_secret`.
- `/healthz` answers `503`: its `details` name each setting still `UNCONFIGURED_` or each missing secret.
- No reply arrives: run `npx wrangler tail` and send a message. Model errors name the gateway or the Vertex model.
- The agent never cites a source: check the index has vectors with `npx wrangler vectorize info my-clone-sources`.

## Learn more

- [Relay developer docs](https://docs.relayapp.im)
- [Webhook subscriptions](https://docs.relayapp.im/webhooks/subscriptions)
- [Group chats](https://docs.relayapp.im/chats/group-chats)
- [Cloudflare Think](https://developers.cloudflare.com/agents/harnesses/think/)
- [Vectorize](https://developers.cloudflare.com/vectorize/)

## License

MIT, Copyright (c) 2026 Companion Inc. The sample source text is public domain.
