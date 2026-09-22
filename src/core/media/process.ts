import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp, { type Sharp } from "sharp";

const run = promisify(execFile);
const TOOL_TIMEOUT_MS = 5 * 60_000;

/** A file the worker produced, ready to store. */
export interface Rendition {
  body: Buffer;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  checksum: string;
}

/** Rejected media: the message is shown to the user as the failure reason. */
export class UnsupportedMediaError extends Error {}

export const sha256Hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function rendition(img: Sharp, mimeType: string): Promise<Rendition> {
  const { data, info } = await img.toBuffer({ resolveWithObject: true });
  return { body: data, mimeType, width: info.width, height: info.height, sizeBytes: data.length, checksum: sha256Hex(data) };
}

/** Grid/list thumbnail: fits in 480×480, WebP (keeps PNG transparency, small on mobile). */
export const THUMB_BOX = 480;
export function thumbnail(input: string | Buffer): Promise<Rendition> {
  return rendition(sharp(input, { failOn: "error" }).rotate().resize(THUMB_BOX, THUMB_BOX, { fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }), "image/webp");
}

/** Reads real dimensions; throws for files that are not decodable JPG/PNG images. */
export async function probeImage(file: string): Promise<{ width: number; height: number; format: string }> {
  try {
    const m = await sharp(file, { failOn: "error" }).metadata();
    if (!m.width || !m.height || !m.format) throw new Error("no dimensions");
    // EXIF orientations 5-8 are rotated by 90°, so the displayed size is transposed.
    const turned = (m.orientation ?? 1) >= 5;
    return { width: turned ? m.height : m.width, height: turned ? m.width : m.height, format: m.format };
  } catch {
    throw new UnsupportedMediaError("The file is not a readable JPG or PNG image.");
  }
}

/** Codecs every supported Android player decodes in hardware (spec 6.1). */
export const SUPPORTED_VIDEO = { codecs: ["h264"], pixelFormats: ["yuv420p", "yuvj420p"], maxWidth: 3840, maxHeight: 2160 };

export interface VideoInfo {
  codec: string;
  width: number;
  height: number;
  durationSec: number;
}

/** ffprobe the file and enforce the player codec profile, with a message the user can act on. */
export async function probeVideo(file: string): Promise<VideoInfo> {
  let json: { streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; pix_fmt?: string; duration?: string }[]; format?: { duration?: string } };
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], { timeout: TOOL_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });
    json = JSON.parse(stdout);
  } catch {
    throw new UnsupportedMediaError("The file is not a readable MP4 video.");
  }
  const v = json.streams?.find((s) => s.codec_type === "video");
  if (!v?.codec_name || !v.width || !v.height) throw new UnsupportedMediaError("The MP4 file has no video track.");
  const fix = "Export it as MP4 with H.264 video (8-bit, up to 3840×2160) and try again.";
  if (!SUPPORTED_VIDEO.codecs.includes(v.codec_name)) throw new UnsupportedMediaError(`Unsupported video codec ${v.codec_name.toUpperCase()}. ${fix}`);
  if (v.pix_fmt && !SUPPORTED_VIDEO.pixelFormats.includes(v.pix_fmt)) throw new UnsupportedMediaError(`Unsupported pixel format ${v.pix_fmt} (players need 8-bit 4:2:0). ${fix}`);
  if (v.width > SUPPORTED_VIDEO.maxWidth || v.height > SUPPORTED_VIDEO.maxHeight) throw new UnsupportedMediaError(`The video is ${v.width}×${v.height}, above the 3840×2160 limit. ${fix}`);
  const durationSec = Number(v.duration ?? json.format?.duration ?? 0);
  if (!(durationSec > 0)) throw new UnsupportedMediaError("Could not read the video's duration.");
  return { codec: v.codec_name, width: v.width, height: v.height, durationSec };
}

/** One frame (JPEG) from the video, for its thumbnail. */
export async function videoFrame(file: string, atSec: number): Promise<Buffer> {
  const { stdout } = await run("ffmpeg", ["-v", "error", "-ss", atSec.toFixed(2), "-i", file, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"], { encoding: "buffer", timeout: TOOL_TIMEOUT_MS, maxBuffer: 50 * 1024 * 1024 });
  if (!stdout.length) throw new UnsupportedMediaError("Could not read a frame from the video.");
  return stdout;
}

/** PDFs longer than this are rejected rather than rasterised. */
export const MAX_PDF_PAGES = 200;
/** Pages are rendered to fit a 1920×1920 box, i.e. full HD on either orientation. */
export const PDF_PAGE_BOX = 1920;

/** Renders every page to PNG (poppler), returning them in page order. */
export async function rasterisePdf(file: string, outDir: string): Promise<Rendition[]> {
  let pages: number;
  try {
    const { stdout } = await run("pdfinfo", [file], { timeout: TOOL_TIMEOUT_MS });
    if (/^Encrypted:\s+yes/m.test(stdout)) throw new UnsupportedMediaError("The PDF is password-protected. Remove the password and upload it again.");
    pages = Number(/^Pages:\s+(\d+)/m.exec(stdout)?.[1] ?? 0);
  } catch (err) {
    if (err instanceof UnsupportedMediaError) throw err;
    throw new UnsupportedMediaError("The file is not a readable PDF.");
  }
  if (!pages) throw new UnsupportedMediaError("The PDF has no pages.");
  if (pages > MAX_PDF_PAGES) throw new UnsupportedMediaError(`The PDF has ${pages} pages; the limit is ${MAX_PDF_PAGES}.`);
  const prefix = join(outDir, "page");
  await run("pdftoppm", ["-png", "-scale-to", String(PDF_PAGE_BOX), file, prefix], { timeout: TOOL_TIMEOUT_MS });
  // pdftoppm zero-pads the page number to the width of the page count (page-01.png …).
  const names = (await readdir(outDir)).filter((n) => /^page-\d+\.png$/.test(n)).sort((a, b) => Number(a.slice(5, -4)) - Number(b.slice(5, -4)));
  if (names.length !== pages) throw new UnsupportedMediaError("Some pages of the PDF could not be rendered.");
  return Promise.all(
    names.map(async (n) => {
      const body = await readFile(join(outDir, n));
      const { width = 0, height = 0 } = await sharp(body).metadata();
      return { body, mimeType: "image/png", width, height, sizeBytes: body.length, checksum: sha256Hex(body) };
    }),
  );
}
