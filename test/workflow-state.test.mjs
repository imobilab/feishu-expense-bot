import test from "node:test";
import assert from "node:assert/strict";

import { STAGES } from "../src/actions.mjs";
import { bindConfirmedInvoice } from "../src/invoice/workflow.mjs";
import { addWorkflow, linkCard, normalizeState, workflowForCard } from "../src/workflow-state.mjs";

test("two attachments from one sender keep separate drafts and card actions", () => {
  const state = normalizeState();
  const first = { id: "source-1", messageId: "source-1", senderId: "same-user", invoiceDraft: { invoice_number: "A" }, confirmedInvoice: null };
  const second = { id: "source-2", messageId: "source-2", senderId: "same-user", invoiceDraft: { invoice_number: "B" }, confirmedInvoice: null };
  addWorkflow(state, first);
  linkCard(state, "card-1", first);
  addWorkflow(state, second);
  linkCard(state, "card-2", second);

  const firstAction = workflowForCard(state, { message_id: "card-1", operator_id: "same-user" });
  const secondAction = workflowForCard(state, { message_id: "card-2", operator_id: "same-user" });
  assert.equal(firstAction, first);
  assert.equal(secondAction, second);
  firstAction.confirmedInvoice = { invoice_number: "A" };
  assert.equal(secondAction.confirmedInvoice, null);
  assert.equal(Object.keys(state.pending).length, 2);
});

test("old sender-based card mappings expire instead of using another attachment", () => {
  const workflow = { id: "source-2", messageId: "source-2", senderId: "same-user" };
  const state = normalizeState({
    pending: { "same-user": workflow },
    cards: { "old-card-1": "same-user", "old-card-2": "same-user" },
  });
  assert.equal(state.pending["source-2"], workflow);
  assert.deepEqual(state.cards, {});
  assert.equal(workflowForCard(state, { message_id: "old-card-1", operator_id: "same-user" }), null);
});

test("card actions cannot resolve another sender's workflow", () => {
  const state = normalizeState();
  const workflow = { id: "source-1", messageId: "source-1", senderId: "owner" };
  addWorkflow(state, workflow);
  linkCard(state, "card-1", workflow);
  assert.equal(workflowForCard(state, { message_id: "card-1", operator_id: "other-user" }), null);
});

test("a second invoice arriving during binding cannot clear the first confirmation", async () => {
  const state = normalizeState();
  const first = {
    id: "source-1", messageId: "source-1", senderId: "same-user",
    stage: STAGES.INVOICE_MATCHING, originalPath: "/tmp/first.pdf",
    confirmedInvoice: { invoice_number: "INV-A" },
  };
  addWorkflow(state, first);

  let releaseUpload;
  let signalUpload;
  const uploading = new Promise(resolve => { signalUpload = resolve; });
  const holdUpload = new Promise(resolve => { releaseUpload = resolve; });
  const writes = [];
  const repository = {
    findDuplicate: async () => null,
    uploadInvoice: async () => { signalUpload(); await holdUpload; },
    appendInvoiceNumber: async (recordId, number) => { writes.push([recordId, number]); },
  };

  const binding = bindConfirmedInvoice({ repository, workflow: first, recordId: "order-a" });
  await uploading;
  const second = {
    id: "source-2", messageId: "source-2", senderId: "same-user",
    stage: STAGES.INVOICE_REVIEW, confirmedInvoice: null,
  };
  addWorkflow(state, second);
  second.confirmedInvoice = null;
  releaseUpload();
  await binding;

  assert.equal(first.confirmedInvoice.invoice_number, "INV-A");
  assert.equal(first.stage, STAGES.FINISHED);
  assert.deepEqual(writes, [["order-a", "INV-A"]]);
});
