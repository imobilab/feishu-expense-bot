import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { prepareNamedAttachment } from "../src/attachment-name.mjs";

test("confirmed order amount, submitter and product become the uploaded image filename", async t => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "named-attachment-"));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const sourcePath = path.join(runtimeDir, "source-without-extension");
  const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  await writeFile(sourcePath, image);

  const named = await prepareNamedAttachment({
    sourcePath, runtimeDir, messageId: "om_order", amount: 15.87,
    submitterName: "游子越", projectName: "PETG 香芋紫 1kg",
  });
  assert.equal(path.basename(named), "15.87-游子越-PETG 香芋紫 1kg.jpg");
  assert.deepEqual(await readFile(named), image);
  assert.deepEqual(await readFile(sourcePath), image);
});

test("invoice PDF keeps its extension and same-name uploads remain isolated", async t => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "named-attachment-"));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const sourcePath = path.join(runtimeDir, "downloaded-file");
  await writeFile(sourcePath, "%PDF-1.7\nexample");

  const options = {
    sourcePath, runtimeDir, amount: 403, submitterName: "游子越", projectName: "耗材/配件",
  };
  const first = await prepareNamedAttachment({ ...options, messageId: "om_first" });
  const second = await prepareNamedAttachment({ ...options, messageId: "om_second" });
  assert.equal(path.basename(first), "403.00-游子越-耗材_配件.pdf");
  assert.equal(path.basename(second), path.basename(first));
  assert.notEqual(first, second);
  assert.match(first, /\/named\/om_first\/0\//);
  assert.match(second, /\/named\/om_second\/0\//);
});
