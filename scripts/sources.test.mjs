import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DIMENSIONS, MAX_PASSAGE_CHARS, indexName, parseSource, passageId, passages, readSources, upload } from "./sources.mjs";

describe("parseSource", () => {
  it("reads front matter fields and keeps the body", () => {
    const { fields, body } = parseSource("---\ntitle: Notes\ndate: 1843\nattribution: own-writing\nother: x\n---\n\nBody text.\n");
    assert.deepEqual(fields, { title: "Notes", date: "1843", attribution: "own-writing" });
    assert.equal(body, "Body text.");
  });

  it("treats a file with no front matter as all body", () => {
    assert.deepEqual(parseSource("Just words.\n"), { fields: {}, body: "Just words." });
  });
});

describe("passages", () => {
  it("packs short paragraphs together up to the limit", () => {
    assert.deepEqual(passages("One.\n\nTwo.\n\nThree.", 10), ["One. Two.", "Three."]);
  });

  it("cuts a long paragraph at sentence ends and keeps every word", () => {
    const paragraph = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const out = passages(paragraph, 200);
    assert.ok(out.length > 1);
    assert.ok(out.every((p) => p.length <= 200));
    assert.equal(out.join(" "), paragraph);
    assert.ok(out.every((p) => p.endsWith(".")));
  });
});

describe("readSources", () => {
  it("reads the example persona's sources with stable ids and their fields", async () => {
    const rows = await readSources("persona/sources");
    assert.ok(rows.length > 3);
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
    assert.equal(rows[0].id, passageId("persona/sources/notes-on-the-analytical-engine.md", 0));
    for (const row of rows) {
      assert.ok(row.metadata.text.length <= MAX_PASSAGE_CHARS);
      assert.equal(row.metadata.attribution, "own-writing");
      assert.equal(row.metadata.date, "1843");
    }
    assert.ok(rows.some((r) => r.metadata.text.includes("no pretensions whatever to originate any thing")));
  });

  it("finds the index named in wrangler.jsonc", async () => {
    assert.equal(await indexName(), "my-clone-sources");
  });
});

describe("upload", () => {
  const rows = [
    { id: "a", metadata: { text: "first", title: "T", source: "s" } },
    { id: "b", metadata: { text: "second", title: "T", source: "s" } },
  ];

  it("embeds with bge-m3 and upserts NDJSON to the index, with no real request", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      const result = url.includes("/ai/run/")
        ? { data: JSON.parse(init.body).text.map(() => Array(DIMENSIONS).fill(0.1)) }
        : { mutationId: "m" };
      return new Response(JSON.stringify({ success: true, result }), { status: 200 });
    };
    assert.equal(await upload(rows, { accountId: "acc", token: "tok", index: "idx", fetchImpl }), 2);
    assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/baai/bge-m3");
    assert.deepEqual(JSON.parse(calls[0].init.body), { text: ["first", "second"] });
    assert.equal(calls[0].init.headers.Authorization, "Bearer tok");
    assert.equal(calls[1].url, "https://api.cloudflare.com/client/v4/accounts/acc/vectorize/v2/indexes/idx/upsert");
    assert.equal(calls[1].init.headers["Content-Type"], "application/x-ndjson");
    const lines = calls[1].init.body.split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.id, l.values.length, l.metadata.text]), [["a", DIMENSIONS, "first"], ["b", DIMENSIONS, "second"]]);
  });

  it("stops before upserting when the embedding has the wrong size", async () => {
    let upserted = false;
    const fetchImpl = async (url) => {
      if (url.includes("/upsert")) upserted = true;
      return new Response(JSON.stringify({ success: true, result: { data: [[0.1], [0.2]] } }));
    };
    await assert.rejects(upload(rows, { accountId: "a", token: "t", index: "i", fetchImpl }), /1024 dimensions/);
    assert.equal(upserted, false);
  });

  it("reports the API's error", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ success: false, errors: [{ message: "bad token" }] }), { status: 403 });
    await assert.rejects(upload(rows, { accountId: "a", token: "t", index: "i", fetchImpl }), /403: bad token/);
  });
});
