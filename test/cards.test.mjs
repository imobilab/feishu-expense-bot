import test from "node:test";
import assert from "node:assert/strict";

import { candidateCard, invoiceReviewCard } from "../src/invoice/cards.mjs";
import { orderReviewCard } from "../src/order/cards.mjs";

function walk(value, visit) {
  if (!value || typeof value !== "object") return;
  visit(value);
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach(item => walk(item, visit));
    else walk(child, visit);
  }
}

test("date pickers do not contain unsupported label property", () => {
  const cards = [
    orderReviewCard({ order: {}, today: "2026-09-23" }),
    invoiceReviewCard({ invoice_number: "", invoice_date: "", items: [] }),
  ];
  for (const card of cards) walk(card, node => {
    if (node.tag === "date_picker") assert.equal("label" in node, false);
  });
});

test("invoice review exposes every confirmed scalar field as form data", () => {
  const card = invoiceReviewCard({ invoice_number: "A", invoice_date: "2026-09-23", items: [] });
  const names = [];
  walk(card, node => { if (node.name) names.push(node.name); });
  for (const name of [
    "invoice_number", "invoice_date", "buyer_name", "buyer_tax_id", "seller_name",
    "seller_tax_id", "amount_without_tax", "tax_amount", "total_amount",
  ]) assert.ok(names.includes(name), `${name} should be editable`);
});

test("multiple candidates require explicit record selection", () => {
  const card = candidateCard({ total_amount: 58 }, [
    { recordId: "r1", fields: { "商品名称": "A", "价格": 58, "消费日期": "2026-09-20" } },
    { recordId: "r2", fields: { "商品名称": "B", "价格": 58, "消费日期": "2026-09-21" } },
  ]);
  let select;
  walk(card, node => { if (node.name === "selected_order") select = node; });
  assert.equal(select.required, true);
  assert.deepEqual(select.options.map(option => option.value), ["r1", "r2"]);
});
