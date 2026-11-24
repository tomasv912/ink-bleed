// Builds the input artwork canvas (black ink on white) at output resolution.

const imageCache = new Map<string, Promise<HTMLImageElement>>();

export function loadImage(url: string): Promise<HTMLImageElement> {
  let p = imageCache.get(url);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Could not load image`));
      img.src = url;
    });
    imageCache.set(url, p);
  }
  return p;
}

export const FONTS: Record<string, string> = {
  Blackletter: "UnifrakturCook",
  Fraktur: "UnifrakturMaguntia",
  Gotisch: "Grenze Gotisch",
  Pirata: "Pirata One",
  Serif: "Playfair Display",
  Grotesk: "Inter",
  Condensed: "Anton",
};

const FONT_WEIGHT: Record<string, string> = {
  UnifrakturCook: "700",
  "Grenze Gotisch": "900",
  "Playfair Display": "900",
  Inter: "900",
};

export interface TextSource {
  kind: "text";
  text: string;
  font: string;
  lineHeight: number;
  tracking: number;
  padding: number;
}

export interface ImageSource {
  kind: "image";
  image: HTMLImageElement;
  padding: number;
}

export async function ensureFont(family: string) {
  const weight = FONT_WEIGHT[family] ?? "400";
  try {
    await document.fonts.load(`${weight} 100px "${family}"`, "ABCabc");
  } catch {
    /* fall back to whatever is available */
  }
}

export function drawSource(
  canvas: HTMLCanvasElement,
  w: number,
  h: number,
  src: TextSource | ImageSource,
) {
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);

  const pad = Math.min(w, h) * src.padding;
  const boxW = w - pad * 2;
  const boxH = h - pad * 2;

  if (src.kind === "image") {
    const iw = src.image.naturalWidth;
    const ih = src.image.naturalHeight;
    const s = Math.min(boxW / iw, boxH / ih);
    ctx.drawImage(src.image, (w - iw * s) / 2, (h - ih * s) / 2, iw * s, ih * s);
    return;
  }

  const lines = src.text
    .split(/\/|\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return;

  const weight = FONT_WEIGHT[src.font] ?? "400";
  const ref = 100;
  const setFont = (size: number) => {
    ctx.font = `${weight} ${size}px "${src.font}"`;
    ctx.letterSpacing = `${src.tracking * size}px`;
  };
  setFont(ref);
  const maxW = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const sizeByW = (boxW / maxW) * ref;
  const sizeByH = boxH / (lines.length * src.lineHeight);
  const size = Math.min(sizeByW, sizeByH);
  setFont(size);

  ctx.fillStyle = "#000";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lh = size * src.lineHeight;
  const total = lh * lines.length;
  const top = (h - total) / 2 + lh / 2;
  lines.forEach((line, i) => {
    // letterSpacing adds trailing space after the last glyph; recentre
    const shift = (src.tracking * size) / 2;
    ctx.fillText(line, w / 2 + shift, top + i * lh);
  });
}
