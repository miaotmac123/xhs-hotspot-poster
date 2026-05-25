import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const PALETTES = [
  ["#101114", "#F5F1E8", "#FF4F7B", "#45E6FF", "#F7D046"],
  ["#121826", "#F9F7F0", "#7CFFCB", "#FF6A3D", "#8EA7FF"],
  ["#FFF7E0", "#191919", "#E93F5C", "#0E8A83", "#8B5CF6"],
  ["#201A1B", "#FFF8EC", "#D93A4A", "#2B6F77", "#FFE16A"],
];

export async function writeSceneCards({ plan, outputDir, slug }) {
  const cards = [];
  let cursor = 0;
  for (const [index, scene] of plan.scenes.entries()) {
    const backgroundDataUri = scene.backgroundImagePath ? await imageDataUri(scene.backgroundImagePath).catch(() => "") : "";
    const durationSeconds = Number(scene.durationSeconds || 4);
    const sceneStart = cursor;
    const sceneEnd = cursor + durationSeconds;
    const subtitleSegments = subtitleSegmentsForScene(plan.subtitleSegments || [], sceneStart, sceneEnd);
    const cardInputs = subtitleSegments.length ? subtitleSegments : [{
      startSeconds: sceneStart,
      endSeconds: sceneEnd,
      text: scene.subtitle || scene.narration || "",
    }];

    for (const [subtitleIndex, segment] of cardInputs.entries()) {
      const svgPath = path.join(
        outputDir,
        `${slug}-scene-${String(index + 1).padStart(2, "0")}-${String(subtitleIndex + 1).padStart(2, "0")}.svg`,
      );
      const segmentDuration = Math.max(0.5, Math.min(sceneEnd, Number(segment.endSeconds || sceneEnd)) - Math.max(sceneStart, Number(segment.startSeconds || sceneStart)));
      await writeFile(svgPath, buildSceneSvg({
        ...scene,
        subtitle: segment.text || scene.subtitle || scene.narration || "",
      }, index, plan.scenes.length, backgroundDataUri), "utf8");
      const imagePath = await renderSvgToPng(svgPath);
      cards.push({
        ...scene,
        durationSeconds: segmentDuration,
        subtitle: segment.text || scene.subtitle,
        svgPath,
        imagePath,
      });
    }
    cursor = sceneEnd;
  }
  return cards;
}

function subtitleSegmentsForScene(segments, sceneStart, sceneEnd) {
  return segments.filter((segment) => {
    const start = Number(segment.startSeconds || 0);
    const end = Number(segment.endSeconds || 0);
    return end > sceneStart && start < sceneEnd;
  });
}

async function renderSvgToPng(svgPath) {
  const finalPath = svgPath.replace(/\.svg$/i, ".png");
  try {
    await runCommand("sips", ["-s", "format", "png", svgPath, "--out", finalPath]);
    return finalPath;
  } catch {
    // Fall back to qlmanage on older macOS setups where sips cannot read SVG.
  }
  const dir = path.dirname(svgPath);
  await runCommand("qlmanage", ["-t", "-s", "1920", "-o", dir, svgPath]);
  const generated = `${svgPath}.png`;
  await renameIfPossible(generated, finalPath);
  return finalPath;
}

async function renameIfPossible(from, to) {
  const { rename } = await import("node:fs/promises");
  await rename(from, to);
}

function buildSceneSvg(scene, index, total, backgroundDataUri) {
  const [bg, ink, accent, cyan, yellow] = PALETTES[index % PALETTES.length];
  const titleLines = wrapCjk(scene.title, 11, 2);
  const subtitleLines = wrapCjk(scene.subtitle || scene.narration, 23, 3);
  const background = backgroundDataUri
    ? `<image href="${backgroundDataUri}" x="0" y="0" width="1080" height="1920" preserveAspectRatio="xMidYMid slice"/>
  <rect width="1080" height="1920" fill="url(#readableShade)"/>`
    : buildFallbackVisual(scene, bg, accent, cyan, yellow);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="${bg}"/>
      <stop offset="55%" stop-color="${shiftColor(bg, 28)}"/>
      <stop offset="100%" stop-color="${shiftColor(accent, -36)}"/>
    </linearGradient>
    <pattern id="grid" width="72" height="72" patternUnits="userSpaceOnUse">
      <path d="M 72 0 L 0 0 0 72" fill="none" stroke="${cyan}" stroke-width="1" opacity="0.15"/>
    </pattern>
    <linearGradient id="readableShade" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0.20"/>
      <stop offset="22%" stop-color="#000000" stop-opacity="0.12"/>
      <stop offset="50%" stop-color="#000000" stop-opacity="0.04"/>
      <stop offset="78%" stop-color="#000000" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.42"/>
    </linearGradient>
    <linearGradient id="subtitleShade" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.46"/>
    </linearGradient>
  </defs>
  ${background}
  <rect width="1080" height="1920" fill="url(#grid)" opacity="${backgroundDataUri ? "0.03" : "0.10"}"/>
  <text x="82" y="124" fill="#000000" font-size="26" font-weight="760" opacity="0.34" font-family="${fontFamily()}">热点分析</text>
  <text x="80" y="122" fill="#ffffff" font-size="26" font-weight="760" opacity="0.82" font-family="${fontFamily()}">热点分析</text>
  <text x="1002" y="124" fill="#000000" font-size="24" font-weight="760" text-anchor="end" opacity="0.30" font-family="${fontFamily()}">${index + 1}/${total}</text>
  <text x="1000" y="122" fill="#ffffff" font-size="24" font-weight="760" text-anchor="end" opacity="0.72" font-family="${fontFamily()}">${index + 1}/${total}</text>
  <rect x="76" y="456" width="10" height="154" rx="5" fill="${accent}" opacity="0.95"/>
  ${makeTextLines(titleLines, 108, 526, 104, { fill: "#ffffff", fontSize: 78, fontWeight: 900, shadow: true })}
  <rect x="72" y="1332" width="936" height="254" rx="22" fill="url(#subtitleShade)" opacity="0.88"/>
  ${makeTextLines(subtitleLines, 110, 1426, 58, { fill: "#ffffff", fontSize: 42, fontWeight: 780, shadow: true })}
</svg>`;
}

function buildFallbackVisual(scene, bg, accent, cyan, yellow) {
  if (scene.visualType === "chart") {
    return `<rect width="1080" height="1920" fill="url(#bg)"/>
  <rect x="116" y="680" width="848" height="450" rx="28" fill="#ffffff" opacity="0.16"/>
  <path d="M170 1020 L300 930 L430 970 L560 810 L700 850 L880 720" fill="none" stroke="${yellow}" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M170 1100 L300 1060 L430 1088 L560 1000 L700 1030 L880 940" fill="none" stroke="${cyan}" stroke-width="12" stroke-linecap="round" opacity="0.76"/>
  <circle cx="880" cy="720" r="20" fill="${accent}"/>`;
  }
  return `<rect width="1080" height="1920" fill="url(#bg)"/>
  <circle cx="880" cy="520" r="260" fill="${cyan}" opacity="0.22"/>
  <circle cx="190" cy="1230" r="330" fill="${accent}" opacity="0.24"/>
  <path d="M120 1120 C300 980 430 1030 560 870 C700 700 850 790 980 660" fill="none" stroke="${yellow}" stroke-width="14" opacity="0.72"/>`;
}

function wrapCjk(text, width, maxLines) {
  const clean = String(text || "今日热点").replace(/\s+/g, " ").trim();
  const lines = [];
  let cursor = 0;
  while (cursor < clean.length && lines.length < maxLines) {
    lines.push(clean.slice(cursor, cursor + width));
    cursor += width;
  }
  if (cursor < clean.length && lines.length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[，。,. ]+$/, "")}…`;
  }
  return lines.length ? lines : ["今日热点"];
}

function makeTextLines(lines, x, y, lineHeight, options) {
  return lines.map((line, index) => {
    const lineY = y + index * lineHeight;
    const text = escapeXml(line);
    const shadow = options.shadow
      ? `<text x="${x + 3}" y="${lineY + 4}" fill="#000000" font-size="${options.fontSize}" font-weight="${options.fontWeight}" opacity="0.42" font-family="${fontFamily()}">${text}</text>\n  `
      : "";
    return `${shadow}<text x="${x}" y="${lineY}" fill="${options.fill}" font-size="${options.fontSize}" font-weight="${options.fontWeight}" font-family="${fontFamily()}">${text}</text>`;
  }).join("\n  ");
}

function shiftColor(color, amount) {
  const value = color.replace("#", "");
  const channels = [0, 2, 4].map((offset) => Math.max(0, Math.min(255, Number.parseInt(value.slice(offset, offset + 2), 16) + amount)));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function fontFamily() {
  return "PingFang SC, Hiragino Sans GB, Microsoft YaHei, Arial, sans-serif";
}

async function imageDataUri(imagePath) {
  const bytes = await readFile(imagePath);
  const mime = mimeFromPath(imagePath);
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function mimeFromPath(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`));
    });
  });
}
