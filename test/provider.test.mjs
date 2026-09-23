import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";
import { callVisionModel, extractJson } from "../src/providers/qwen.mjs";

test("extractJson accepts fenced and surrounded JSON", () => {
  assert.deepEqual(extractJson("```json\n{\"ok\":true}\n```"), { ok: true });
  assert.deepEqual(extractJson("result: {\"ok\":true} done"), { ok: true });
});

test("vision provider retries, embeds MIME data URL, and validates schema", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vision-provider-"));
  const imagePath = path.join(dir, "sample.bin");
  await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const requests = [];
  const client = { chat: { completions: { create: async request => {
    requests.push(request);
    if (requests.length === 1) throw new Error("temporary timeout");
    return { choices: [{ message: { content: "{\"value\":42}" } }] };
  } } } };
  const result = await callVisionModel({
    imagePath,
    systemPrompt: "test",
    schema: z.object({ value: z.number() }).strict(),
    client,
    retries: 1,
  });
  assert.deepEqual(result.data, { value: 42 });
  assert.equal(requests.length, 2);
  assert.match(requests[1].messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/);
});

test("vision provider rejects invalid model JSON after retry", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vision-provider-"));
  const imagePath = path.join(dir, "sample.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const client = { chat: { completions: { create: async () => ({ choices: [{ message: { content: "{}" } }] }) } } };
  await assert.rejects(
    callVisionModel({ imagePath, systemPrompt: "test", schema: z.object({ value: z.number() }), client, retries: 1 }),
    /Schema 校验失败/,
  );
});
