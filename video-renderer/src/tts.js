import { spawn } from "node:child_process";
import path from "node:path";

export async function synthesizeVoiceover({ text, outputPath, voiceName, rate }) {
  const preferred = voiceName || "Flo (中文（中国大陆）)";
  try {
    await runSay({ text, outputPath, voiceName: preferred, rate });
    return { path: outputPath, voiceName: preferred };
  } catch (error) {
    if (!preferred) throw error;
    await runSay({ text, outputPath, voiceName: "", rate });
    return { path: outputPath, voiceName: "system_default", fallbackFrom: preferred };
  }
}

export async function synthesizeVoiceoverSegments({ segments, outputDir, slug, voiceName, rate }) {
  const files = [];
  let selectedVoiceName = voiceName || "Flo (中文（中国大陆）)";
  let fallbackFrom = "";
  for (const [index, segment] of segments.entries()) {
    const outputPath = path.join(outputDir, `${slug}-voice-${String(index + 1).padStart(2, "0")}.aiff`);
    try {
      await runSay({ text: segment.text, outputPath, voiceName: selectedVoiceName, rate });
    } catch (error) {
      if (!selectedVoiceName) throw error;
      fallbackFrom = selectedVoiceName;
      selectedVoiceName = "";
      await runSay({ text: segment.text, outputPath, voiceName: selectedVoiceName, rate });
    }
    files.push({ ...segment, path: outputPath });
  }
  return {
    files,
    voiceName: selectedVoiceName || "system_default",
    fallbackFrom: fallbackFrom || undefined,
  };
}

function runSay({ text, outputPath, voiceName, rate }) {
  const args = [];
  if (voiceName) args.push("-v", voiceName);
  if (rate) args.push("-r", String(rate));
  args.push("-o", outputPath.toString(), text);
  return runCommand("say", args);
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
