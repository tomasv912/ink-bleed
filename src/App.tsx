import { useCallback, useEffect, useRef, useState } from "react";
import { DialRoot, useDialKitController } from "dialkit";
import { InkRenderer, type RenderParams } from "./renderer";
import { FONTS, drawSource, ensureFont, loadImage } from "./source";

const ASPECTS = ["4:5", "3:4", "2:3", "1:1", "16:9", "9:16", "match input"];
const VIEWS = ["result", "input", "paper", "ink field"];

const config = {
  input: {
    source: { type: "select" as const, options: ["text", "image"], default: "text" },
    text: { type: "text" as const, default: "THIS/TEXT/IS A/TEST", placeholder: "use / for line breaks" },
    font: { type: "select" as const, options: Object.keys(FONTS), default: "Blackletter" },
    lineHeight: [0.9, 0.6, 1.6, 0.01] as [number, number, number, number],
    tracking: [-0.02, -0.15, 0.3, 0.005] as [number, number, number, number],
    padding: [0.07, 0, 0.4, 0.005] as [number, number, number, number],
    artwork: { type: "image" as const },
    invert: false,
  },
  paper: {
    source: { type: "select" as const, options: ["procedural", "image", "flat"], default: "procedural" },
    color: "#eeebe1",
    texture: { type: "image" as const },
    scale: [1, 0.2, 4, 0.01] as [number, number, number, number],
    fibers: [0.45, 0, 1, 0.01] as [number, number, number, number],
    roughness: [0.7, 0, 1, 0.01] as [number, number, number, number],
    mottle: [0.4, 0, 1, 0.01] as [number, number, number, number],
    dust: [0.35, 0, 1, 0.01] as [number, number, number, number],
    imageContrast: [1.6, 0, 6, 0.05] as [number, number, number, number],
    imageColor: [0.7, 0, 1, 0.01] as [number, number, number, number],
  },
  bleed: {
    core: [6, 0, 30, 0.1] as [number, number, number, number],
    halo: [14, 0, 100, 0.5] as [number, number, number, number],
    haloAmount: [0.4, 0, 1.5, 0.01] as [number, number, number, number],
    threshold: [0.46, 0, 1, 0.005] as [number, number, number, number],
    softness: [0.28, 0, 0.6, 0.005] as [number, number, number, number],
    paperInfluence: [0.65, 0, 1, 0.01] as [number, number, number, number],
    fiberPull: [1.5, 0, 12, 0.1] as [number, number, number, number],
    warp: [1.2, 0, 25, 0.1] as [number, number, number, number],
    warpScale: [7, 1, 80, 0.5] as [number, number, number, number],
    blotch: [0.45, 0, 1, 0.01] as [number, number, number, number],
    blotchScale: [70, 5, 400, 1] as [number, number, number, number],
  },
  grain: {
    amount: [0.55, 0, 2, 0.01] as [number, number, number, number],
    size: [1.2, 0.5, 8, 0.05] as [number, number, number, number],
    clump: [0.35, 0, 1, 0.01] as [number, number, number, number],
    paperTooth: [0.4, 0, 1, 0.01] as [number, number, number, number],
  },
  speckles: {
    amount: [0.06, 0, 1, 0.01] as [number, number, number, number],
    size: [0.7, 0.1, 4, 0.01] as [number, number, number, number],
    reach: [0.12, 0.01, 1, 0.01] as [number, number, number, number],
  },
  ink: {
    color: "#1b1a19",
    density: [1, 0, 1.2, 0.01] as [number, number, number, number],
    pooling: [0, 0, 2, 0.01] as [number, number, number, number],
  },
  output: {
    aspect: { type: "select" as const, options: ASPECTS, default: "4:5" },
    resolution: [2000, 500, 6000, 100] as [number, number, number, number],
    view: { type: "select" as const, options: VIEWS, default: "result" },
    transparent: false,
    seed: [7, 0, 999, 1] as [number, number, number, number],
    randomize: { type: "action" as const, label: "Randomize seed" },
    download: { type: "action" as const, label: "Download PNG" },
  },
};

const colorCtx = (() => {
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  return c.getContext("2d", { willReadFrequently: true })!;
})();

function parseColor(css: string): [number, number, number] {
  colorCtx.clearRect(0, 0, 1, 1);
  colorCtx.fillStyle = "#000";
  colorCtx.fillStyle = css;
  colorCtx.fillRect(0, 0, 1, 1);
  const d = colorCtx.getImageData(0, 0, 1, 1).data;
  return [d[0] / 255, d[1] / 255, d[2] / 255];
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<InkRenderer | null>(null);
  const sourceCanvas = useRef<HTMLCanvasElement>(document.createElement("canvas"));
  const sourceKey = useRef("");
  const paperKey = useRef<string | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const download = useCallback(() => {
    const canvas = rendererRef.current?.canvas;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `ink-bleed-${canvas.width}x${canvas.height}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, "image/png");
  }, []);

  const dialRef = useRef<ReturnType<typeof useDialKitController<typeof config>> | null>(null);
  const dial = useDialKitController("Ink Bleed", config, {
    id: "ink-bleed",
    onAction: (path) => {
      if (path.endsWith("download")) download();
      if (path.endsWith("randomize")) dialRef.current?.setValue("output.seed", Math.floor(Math.random() * 1000));
    },
  });
  dialRef.current = dial;
  const v = dial.values;

  useEffect(() => {
    if (!canvasRef.current) return;
    try {
      rendererRef.current = new InkRenderer(canvasRef.current);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = rendererRef.current;
      if (!r) return;
      try {
        const useImage = v.input.source === "image" && !!v.input.artwork;
        const artwork = useImage ? await loadImage(v.input.artwork) : null;
        const family = FONTS[v.input.font] ?? FONTS.Blackletter;
        if (!useImage) await ensureFont(family);

        let ratio = 4 / 5;
        if (v.output.aspect === "match input") {
          ratio = artwork ? artwork.naturalWidth / artwork.naturalHeight : 4 / 5;
        } else {
          const [a, b] = v.output.aspect.split(":").map(Number);
          ratio = a / b;
        }
        const long = Math.round(v.output.resolution);
        const w = Math.round(ratio >= 1 ? long : long * ratio);
        const h = Math.round(ratio >= 1 ? long / ratio : long);

        const paperUrl = v.paper.source === "image" && v.paper.texture ? v.paper.texture : null;
        const paperImg = paperUrl ? await loadImage(paperUrl) : null;
        if (cancelled) return;

        r.setSize(w, h);
        const key = JSON.stringify([w, h, useImage, useImage ? v.input.artwork.length + v.input.artwork.slice(-64) : v.input.text, family, v.input.lineHeight, v.input.tracking, v.input.padding]);
        if (key !== sourceKey.current) {
          drawSource(
            sourceCanvas.current,
            w,
            h,
            artwork
              ? { kind: "image", image: artwork, padding: v.input.padding }
              : {
                  kind: "text",
                  text: v.input.text,
                  font: family,
                  lineHeight: v.input.lineHeight,
                  tracking: v.input.tracking,
                  padding: v.input.padding,
                },
          );
          r.setSource(sourceCanvas.current);
          sourceKey.current = key;
        }
        if (paperUrl !== paperKey.current) {
          r.setPaperImage(paperImg);
          paperKey.current = paperUrl;
        }

        const paperMode = v.paper.source === "flat" ? 2 : paperImg ? 1 : 0;
        const params: RenderParams = {
          seed: v.output.seed,
          view: Math.max(0, VIEWS.indexOf(v.output.view)) as RenderParams["view"],
          transparent: v.output.transparent,
          paper: {
            mode: paperMode as 0 | 1 | 2,
            color: parseColor(v.paper.color),
            scale: v.paper.scale,
            fiber: v.paper.fibers,
            rough: v.paper.roughness,
            mottle: v.paper.mottle,
            dust: v.paper.dust,
            contrast: v.paper.imageContrast,
            tint: v.paper.imageColor,
          },
          bleed: {
            warp: v.bleed.warp,
            warpScale: v.bleed.warpScale,
            fiberPull: v.bleed.fiberPull,
            influence: v.bleed.paperInfluence,
            blotch: v.bleed.blotch,
            blotchScale: v.bleed.blotchScale,
            core: v.bleed.core,
            halo: v.bleed.halo,
            haloAmt: v.bleed.haloAmount,
            threshold: v.bleed.threshold,
            softness: v.bleed.softness,
            grain: v.grain.amount,
            grainSize: v.grain.size,
            clump: v.grain.clump,
            tooth: v.grain.paperTooth,
            pooling: v.ink.pooling,
            speckle: v.speckles.amount,
            speckleSize: v.speckles.size,
            speckleReach: v.speckles.reach,
            density: v.ink.density,
            ink: parseColor(v.ink.color),
            invert: v.input.invert,
          },
        };
        requestAnimationFrame(() => {
          if (cancelled) return;
          r.render(params);
          setStatus(`${w} × ${h} px`);
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [v]);

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/"));
    if (!file) return;
    const url = await readFile(file);
    if (e.altKey) {
      dial.setValues({ paper: { source: "image", texture: url } } as never);
    } else {
      dial.setValues({ input: { source: "image", artwork: url } } as never);
    }
  };

  return (
    <>
      <div
        className={`stage${dragging ? " dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <canvas ref={canvasRef} />
      </div>
      <div className="status">
        {error ? `Error: ${error}` : `${status} · drop an image to use as artwork · Alt + drop for a paper texture`}
      </div>
      <DialRoot position="top-right" theme="dark" productionEnabled />
    </>
  );
}
