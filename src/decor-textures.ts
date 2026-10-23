import { DynamicTexture, Scene, Texture } from "@babylonjs/core";

/** A 2×4 atlas of graffiti, drawn here: meme phrases. */
export const GRAFFITI_CELLS = 8;
/** The cell with «СПЕРДАЛЯЙ», which also goes up big near the start. */
export const SPERDALYAY = 0;
/** A 2×4 atlas of neon signs. */
export const SIGN_CELLS = 8;

const FONT = `"Arial Black", Impact, "Segoe UI Black", sans-serif`;

let seed = 5;
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

/** Paint running down from under a tag. */
function drips(c: CanvasRenderingContext2D, x0: number, x1: number, y: number, color: string, count: number) {
  c.strokeStyle = color;
  c.fillStyle = color;
  c.lineCap = "round";
  for (let i = 0; i < count; i++) {
    const x = x0 + rand() * (x1 - x0);
    const len = 8 + rand() * 38;
    c.lineWidth = 2 + rand() * 4;
    c.beginPath();
    c.moveTo(x, y - 6);
    c.lineTo(x, y + len);
    c.stroke();
    c.beginPath();
    c.arc(x, y + len, c.lineWidth * 0.9, 0, Math.PI * 2);
    c.fill();
  }
}

/** A spray-painted tag, fitted to the cell, with an outline and drips. */
function tag(c: CanvasRenderingContext2D, text: string, fill: string | [string, string], outline: string, opts: { size?: number; rot?: number; drip?: boolean; lines?: string[] } = {}) {
  const lines = opts.lines ?? [text];
  c.save();
  c.translate(128, 128);
  c.rotate(opts.rot ?? (rand() - 0.5) * 0.25);
  c.font = `${opts.size ?? 64}px ${FONT}`;
  const width = Math.max(...lines.map((l) => c.measureText(l).width));
  const k = Math.min(1, 228 / width);
  c.scale(k, k);
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.lineJoin = "round";
  const lh = (opts.size ?? 64) * 1.05;
  const top = (-(lines.length - 1) * lh) / 2;
  lines.forEach((l, i) => {
    const y = top + i * lh;
    c.strokeStyle = outline;
    c.lineWidth = 14;
    c.strokeText(l, 0, y);
    if (Array.isArray(fill)) {
      const g = c.createLinearGradient(0, y - lh / 2, 0, y + lh / 2);
      g.addColorStop(0, fill[0]);
      g.addColorStop(1, fill[1]);
      c.fillStyle = g;
    } else c.fillStyle = fill;
    c.fillText(l, 0, y);
  });
  if (opts.drip !== false) drips(c, -width * 0.45, width * 0.45, top + (lines.length - 0.5) * lh, Array.isArray(fill) ? fill[1] : fill, 6);
  c.restore();
}

export function graffitiAtlas(scene: Scene) {
  const tex = new DynamicTexture("graffiti", { width: 1024, height: 2048 }, scene, true);
  const c = tex.getContext() as unknown as CanvasRenderingContext2D;
  c.clearRect(0, 0, 1024, 2048);
  const cells: ((c: CanvasRenderingContext2D) => void)[] = [
    (c) => tag(c, "СПЕРДАЛЯЙ", ["#fff23a", "#ff8a1a"], "#111", { size: 62 }),
    (c) => tag(c, "", ["#5dff7a", "#ffe14a"], "#111", { lines: ["ПАЦАНЫ, ВООБЩЕ", "РЕБЯТА!", "УМЕЕТЕ,", "МОГЁТЕ!"], size: 50 }),
    (c) => tag(c, "", ["#ff6a2a", "#ff2a2a"], "#111", { lines: ["ШАУРМА", "У ВАЗГЕНА"], size: 64 }),
    (c) => tag(c, "", "#ffffff", "#c81e1e", { lines: ["КАМЕРУ", "ВЫРУБАЙ"], size: 70 }),
    (c) => tag(c, "", ["#7af0ff", "#2a8cff"], "#0c0c0c", { lines: ["СОМНИТЕЛЬНО,", "НО ОКЭЙ"], size: 56 }),
    (c) => tag(c, "", ["#a46bff", "#ff3bd0"], "#111", { lines: ["ИМЯ ИБРАГИМ", "ВАМ О ЧЁМ-НИБУДЬ", "ГОВОРИТ?"], size: 50 }),
    (c) => tag(c, "", "#f5f5f5", "#1d3a8a", { lines: ["СЛАБЫЙ ИЩЕТ", "ОПРАВДАНИЯ —", "СИЛЬНЫЙ ИХ УЖЕ", "ПОДГОТОВИЛ"], size: 48 }),
    (c) => tag(c, "", ["#ffd23a", "#ff6a2a"], "#111", { lines: ["ДЕЛУ ВРЕМЯ —", "ПОТЕХЕ", "ЕХЕХЕХЕХЕХЕ"], size: 54 }),
  ];
  cells.forEach((draw, i) => {
    c.save();
    // Cells are 512 px; the tags are laid out for 256, so they are drawn at double scale.
    c.translate((i % 2) * 512, Math.floor(i / 2) * 512);
    c.beginPath();
    c.rect(0, 0, 512, 512);
    c.clip();
    c.scale(2, 2);
    draw(c);
    c.restore();
  });
  tex.hasAlpha = true;
  tex.update();
  tex.wrapU = tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  return tex;
}

/** A bear reared up on its hind legs, paws in the air, mouth wide open; feet at the origin, about 830 units tall. */
function bear(c: CanvasRenderingContext2D) {
  const ellipse = (x: number, y: number, rx: number, ry: number, color: string) => {
    c.fillStyle = color;
    c.beginPath();
    c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    c.fill();
  };
  const arms: [number, number, number, number][] = [
    [-110, -470, -300, -755],
    [110, -470, 285, -725],
  ];
  // The silhouette twice: grown and dark for the outline, then the fur.
  const silhouette = (color: string, g: number) => {
    for (const s of [-1, 1]) {
      ellipse(s * 90, -95, 66 + g, 105 + g, color);
      ellipse(s * 108, -20, 80 + g, 30 + g, color);
      ellipse(s * 95, -735, 42 + g, 42 + g, color);
    }
    ellipse(0, -320, 165 + g, 245 + g, color);
    c.strokeStyle = color;
    c.lineCap = "round";
    c.lineWidth = 96 + g * 2;
    for (const [x0, y0, x1, y1] of arms) {
      c.beginPath();
      c.moveTo(x0, y0);
      c.lineTo(x1, y1);
      c.stroke();
      ellipse(x1, y1, 62 + g, 62 + g, color);
    }
    ellipse(0, -640, 125 + g, 118 + g, color);
  };
  silhouette("#24140a", 9);
  silhouette("#5a3519", 0);
  // Belly, ears, paw pads and claws.
  ellipse(0, -290, 100, 165, "#835531");
  for (const s of [-1, 1]) ellipse(s * 95, -735, 22, 22, "#9a6a3e");
  for (const [, , x, y] of arms) {
    ellipse(x, y + 8, 30, 26, "#2e1a0c");
    for (const a of [-0.9, -0.3, 0.3, 0.9]) {
      const tx = x + Math.sin(a) * 46, ty = y - Math.cos(a) * 46;
      ellipse(tx, ty, 12, 12, "#2e1a0c");
      c.fillStyle = "#f2e6c8";
      c.beginPath();
      c.moveTo(tx - 6, ty - 8);
      c.lineTo(tx + Math.sin(a) * 26, ty - Math.cos(a) * 26);
      c.lineTo(tx + 6, ty - 8);
      c.fill();
    }
  }
  // The face: surprised eyes, raised brows, a big muzzle with the mouth wide open.
  ellipse(0, -595, 72, 60, "#c49a6c");
  ellipse(0, -565, 36, 44, "#3b0a0a");
  ellipse(0, -540, 22, 14, "#d0566a");
  c.fillStyle = "#fff";
  for (const s of [-1, 1]) {
    c.beginPath();
    c.moveTo(s * 24, -600);
    c.lineTo(s * 14, -584);
    c.lineTo(s * 6, -602);
    c.fill();
  }
  ellipse(0, -634, 27, 18, "#111");
  ellipse(-8, -639, 8, 5, "#777");
  for (const s of [-1, 1]) {
    ellipse(s * 48, -688, 19, 21, "#fff");
    ellipse(s * 46, -686, 10, 11, "#111");
    ellipse(s * 43, -690, 3, 3, "#fff");
    c.strokeStyle = "#24140a";
    c.lineWidth = 8;
    c.beginPath();
    c.arc(s * 50, -706, 26, Math.PI * 1.15, Math.PI * 1.85);
    c.stroke();
  }
  // A few strokes of darker fur.
  c.strokeStyle = "#3e2412";
  c.lineWidth = 6;
  for (const [x, y] of [[-120, -420], [125, -380], [-60, -160], [70, -200], [-140, -250], [150, -300]]) {
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + 12, y + 30);
    c.stroke();
  }
}

/**
 * A mural for a whole wall, w×h metres: a bear jumping out of a forest at sunset, shouting «ПРЕВЕД!».
 * The bear is drawn here from scratch, a nod to the old meme rather than a copy of the painting.
 */
export function bearMural(scene: Scene, w: number, h: number) {
  const W = 1024, H = Math.round(Math.min(2048, Math.max(400, (1024 * h) / w)));
  const tex = new DynamicTexture("bearMural", { width: W, height: H }, scene, true);
  const c = tex.getContext() as unknown as CanvasRenderingContext2D;
  c.clearRect(0, 0, W, H);
  // Sky, sun and a dark spruce forest along the bottom.
  const sky = c.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, "#2a4d8f");
  sky.addColorStop(0.55, "#f08a5d");
  sky.addColorStop(1, "#ffd27a");
  c.fillStyle = sky;
  c.fillRect(12, 12, W - 24, H - 24);
  c.fillStyle = "#ffe8a0";
  c.beginPath();
  c.arc(W * 0.78, H * 0.62, Math.min(W, H) * 0.13, 0, Math.PI * 2);
  c.fill();
  for (const [shade, base, hgt] of [["#1f3d2a", 0.78, 0.3], ["#13281b", 0.9, 0.24]] as const) {
    c.fillStyle = shade;
    for (let x = 0; x < W + 60; x += 46 + rand() * 30) {
      const top = H * (base - hgt * (0.6 + rand() * 0.4));
      c.beginPath();
      c.moveTo(x - 40, H * base + 20);
      c.lineTo(x, top);
      c.lineTo(x + 40, H * base + 20);
      c.fill();
    }
    c.fillRect(12, H * base, W - 24, H);
  }
  // The bear: on the left of a wide wall, in the middle of a tall one.
  const wide = W / H > 1.25;
  const s = Math.min((W * (wide ? 0.55 : 0.85)) / 740, (H * 0.78) / 840);
  c.save();
  c.translate(W * (wide ? 0.34 : 0.5), H * 0.95);
  c.scale(s, s);
  bear(c);
  c.restore();
  // A speech bubble out of its mouth.
  const bx = W * (wide ? 0.73 : 0.5), by = H * (wide ? 0.28 : 0.11);
  c.font = `${Math.round(Math.min(W * (wide ? 0.11 : 0.15), H * 0.13))}px ${FONT}`;
  const tw = c.measureText("ПРЕВЕД!").width;
  const rx = tw * 0.62, ry = Math.min(W, H) * 0.09;
  const mouthX = W * (wide ? 0.34 : 0.5), mouthY = H * 0.95 - 565 * s;
  c.fillStyle = "#fff";
  c.strokeStyle = "#111";
  c.lineWidth = 8;
  c.beginPath();
  c.moveTo(bx + (wide ? -rx * 0.6 : -rx * 0.2), by + ry * 0.5);
  c.lineTo(mouthX + (wide ? 60 * s : 0), mouthY - (wide ? 0 : 160 * s));
  c.lineTo(bx + (wide ? -rx * 0.3 : rx * 0.2), by + ry * 0.7);
  c.closePath();
  c.fill();
  c.stroke();
  c.beginPath();
  c.ellipse(bx, by, rx, ry, 0, 0, Math.PI * 2);
  c.fill();
  c.stroke();
  c.fillStyle = "#fff";
  c.beginPath();
  c.ellipse(bx, by, rx - 4, ry - 4, 0, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = "#d81c1c";
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText("ПРЕВЕД!", bx, by + 4);
  // Sprayed-on, not printed: a ragged edge.
  c.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 260; i++) {
    const t = rand();
    const [x, y] = [[t * W, 0], [t * W, H], [0, t * H], [W, t * H]][i % 4];
    c.beginPath();
    c.arc(x, y, 8 + rand() * 22, 0, Math.PI * 2);
    c.fill();
  }
  c.globalCompositeOperation = "source-over";
  tex.hasAlpha = true;
  tex.update();
  tex.wrapU = tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  return tex;
}

/** «Я в своём познании настолько преисполнился…» in worn white road paint, stretched along the road like real markings; top of the texture is ahead. */
export function riverText(scene: Scene) {
  const W = 512, H = 1024;
  const tex = new DynamicTexture("riverText", { width: W, height: H }, scene, true);
  const c = tex.getContext() as unknown as CanvasRenderingContext2D;
  c.clearRect(0, 0, W, H);
  c.fillStyle = "#ece8da";
  c.textAlign = "center";
  c.textBaseline = "middle";
  const line = (text: string, y: number, size: number, stretch: number) => {
    c.save();
    c.translate(W / 2, y);
    c.font = `${size}px ${FONT}`;
    const k = Math.min(1, 470 / c.measureText(text).width);
    c.scale(k, stretch);
    c.fillText(text, 0, 0);
    c.restore();
  };
  line("Я В СВОЁМ", 170, 90, 1.8);
  line("ПОЗНАНИИ", 390, 90, 1.8);
  line("НАСТОЛЬКО", 610, 90, 1.8);
  line("ПРЕИСПОЛНИЛСЯ…", 830, 90, 1.8);
  // Worn by tyres and feet.
  c.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 1400; i++) {
    c.globalAlpha = 0.3 + rand() * 0.7;
    c.fillRect(rand() * W, rand() * H, 2 + rand() * 6, 2 + rand() * 10);
  }
  c.globalAlpha = 1;
  c.globalCompositeOperation = "source-over";
  tex.hasAlpha = true;
  tex.update();
  tex.wrapU = tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  return tex;
}

/** Creepers hanging down a wall: a dozen strands of leaves, thinning out towards the bottom. */
export function vineTexture(scene: Scene) {
  const W = 256, H = 512;
  const tex = new DynamicTexture("vines", { width: W, height: H }, scene, true);
  const c = tex.getContext() as unknown as CanvasRenderingContext2D;
  c.clearRect(0, 0, W, H);
  for (let s = 0; s < 12; s++) {
    let x = 10 + rand() * (W - 20);
    const len = H * (0.45 + rand() * 0.55);
    c.strokeStyle = "#2c4a1c";
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(x, 0);
    for (let y = 0; y < len; y += 8) {
      x += (rand() - 0.5) * 6;
      c.lineTo(x, y);
      if (rand() < 0.75) {
        // A leaf either side, darker and fewer lower down.
        c.fillStyle = ["#3f7a26", "#4f8f2e", "#2f6a20", "#5c9a34"][Math.floor(rand() * 4)];
        c.globalAlpha = 1 - (y / len) * 0.4;
        c.beginPath();
        c.ellipse(x + (rand() < 0.5 ? -6 : 6), y, 7, 4, rand() * 3, 0, Math.PI * 2);
        c.fill();
        c.globalAlpha = 1;
        c.beginPath();
        c.moveTo(x, y);
      }
    }
    c.stroke();
  }
  // A mat of leaves along the top, where the creepers hold on.
  for (let i = 0; i < 90; i++) {
    c.fillStyle = ["#3f7a26", "#2f6a20", "#4f8f2e"][i % 3];
    c.beginPath();
    c.ellipse(rand() * W, rand() * 26, 9, 6, rand() * 3, 0, Math.PI * 2);
    c.fill();
  }
  tex.hasAlpha = true;
  tex.update();
  tex.wrapU = tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  return tex;
}

const SIGNS: [string, string][] = [
  ["РЕМОНТ РОБОТОВ", "#3ee8ff"],
  ["БАР «ОРБИТА»", "#ff3bd0"],
  ["24 ЧАСА", "#4bff7a"],
  ["ОТЕЛЬ", "#ffd23a"],
  ["КИБЕР-КЛУБ", "#a46bff"],
  ["ЛОМБАРД", "#ff8a2a"],
  ["АПТЕКА ✚", "#36ff9a"],
  ["ШАУРМА", "#ff3a3a"],
];

/** Glowing neon lettering on a transparent background; the sign's dark backing is a separate box. */
export function signAtlas(scene: Scene) {
  const w = 1024, h = 512;
  const tex = new DynamicTexture("signs", { width: w, height: h }, scene, true);
  const c = tex.getContext() as unknown as CanvasRenderingContext2D;
  c.clearRect(0, 0, w, h);
  SIGNS.forEach(([text, color], i) => {
    const x = (i % 2) * 512, y = Math.floor(i / 2) * 128;
    c.save();
    c.translate(x + 256, y + 64);
    c.font = `64px ${FONT}`;
    const k = Math.min(1, 470 / c.measureText(text).width);
    c.scale(k, k);
    c.textAlign = "center";
    c.textBaseline = "middle";
    // Neon tubes: coloured letters with a thin bright core. The bloom comes from the glow layer,
    // so the texture itself stays crisp (a white fill would blow out into a blob).
    c.fillStyle = color;
    c.fillText(text, 0, 0);
    c.strokeStyle = "rgba(255,255,255,0.75)";
    c.lineWidth = 2;
    c.strokeText(text, 0, 0);
    c.restore();
  });
  tex.hasAlpha = true;
  tex.update();
  return tex;
}

/** Stripes fading away from the lamp, for the searchlight beams. */
export function beamTexture(scene: Scene) {
  const tex = new DynamicTexture("beam", { width: 8, height: 256 }, scene, false);
  const c = tex.getContext() as unknown as CanvasRenderingContext2D;
  const g = c.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,255,255,0.45)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = g;
  c.fillRect(0, 0, 8, 256);
  tex.hasAlpha = true;
  tex.update();
  return tex;
}

/** A landing pad: grey deck, yellow ring and stripes, a big H. */
export function padTexture(scene: Scene) {
  const s = 256;
  const tex = new DynamicTexture("pad", { width: s, height: s }, scene, true);
  const c = tex.getContext() as unknown as CanvasRenderingContext2D;
  c.fillStyle = "#3a3d42";
  c.fillRect(0, 0, s, s);
  c.strokeStyle = "#f2c230";
  c.lineWidth = 10;
  c.beginPath();
  c.arc(128, 128, 112, 0, Math.PI * 2);
  c.stroke();
  c.setLineDash([18, 14]);
  c.lineWidth = 5;
  c.beginPath();
  c.arc(128, 128, 92, 0, Math.PI * 2);
  c.stroke();
  c.setLineDash([]);
  c.fillStyle = "#e8e8e8";
  c.fillRect(80, 70, 22, 116);
  c.fillRect(154, 70, 22, 116);
  c.fillRect(80, 117, 96, 22);
  tex.update();
  return tex;
}

/** Solar panel: dark blue cells in a silver frame. */
export function solarTexture(scene: Scene) {
  const tex = new DynamicTexture("solar", { width: 128, height: 64 }, scene, true);
  const c = tex.getContext() as unknown as CanvasRenderingContext2D;
  c.fillStyle = "#b8bcc4";
  c.fillRect(0, 0, 128, 64);
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 4; y++) {
      const g = c.createLinearGradient(0, y * 16, 0, y * 16 + 16);
      g.addColorStop(0, "#28406e");
      g.addColorStop(1, "#122244");
      c.fillStyle = g;
      c.fillRect(x * 16 + 1, y * 16 + 1, 14, 14);
    }
  }
  tex.update();
  return tex;
}
