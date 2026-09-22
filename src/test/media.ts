import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const run = promisify(execFile);

/** A solid-colour PNG. */
export const pngBytes = (width = 64, height = 48, background = "#2563eb") => sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();

/** A valid PDF with `pages` Letter-size pages, each saying "Page N". */
export function pdfBytes(pages: number): Buffer {
  const objects: string[] = [];
  const pageIds = Array.from({ length: pages }, (_, i) => 4 + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pageIds.forEach((id, i) => {
    const stream = `BT /F1 64 Tf 72 680 Td (Page ${i + 1}) Tj ET`;
    objects[id] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${id + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    objects[id + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(out);
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}

/** A 2-second 320×240 MP4 from ffmpeg's test pattern, in the given video codec. */
export async function mp4Bytes(codec: "libx264" | "mpeg4" = "libx264"): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "dsp-test-"));
  try {
    const file = join(dir, "clip.mp4");
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10", "-pix_fmt", "yuv420p", "-c:v", codec, file]);
    return await readFile(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
