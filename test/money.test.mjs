import test from "node:test";
import assert from "node:assert/strict";

import { moneyToCents } from "../src/invoice/money.mjs";

test("moneyToCents normalizes decimal amounts without direct float equality", () => {
  assert.equal(moneyToCents("128.60"), 12860);
  assert.equal(moneyToCents("￥1,234.56"), 123456);
  assert.equal(moneyToCents(1.005), 101);
  assert.equal(moneyToCents(""), null);
  assert.equal(moneyToCents("invalid"), null);
});
