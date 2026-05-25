import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export async function renderVideo({ cards, audioPath, outputPath, workDir, fps }) {
  const concatPath = path.join(workDir, "scene-list.txt");
  const lines = [];
  for (const card of cards) {
    lines.push(`file '${escapeConcatPath(card.imagePath)}'`);
    lines.push(`duration ${card.durationSeconds}`);
  }
  lines.push(`file '${escapeConcatPath(cards[cards.length - 1].imagePath)}'`);
  await writeFile(concatPath, lines.join("\n"), "utf8");

  const args = [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", concatPath.toString(),
    "-i", audioPath.toString(),
    "-vf", `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=${fps || 30},format=yuv420p`,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-c:a", "aac",
    "-b:a", "160k",
    "-shortest",
    "-movflags", "+faststart",
    outputPath.toString(),
  ];
  await runCommand("ffmpeg", args);
}

export async function concatAudioFiles({ files, outputPath, workDir }) {
  const concatPath = path.join(workDir, "voice-list.txt");
  const lines = files.map((file) => `file '${escapeConcatPath(file.path)}'`);
  await writeFile(concatPath, lines.join("\n"), "utf8");
  await runCommand("ffmpeg", [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", concatPath,
    "-c:a", "pcm_s16be",
    outputPath.toString(),
  ]);
}

export async function probeMediaDuration(filePath) {
  const output = await runCommand("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath.toString(),
  ], { captureStdout: true });
  const duration = Number.parseFloat(output.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Unable to probe media duration: ${filePath}`);
  }
  return duration;
}

function escapeConcatPath(path) {
  return path.toString().replaceAll("'", "'\\''");
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(options.captureStdout ? stdout : undefined);
      else reject(new Error(`${command} exited with ${code}: ${stderr.trim().slice(-2000)}`));
    });
  });
}
