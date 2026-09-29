import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { prepareVisualAttachment } from "../src/attachments.mjs";

const exec = promisify(execFile);

// Distinct page colors let the regression test verify the actual rendered page.
function samplePdf(colors) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${colors.map((_, index) => `${3 + index * 2} 0 R`).join(" ")}] /Count ${colors.length} >>`,
  ];
  for (const color of colors) {
    const content = `${color} rg\n0 0 120 120 re f\n`;
    const contentNumber = objects.length + 2;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 120 120] /Resources << >> /Contents ${contentNumber} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function temporaryDirectory(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pdf-last-page-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("multi-page PDF recognition renders its last page and preserves the complete original", async t => {
  const dir = await temporaryDirectory(t);
  const sourcePath = path.join(dir, "multi-page.pdf");
  const original = samplePdf(["1 0 0", "0 1 0", "0 0 1"]);
  await writeFile(sourcePath, original);
  const visual = await prepareVisualAttachment(sourcePath, path.join(dir, "runtime"));
  assert.equal(visual.sourceType, "pdf");
  assert.equal(visual.pageCount, 3);
  assert.equal(visual.pageNumber, 3);
  assert.equal(visual.originalPath, sourcePath);
  assert.deepEqual(await readFile(sourcePath), original);

  const reference = path.join(dir, "last-page-reference");
  await exec("pdftoppm", ["-f", "3", "-l", "3", "-singlefile", "-png", "-r", "180", sourcePath, reference]);
  assert.deepEqual(await readFile(visual.imagePath), await readFile(`${reference}.png`));
});

test("single-page PDF recognition still renders its sole page", async t => {
  const dir = await temporaryDirectory(t);
  const sourcePath = path.join(dir, "single-page.pdf");
  await writeFile(sourcePath, samplePdf(["0 0 1"]));
  const visual = await prepareVisualAttachment(sourcePath, path.join(dir, "runtime"));
  assert.equal(visual.pageCount, 1);
  assert.equal(visual.pageNumber, 1);
  assert.deepEqual((await readFile(visual.imagePath)).subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
});

test("image attachments keep their original path without PDF processing", async t => {
  const dir = await temporaryDirectory(t);
  const imagePath = path.join(dir, "image.jpg");
  await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  assert.deepEqual(await prepareVisualAttachment(imagePath, dir), {
    originalPath: imagePath, imagePath, sourceType: "image",
  });
});

test("invalid PDF reports metadata failure instead of silently rendering the first page", async t => {
  const dir = await temporaryDirectory(t);
  const filePath = path.join(dir, "invalid.pdf");
  await writeFile(filePath, "%PDF-1.4\ninvalid");
  await assert.rejects(prepareVisualAttachment(filePath, dir), /pdfinfo exited/);
});
