import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr}`)));
  });
}

export async function detectAttachmentType(filePath) {
  const bytes = (await readFile(filePath)).subarray(0, 16);
  if (bytes.subarray(0, 4).toString("ascii") === "%PDF") return "pdf";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image";
  return "unknown";
}

export async function prepareVisualAttachment(filePath, runtimeDir) {
  const type = await detectAttachmentType(filePath);
  if (type === "image") return { originalPath: filePath, imagePath: filePath, sourceType: "image" };
  if (type !== "pdf") throw new Error("目前只支持图片和 PDF 文件");

  const previewDir = path.join(runtimeDir, "previews");
  await mkdir(previewDir, { recursive: true });
  const outputBase = path.join(previewDir, path.basename(filePath).replace(/[^A-Za-z0-9_-]/g, "_") + "-page");
  await run("pdftoppm", ["-f", "1", "-singlefile", "-png", "-r", "180", filePath, outputBase]);
  return { originalPath: filePath, imagePath: `${outputBase}.png`, sourceType: "pdf" };
}
