import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { recognizeDocument } from "../src/recognition/index.mjs";

async function sampleImage() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "recognition-"));
  const file = path.join(dir, "sample.jpg");
  await writeFile(file, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  return file;
}

function sequentialClient(contents) {
  let index = 0;
  return { chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify(contents[index++]) } }] }) } } };
}

test("vision route classifies then uses the order parser", async () => {
  const imagePath = await sampleImage();
  const client = sequentialClient([
    { document_type: "order" },
    { product: "耗材", price: 15.87, expense_date: "2026-09-23", payment_method: "支付宝" },
  ]);
  const result = await recognizeDocument(imagePath, { client, retries: 0 });
  assert.equal(result.documentType, "order");
  assert.equal(result.order.price, 15.87);
});

test("vision route classifies then uses the invoice parser", async () => {
  const imagePath = await sampleImage();
  const client = sequentialClient([
    { document_type: "invoice" },
    {
      invoice_number: "INV-1", invoice_date: "2026-09-23", buyer_name: "甲", buyer_tax_id: "B",
      seller_name: "乙", seller_tax_id: "S", amount_without_tax: 100, tax_amount: 13,
      total_amount: 113, items: [],
    },
  ]);
  const result = await recognizeDocument(imagePath, { client, retries: 0 });
  assert.equal(result.documentType, "invoice");
  assert.equal(result.invoice.invoice_number, "INV-1");
});

test("unknown classification does not invoke a parser", async () => {
  const imagePath = await sampleImage();
  let calls = 0;
  const client = { chat: { completions: { create: async () => {
    calls += 1;
    return { choices: [{ message: { content: "{\"document_type\":\"unknown\"}" } }] };
  } } } };
  const result = await recognizeDocument(imagePath, { client, retries: 0 });
  assert.equal(result.documentType, "unknown");
  assert.equal(calls, 1);
});
