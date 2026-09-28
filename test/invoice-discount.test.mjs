import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { recognizeDocument } from "../src/recognition/index.mjs";
import { invoiceSchema, orderSchema } from "../src/recognition/schemas.mjs";
import { callVisionModel } from "../src/providers/qwen.mjs";
import { confirmedInvoiceFromForm, matchConfirmedInvoice } from "../src/invoice/workflow.mjs";

// Regression fixture for the receipt that failed because of two discount rows.
const invoice = {
  invoice_number: "DISCOUNT-1", invoice_date: "2026-09-22",
  buyer_name: "buyer", buyer_tax_id: "", seller_name: "seller", seller_tax_id: "",
  amount_without_tax: 6.02, tax_amount: 0.78, total_amount: 6.8,
  items: [
    { name: "双面带胶导电布", amount: 4.69 },
    { name: "双面带胶导电布折扣", amount: -0.60 },
    { name: "单面导电布", amount: 2.21 },
    { name: "单面导电布折扣", amount: -0.28 },
  ],
};

async function sampleImage(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "invoice-discount-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const imagePath = path.join(dir, "sample.jpg");
  await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  return imagePath;
}

test("invoice recognition preserves both negative discount rows without retry", async t => {
  const imagePath = await sampleImage(t);
  const contents = [{ document_type: "invoice" }, invoice];
  const requests = [];
  const client = { chat: { completions: { create: async request => {
    requests.push(request);
    return { choices: [{ message: { content: JSON.stringify(contents[requests.length - 1]) } }] };
  } } } };
  const result = await recognizeDocument(imagePath, { client, retries: 1 });
  assert.equal(requests.length, 2);
  assert.deepEqual(result.invoice, invoice);
});

test("invoice confirmation retains discounts and matches the final total without subtracting again", async () => {
  const confirmed = confirmedInvoiceFromForm({
    ...invoice, amount_without_tax: "6.02", tax_amount: "0.78", total_amount: "6.80",
  }, invoice);
  assert.deepEqual(confirmed.items, invoice.items);
  const repository = {
    findDuplicateAndAmountCandidates: async (number, total) => {
      assert.equal(number, invoice.invoice_number);
      assert.equal(total, 6.8);
      return { duplicate: null, candidates: [{ recordId: "discount-order" }] };
    },
  };
  const decision = await matchConfirmedInvoice(repository, confirmed);
  assert.equal(decision.type, "single");
  assert.equal(decision.candidate.recordId, "discount-order");
});

test("negative invoice summaries and negative order prices remain invalid", () => {
  for (const field of ["amount_without_tax", "tax_amount", "total_amount"]) {
    const result = invoiceSchema.safeParse({ ...invoice, [field]: -1 });
    assert.equal(result.success, false, field);
    assert.deepEqual(result.error.issues[0].path, [field]);
    assert.equal(result.error.issues[0].message, "金额必须大于等于 0");
  }
  assert.equal(orderSchema.safeParse({
    product: "order", price: -1, expense_date: "", payment_method: "",
  }).success, false);
  assert.throws(() => confirmedInvoiceFromForm({
    ...invoice, total_amount: "-6.80",
  }, invoice), /total_amount/);
});

test("vision validation errors include nested field paths and returned numeric values", async t => {
  const imagePath = await sampleImage(t);
  const invalid = {
    ...invoice, total_amount: -6.8,
    items: [invoice.items[0], { name: "折扣", amount: "invalid" }],
  };
  const client = { chat: { completions: { create: async () => ({
    choices: [{ message: { content: JSON.stringify(invalid) } }],
  }) } } };
  await assert.rejects(callVisionModel({
    imagePath, systemPrompt: "test", schema: invoiceSchema, client, retries: 0,
  }), error => {
    assert.match(error.message, /total_amount（返回值：-6\.8）：金额必须大于等于 0/);
    assert.match(error.message, /items\[1\]\.amount/);
    assert.doesNotMatch(error.message, /buyer_name|seller_name|DISCOUNT-1/);
    return true;
  });
});
