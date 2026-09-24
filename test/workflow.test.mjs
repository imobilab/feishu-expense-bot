import test from "node:test";
import assert from "node:assert/strict";

import { STAGES } from "../src/actions.mjs";
import {
  bindConfirmedInvoice, confirmedInvoiceFromForm, createOrderAndBind,
  DuplicateInvoiceError, matchConfirmedInvoice,
} from "../src/invoice/workflow.mjs";

const draft = {
  invoice_number: "MODEL-WRONG", invoice_date: "2026-01-01", buyer_name: "draft buyer",
  buyer_tax_id: "", seller_name: "draft seller", seller_tax_id: "", amount_without_tax: 10,
  tax_amount: 1, total_amount: 11, items: [{ name: "USB Hub", amount: 11 }],
};

test("confirmed invoice uses edited form values and only retains draft items", () => {
  const confirmed = confirmedInvoiceFromForm({
    invoice_number: "EDITED-1", invoice_date: "2026-09-23", buyer_name: "edited buyer",
    buyer_tax_id: "B", seller_name: "edited seller", seller_tax_id: "S",
    amount_without_tax: "100.00", tax_amount: "13", total_amount: "113.00",
  }, draft);
  assert.equal(confirmed.invoice_number, "EDITED-1");
  assert.equal(confirmed.total_amount, 113);
  assert.deepEqual(confirmed.items, draft.items);
});

test("matching handles duplicate before considering amount candidates", async () => {
  let lookups = 0;
  const repository = {
    findDuplicateAndAmountCandidates: async () => {
      lookups += 1;
      return { duplicate: { recordId: "dup" }, candidates: [] };
    },
  };
  assert.equal((await matchConfirmedInvoice(repository, draft)).type, "duplicate");
  assert.equal(lookups, 1);
});

test("matching distinguishes zero, one and multiple exact amount candidates", async () => {
  for (const [count, expected] of [[0, "none"], [1, "single"], [3, "multiple"]]) {
    const repository = {
      findDuplicateAndAmountCandidates: async () => ({
        duplicate: null,
        candidates: Array.from({ length: count }, (_, index) => ({ recordId: `r${index}` })),
      }),
    };
    assert.equal((await matchConfirmedInvoice(repository, draft)).type, expected);
  }
});

test("binding appends once and repeated finished action is idempotent", async () => {
  const calls = { upload: 0, append: 0, duplicate: 0 };
  const repository = {
    findDuplicate: async () => { calls.duplicate += 1; return null; },
    uploadInvoice: async () => { calls.upload += 1; },
    appendInvoiceNumber: async () => { calls.append += 1; },
  };
  const workflow = { stage: STAGES.INVOICE_MATCHING, confirmedInvoice: draft, originalPath: "/tmp/a.pdf" };
  await bindConfirmedInvoice({ repository, workflow, recordId: "r1" });
  await bindConfirmedInvoice({ repository, workflow, recordId: "r1" });
  assert.equal(workflow.stage, STAGES.FINISHED);
  assert.deepEqual(calls, { upload: 1, append: 1, duplicate: 2 });
});

test("invoice binding uploads the confirmed invoice's named copy", async () => {
  let uploadedPath;
  const repository = {
    findDuplicate: async () => null,
    uploadInvoice: async (_recordId, filePath) => { uploadedPath = filePath; },
    appendInvoiceNumber: async () => {},
  };
  const workflow = {
    stage: STAGES.INVOICE_MATCHING, confirmedInvoice: draft,
    originalPath: "/app/runtime/uploads/original.pdf",
    invoiceUploadPath: "/app/runtime/named/om_test/0/11.00-游子越-USB Hub.pdf",
  };
  await bindConfirmedInvoice({ repository, workflow, recordId: "r1" });
  assert.equal(uploadedPath, workflow.invoiceUploadPath);
});

test("final duplicate check prevents invoice number write", async () => {
  let duplicateCall = 0;
  let append = 0;
  const repository = {
    findDuplicate: async () => (++duplicateCall === 2 ? { recordId: "other" } : null),
    uploadInvoice: async () => {},
    appendInvoiceNumber: async () => { append += 1; },
  };
  const workflow = { stage: STAGES.INVOICE_MATCHING, confirmedInvoice: draft, originalPath: "/tmp/a.pdf" };
  await assert.rejects(bindConfirmedInvoice({ repository, workflow, recordId: "r1" }), DuplicateInvoiceError);
  assert.equal(append, 0);
});

test("no-match creation creates one order then binds it once", async () => {
  const calls = { create: 0, upload: 0, append: 0 };
  const repository = {
    findDuplicate: async () => null,
    createOrder: async () => { calls.create += 1; return "new-record"; },
    uploadInvoice: async () => { calls.upload += 1; },
    appendInvoiceNumber: async () => { calls.append += 1; },
  };
  const workflow = { stage: STAGES.INVOICE_NO_MATCH, confirmedInvoice: draft, originalPath: "/tmp/a.pdf" };
  await createOrderAndBind({ repository, workflow });
  await createOrderAndBind({ repository, workflow });
  assert.equal(workflow.createdOrderId, "new-record");
  assert.deepEqual(calls, { create: 1, upload: 1, append: 1 });
});
