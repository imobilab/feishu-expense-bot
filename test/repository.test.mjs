import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { createInvoiceRepository } from "../src/invoice/repository.mjs";

function listResponse(fields, rows, ids = rows.map((_, index) => `r${index + 1}`)) {
  return { fields, data: rows, record_id_list: ids, has_more: false };
}

test("repository duplicate lookup is exact and amount matching uses cents only", async () => {
  const runJson = async args => {
    const requested = args.filter((value, index) => args[index - 1] === "--field-id");
    if (requested.includes("发票号码")) {
      return listResponse(["发票号码"], [["INV-10\nINV-11"], ["INV-110"]], ["a", "b"]);
    }
    return listResponse(
      ["商品名称", "价格", "消费日期", "支付方式"],
      [["A", "128.60", "2026-09-20", "微信支付"], ["B", 128.61, "2026-09-21", "支付宝"]],
      ["a", "b"],
    );
  };
  const repository = createInvoiceRepository({ runJson, baseToken: "base", tableId: "table" });
  assert.equal((await repository.findDuplicate("INV-11")).recordId, "a");
  assert.equal(await repository.findDuplicate("INV-1"), null);
  assert.deepEqual((await repository.findAmountCandidates(128.6)).map(row => row.recordId), ["a"]);
});

test("JSON record queries use supported page size and advance by returned rows", async () => {
  const requests = [];
  const runJson = async args => {
    requests.push(args);
    const offset = Number(args[args.indexOf("--offset") + 1]);
    if (offset === 0) return { ...listResponse(["发票号码"], [["OLD-1"], ["OLD-2"]], ["r1", "r2"]), has_more: true };
    return listResponse(["发票号码"], [["TARGET-3"]], ["r3"]);
  };
  const repository = createInvoiceRepository({ runJson, baseToken: "base", tableId: "table" });
  assert.equal((await repository.findDuplicate("TARGET-3")).recordId, "r3");
  assert.deepEqual(requests.map(args => args[args.indexOf("--limit") + 1]), ["200", "200"]);
  assert.deepEqual(requests.map(args => args[args.indexOf("--offset") + 1]), ["0", "2"]);
});

test("initial invoice decision reads the table once and checks duplicate before amount", async () => {
  let reads = 0;
  const runJson = async args => {
    reads += 1;
    assert.ok(args.includes("发票号码"));
    assert.ok(args.includes("价格"));
    return listResponse(
      ["发票号码", "商品名称", "价格", "消费日期", "支付方式"],
      [["INV-1", "A", 20, "2026-09-23", "微信支付"]],
      ["r1"],
    );
  };
  const repository = createInvoiceRepository({ runJson, baseToken: "base", tableId: "table" });
  assert.equal((await repository.findDuplicateAndAmountCandidates("INV-1", 20)).duplicate.recordId, "r1");
  assert.equal(reads, 1);
  const unique = await repository.findDuplicateAndAmountCandidates("INV-2", 20);
  assert.equal(unique.duplicate, null);
  assert.deepEqual(unique.candidates.map(record => record.recordId), ["r1"]);
  assert.equal(reads, 2);
});

test("appendInvoiceNumber preserves existing numbers", async () => {
  const calls = [];
  const runJson = async args => {
    calls.push(args);
    if (args.includes("+record-get")) return listResponse(["发票号码"], [["OLD-1"]], ["r1"]);
    return {};
  };
  const repository = createInvoiceRepository({ runJson, baseToken: "base", tableId: "table" });
  await repository.appendInvoiceNumber("r1", "NEW-2");
  const update = calls.find(args => args.includes("+record-batch-update"));
  const payload = JSON.parse(update[update.indexOf("--json") + 1]);
  assert.equal(payload.update_records.r1["发票号码"], "OLD-1\nNEW-2");
});

test("attachment binding uses upload command so existing attachments are appended by Feishu CLI", async () => {
  let command;
  const repository = createInvoiceRepository({
    runJson: async args => { command = args; return {}; }, baseToken: "base", tableId: "table",
  });
  await repository.uploadInvoice("r1", path.join(process.cwd(), "runtime", "invoice.pdf"));
  assert.ok(command.includes("+record-upload-attachment"));
  assert.equal(command[command.indexOf("--record-id") + 1], "r1");
  assert.equal(command[command.indexOf("--file") + 1], "./runtime/invoice.pdf");
});

test("attachment upload rejects files outside the project directory", async () => {
  const repository = createInvoiceRepository({ runJson: async () => {}, baseToken: "base", tableId: "table" });
  await assert.rejects(repository.uploadInvoice("r1", "/tmp/invoice.pdf"), /必须位于机器人项目目录内/);
});
