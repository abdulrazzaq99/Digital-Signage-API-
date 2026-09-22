import sharp, { type OverlayOptions } from "sharp";
import type { TemplateField } from "./templates.schemas.js";
import { sha256Hex, type Rendition } from "../../core/media/process.js";

export const TEMPLATE_SIZE = { LANDSCAPE: [1920, 1080], PORTRAIT: [1080, 1920] } as const;

type Box = { x: number; y: number; w: number; h: number };

const FONT = "DejaVu Sans, Inter, Arial, Helvetica, sans-serif";
const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Greedy word wrap using an average glyph width; shrinks the font until the text fits the box. */
function fitText(text: string, box: Box, W: number, H: number, sizePx: number, maxLines: number): { lines: string[]; size: number } {
  const width = box.w * W;
  for (let size = sizePx; ; size *= 0.9) {
    const perLine = Math.max(1, Math.floor(width / (size * 0.56)));
    const lines: string[] = [];
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const last = lines[lines.length - 1];
      if (last !== undefined && (last + " " + word).length <= perLine) lines[lines.length - 1] = `${last} ${word}`;
      else lines.push(word.length > perLine ? `${word.slice(0, perLine - 1)}…` : word);
    }
    const fits = lines.length <= maxLines && lines.length * size * 1.2 <= box.h * H;
    if (fits || size < H * 0.02) return { lines: lines.slice(0, maxLines), size };
  }
}

/** Default placement for fields the designer didn't position: text column plus an image panel. */
function autoLayout(fields: TemplateField[], values: Record<string, string>, landscape: boolean): Map<string, Box> {
  const boxes = new Map<string, Box>();
  const images = fields.filter((f) => f.type === "image" && !f.box && values[f.key]);
  const texts = fields.filter((f) => f.type === "text" && !f.box && values[f.key]?.trim());
  const imageArea: Box = landscape ? { x: 0.56, y: 0.1, w: 0.38, h: 0.8 } : { x: 0.08, y: 0.06, w: 0.84, h: 0.4 };
  images.forEach((f, i) => {
    const n = images.length;
    boxes.set(f.key, landscape ? { ...imageArea, y: imageArea.y + (imageArea.h / n) * i, h: imageArea.h / n - 0.02 } : { ...imageArea, x: imageArea.x + (imageArea.w / n) * i, w: imageArea.w / n - 0.02 });
  });
  const textArea: Box = images.length ? (landscape ? { x: 0.06, y: 0.12, w: 0.46, h: 0.76 } : { x: 0.08, y: 0.5, w: 0.84, h: 0.44 }) : { x: 0.08, y: 0.12, w: 0.84, h: 0.76 };
  // First text field is the headline; it gets the most room.
  const weights = texts.map((_, i) => (i === 0 ? 2.2 : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  let y = textArea.y;
  texts.forEach((f, i) => {
    const h = (textArea.h * weights[i]!) / total;
    boxes.set(f.key, { x: textArea.x, y, w: textArea.w, h });
    y += h;
  });
  return boxes;
}

/**
 * Renders a template instance to a PNG at the template's target resolution (spec 10.1): a
 * background in the first colour field's accent, text fields wrapped into their boxes, and image
 * fields (media library images) scaled into theirs.
 */
export async function renderTemplate(input: { orientation: "LANDSCAPE" | "PORTRAIT"; fields: TemplateField[]; values: Record<string, string>; images: Map<string, Buffer> }): Promise<Rendition> {
  const [W, H] = TEMPLATE_SIZE[input.orientation];
  const landscape = input.orientation === "LANDSCAPE";
  const { fields, values } = input;
  const accent = fields.find((f) => f.type === "color" && /^#[0-9a-fA-F]{6}$/.test(values[f.key] ?? ""));
  const accentHex = accent ? values[accent.key]! : "#1e3a8a";
  const auto = autoLayout(fields, values, landscape);
  const boxOf = (f: TemplateField) => f.box ?? auto.get(f.key);

  const texts: string[] = [];
  const firstText = fields.find((f) => f.type === "text")?.key;
  for (const f of fields.filter((x) => x.type === "text")) {
    const text = values[f.key]?.trim();
    const box = boxOf(f);
    if (!text || !box) continue;
    const headline = f.key === firstText;
    const { lines, size } = fitText(text, box, W, H, (f.fontSize ?? (headline ? 0.09 : 0.05)) * H, headline ? 3 : 2);
    const align = f.align ?? "left";
    const anchor = align === "center" ? "middle" : align === "right" ? "end" : "start";
    const x = (align === "center" ? box.x + box.w / 2 : align === "right" ? box.x + box.w : box.x) * W;
    const top = box.y * H + Math.max(0, (box.h * H - lines.length * size * 1.2) / 2);
    const weight = (f.weight ?? (headline ? "bold" : "regular")) === "bold" ? 700 : 400;
    const color = f.color ?? (headline ? "#ffffff" : "#e2e8f0");
    lines.forEach((line, i) => texts.push(`<text x="${x.toFixed(1)}" y="${(top + size * (i + 1) * 1.2 - size * 0.25).toFixed(1)}" font-family="${FONT}" font-size="${size.toFixed(1)}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${esc(line)}</text>`));
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f172a"/><stop offset="1" stop-color="${accentHex}"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#bg)"/>${texts.join("")}</svg>`;

  const overlays: OverlayOptions[] = [];
  for (const f of fields.filter((x) => x.type === "image")) {
    const bytes = input.images.get(f.key);
    const box = boxOf(f);
    if (!bytes || !box) continue;
    const w = Math.round(box.w * W);
    const h = Math.round(box.h * H);
    const fit = f.fit ?? "cover";
    const img = await sharp(bytes).rotate().resize(w, h, { fit, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer({ resolveWithObject: true });
    // `contain` may come out smaller than the box; centre it.
    overlays.push({ input: img.data, left: Math.round(box.x * W + (w - img.info.width) / 2), top: Math.round(box.y * H + (h - img.info.height) / 2) });
  }

  const body = await sharp(Buffer.from(svg)).composite(overlays).png().toBuffer();
  return { body, mimeType: "image/png", width: W, height: H, sizeBytes: body.length, checksum: sha256Hex(body) };
}
