import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const PALETTES = [
  ["#F5EFE6", "#1F2428", "#B83243", "#466B7A", "#D8C5A9"],
  ["#F3F6F1", "#20251F", "#A13D2D", "#476A56", "#DDE8D4"],
  ["#F4F0EA", "#202124", "#9C2F42", "#315F72", "#E4DAC9"],
  ["#F7F3EE", "#1F2328", "#A93A33", "#5B5E76", "#E9DCCB"],
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
  const [bg, ink, accent, secondary, paper] = PALETTES[index % PALETTES.length];
  const titleLines = wrapCjk(scene.title, 11, 2);
  const subtitleLines = wrapCjk(scene.subtitle || scene.narration, 23, 3);
  const background = backgroundDataUri
    ? `<image href="${backgroundDataUri}" x="0" y="0" width="1080" height="1920" preserveAspectRatio="xMidYMid slice"/>
  <rect width="1080" height="1920" fill="url(#readableShade)"/>`
    : buildFallbackVisual(scene, bg, ink, accent, secondary, paper);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="${bg}"/>
      <stop offset="100%" stop-color="${paper}"/>
    </linearGradient>
    <pattern id="grid" width="72" height="72" patternUnits="userSpaceOnUse">
      <path d="M 72 0 L 0 0 0 72" fill="none" stroke="${secondary}" stroke-width="1" opacity="0.10"/>
    </pattern>
    <linearGradient id="readableShade" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0.16"/>
      <stop offset="35%" stop-color="#000000" stop-opacity="0.06"/>
      <stop offset="72%" stop-color="#000000" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.32"/>
    </linearGradient>
    <linearGradient id="subtitleShade" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="#111111" stop-opacity="0.72"/>
      <stop offset="100%" stop-color="#111111" stop-opacity="0.88"/>
    </linearGradient>
  </defs>
  ${background}
  <rect width="1080" height="1920" fill="url(#grid)" opacity="${backgroundDataUri ? "0.02" : "1"}"/>
  <text x="82" y="124" fill="#000000" font-size="26" font-weight="760" opacity="0.34" font-family="${fontFamily()}">热点分析</text>
  <text x="80" y="122" fill="#ffffff" font-size="26" font-weight="760" opacity="0.82" font-family="${fontFamily()}">热点分析</text>
  <text x="1002" y="124" fill="#000000" font-size="24" font-weight="760" text-anchor="end" opacity="0.30" font-family="${fontFamily()}">${index + 1}/${total}</text>
  <text x="1000" y="122" fill="#ffffff" font-size="24" font-weight="760" text-anchor="end" opacity="0.72" font-family="${fontFamily()}">${index + 1}/${total}</text>
  <rect x="76" y="456" width="10" height="154" rx="5" fill="${accent}" opacity="0.95"/>
  ${makeTextLines(titleLines, 108, 526, 104, { fill: backgroundDataUri ? "#ffffff" : ink, fontSize: 78, fontWeight: 900, shadow: Boolean(backgroundDataUri) })}
  <rect x="72" y="1332" width="936" height="254" rx="22" fill="url(#subtitleShade)" opacity="${backgroundDataUri ? "0.86" : "0.94"}"/>
  ${makeTextLines(subtitleLines, 110, 1426, 58, { fill: "#ffffff", fontSize: 42, fontWeight: 780, shadow: true })}
</svg>`;
}

function buildFallbackVisual(scene, bg, ink, accent, secondary, paper) {
  if (scene.visualType === "chart") {
    return `<rect width="1080" height="1920" fill="url(#bg)"/>
  <rect x="96" y="678" width="888" height="470" rx="30" fill="#ffffff" opacity="0.62" stroke="${ink}" stroke-width="2" stroke-opacity="0.10"/>
  <path d="M166 1040 L300 962 L430 986 L560 840 L700 874 L898 728" fill="none" stroke="${accent}" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M166 1110 L300 1070 L430 1098 L560 1010 L700 1040 L898 948" fill="none" stroke="${secondary}" stroke-width="12" stroke-linecap="round" opacity="0.78"/>
  <circle cx="898" cy="728" r="20" fill="${accent}"/>
  <text x="144" y="758" fill="${ink}" font-size="30" font-weight="820" opacity="0.72" font-family="${fontFamily()}">趋势观察</text>`;
  }
  return `<rect width="1080" height="1920" fill="url(#bg)"/>
  <rect x="96" y="640" width="888" height="510" rx="34" fill="#ffffff" opacity="0.58" stroke="${ink}" stroke-width="2" stroke-opacity="0.08"/>
  <circle cx="850" cy="560" r="220" fill="${secondary}" opacity="0.16"/>
  <circle cx="180" cy="1210" r="320" fill="${accent}" opacity="0.10"/>
  <path d="M140 1030 C320 900 450 960 570 810 C710 640 850 760 956 626" fill="none" stroke="${accent}" stroke-width="12" opacity="0.72"/>
  <text x="144" y="742" fill="${ink}" font-size="30" font-weight="820" opacity="0.72" font-family="${fontFamily()}">信息简报</text>`;
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
