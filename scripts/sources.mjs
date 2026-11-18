#!/usr/bin/env node
// Builds the agent's source index: reads every .txt and .md file in a folder,
// cuts each into passages, embeds them with Workers AI @cf/baai/bge-m3 (1024
// dimensions) and upserts them to the Vectorize index named in wrangler.jsonc.
//
//   npm run sources -- persona/sources
//   npm run sources -- persona/sources --dry-run
//
// Needs CLOUDFLARE_ACCOUNT_ID and a CLOUDFLARE_API_TOKEN with Workers AI and
// Vectorize edit access. --dry-run reads and cuts the files and calls nothing.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

export const EMBEDDING_MODEL = "@cf/baai/bge-m3";
export const DIMENSIONS = 1024;
/** Passages are packed up to this many characters, so one stays one idea and fits Vectorize metadata. */
export const MAX_PASSAGE_CHARS = 1500;
const EMBED_BATCH = 50;
const UPSERT_BATCH = 500;
const FIELDS = ["title", "date", "url", "kind", "attribution", "speaker"];

/** Splits optional `---` front matter (one `key: value` per line) from the body. */
export function parseSource(raw) {
  const text = raw.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return { fields: {}, body: text.trim() };
  const fields = {};
  for (const line of match[1].split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (FIELDS.includes(key) && value) fields[key] = value;
  }
  return { fields, body: text.slice(match[0].length).trim() };
}

/** Cuts a body into passages: whole paragraphs where they fit, whole sentences where they do not. */
export function passages(body, max = MAX_PASSAGE_CHARS) {
  const pieces = [];
  for (const paragraph of body.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean)) {
    if (paragraph.length <= max) { pieces.push(paragraph); continue; }
    for (const sentence of paragraph.match(/[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g) ?? [paragraph]) {
      const s = sentence.trim();
      for (let at = 0; at < s.length; at += max) pieces.push(s.slice(at, at + max));
    }
  }
  const out = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + 1 + piece.length > max) { out.push(current); current = ""; }
    current = current ? `${current} ${piece}` : piece;
  }
  if (current) out.push(current);
  return out;
}

/** One stable ID per passage, so a rerun replaces passages instead of adding copies. */
export function passageId(file, index) {
  return createHash("sha256").update(`${file}\n${index}`).digest("hex").slice(0, 48);
}

/** Every passage in every .txt and .md file under `folder`, with its metadata. */
export async function readSources(folder) {
  const files = (await readdir(folder, { recursive: true }))
    .filter((name) => [".txt", ".md"].includes(extname(name).toLowerCase()))
    .sort();
  const rows = [];
  for (const name of files) {
    const { fields, body } = parseSource(await readFile(join(folder, name), "utf8"));
    const file = relative(".", join(folder, name));
    passages(body).forEach((text, index) => {
      rows.push({ id: passageId(file, index), metadata: { ...fields, title: fields.title ?? name, source: file, text } });
    });
  }
  return rows;
}

/** The Vectorize index name from wrangler.jsonc, whose comments are whole lines. */
export async function indexName(config = "wrangler.jsonc") {
  const json = JSON.parse((await readFile(config, "utf8")).replace(/^\s*\/\/.*$/gm, ""));
  const name = json.vectorize?.[0]?.index_name;
  if (!name) throw new Error(`${config} names no Vectorize index`);
  return name;
}

async function cloudflare(fetchImpl, token, url, init) {
  const response = await fetchImpl(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success === false) {
    const reason = body?.errors?.map((e) => e.message).join("; ") || response.statusText;
    throw new Error(`Cloudflare API ${response.status}: ${reason}`);
  }
  return body.result;
}

/** Embeds and upserts `rows`. Returns the number of passages written. */
export async function upload(rows, { accountId, token, index, fetchImpl = fetch, log = () => {} }) {
  const api = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  const vectors = [];
  for (let at = 0; at < rows.length; at += EMBED_BATCH) {
    const batch = rows.slice(at, at + EMBED_BATCH);
    const result = await cloudflare(fetchImpl, token, `${api}/ai/run/${EMBEDDING_MODEL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: batch.map((row) => row.metadata.text) }),
    });
    if (result?.data?.length !== batch.length || result.data.some((v) => v.length !== DIMENSIONS)) {
      throw new Error(`${EMBEDDING_MODEL} did not return ${batch.length} vectors of ${DIMENSIONS} dimensions`);
    }
    batch.forEach((row, i) => vectors.push({ id: row.id, values: result.data[i], metadata: row.metadata }));
    log(`Embedded ${vectors.length} of ${rows.length}`);
  }
  for (let at = 0; at < vectors.length; at += UPSERT_BATCH) {
    await cloudflare(fetchImpl, token, `${api}/vectorize/v2/indexes/${encodeURIComponent(index)}/upsert`, {
      method: "POST",
      headers: { "Content-Type": "application/x-ndjson" },
      body: vectors.slice(at, at + UPSERT_BATCH).map((v) => JSON.stringify(v)).join("\n"),
    });
  }
  log(`Upserted ${vectors.length} passages to ${index}`);
  return vectors.length;
}

async function main(args) {
  const dryRun = args.includes("--dry-run");
  const folder = args.find((arg) => !arg.startsWith("--"));
  if (!folder) throw new Error("Usage: npm run sources -- <folder of .txt and .md files> [--dry-run]");
  const rows = await readSources(folder);
  if (!rows.length) throw new Error(`No .txt or .md files with text in ${folder}`);
  const index = await indexName();
  console.log(`${rows.length} passages from ${new Set(rows.map((r) => r.metadata.source)).size} files for ${index}`);
  if (dryRun) return;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN");
  await upload(rows, { accountId, token, index, log: console.log });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
