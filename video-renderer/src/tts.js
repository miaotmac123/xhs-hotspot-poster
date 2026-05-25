import { spawn } from "node:child_process";
import crypto from "node:crypto";
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

export async function synthesizeVoiceoverSegments({ segments, outputDir, slug, voiceName, rate, provider = "macos_say", config = {} }) {
  if (provider === "tencent_tts") {
    return synthesizeTencentVoiceoverSegments({ segments, outputDir, slug, config });
  }
  if (provider !== "macos_say") {
    throw new Error(`Unsupported TTS provider: ${provider}. Supported providers: macos_say, tencent_tts.`);
  }
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
    provider: "macos_say",
    voiceName: selectedVoiceName || "system_default",
    fallbackFrom: fallbackFrom || undefined,
    estimatedCostCny: 0,
    characterCount: segments.reduce((sum, segment) => sum + String(segment.text || "").length, 0),
  };
}

async function synthesizeTencentVoiceoverSegments({ segments, outputDir, slug, config }) {
  const secretId = process.env.TENCENTCLOUD_SECRET_ID;
  const secretKey = process.env.TENCENTCLOUD_SECRET_KEY;
  if (!secretId || !secretKey) {
    throw new Error("腾讯云 TTS 缺少 TENCENTCLOUD_SECRET_ID 或 TENCENTCLOUD_SECRET_KEY。请先在 .env.local 配置。");
  }

  const videoConfig = config.video_generation || {};
  const files = [];
  let characterCount = 0;
  for (const [index, segment] of segments.entries()) {
    const text = String(segment.text || "").trim();
    if (!text) continue;
    characterCount += text.length;
    const outputPath = path.join(outputDir, `${slug}-voice-${String(index + 1).padStart(2, "0")}.mp3`);
    const response = await tencentCloudRequest({
      secretId,
      secretKey,
      service: "tts",
      host: "tts.tencentcloudapi.com",
      action: "TextToVoice",
      version: "2019-08-23",
      region: videoConfig.tencent_tts_region || "ap-guangzhou",
      payload: {
        Text: text,
        SessionId: `${slug}-${index + 1}-${crypto.randomUUID()}`,
        ModelType: Number(videoConfig.tencent_tts_model_type ?? 1),
        VoiceType: Number(videoConfig.tencent_tts_voice_type ?? 101001),
        Codec: videoConfig.tencent_tts_codec || "mp3",
        SampleRate: Number(videoConfig.tencent_tts_sample_rate ?? 16000),
        Speed: Number(videoConfig.tencent_tts_speed ?? 0),
        Volume: Number(videoConfig.tencent_tts_volume ?? 0),
        EnableSubtitle: false,
      },
    });
    const audio = response.Response?.Audio;
    if (!audio) {
      throw new Error(`腾讯云 TTS 未返回音频：${JSON.stringify(response.Response || {}).slice(0, 500)}`);
    }
    const { writeFile } = await import("node:fs/promises");
    await writeFile(outputPath, Buffer.from(audio, "base64"));
    files.push({ ...segment, path: outputPath });
  }

  if (!files.length) throw new Error("腾讯云 TTS 没有可合成的有效文稿。");
  const unitCostPer10k = Number(videoConfig.tencent_tts_estimated_unit_cost_per_10k_chars ?? 0);
  return {
    files,
    provider: "tencent_tts",
    voiceName: String(videoConfig.tencent_tts_voice_type ?? 101001),
    voiceType: Number(videoConfig.tencent_tts_voice_type ?? 101001),
    codec: videoConfig.tencent_tts_codec || "mp3",
    region: videoConfig.tencent_tts_region || "ap-guangzhou",
    characterCount,
    estimatedCostCny: Math.round((characterCount / 10000) * unitCostPer10k * 10000) / 10000,
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

async function tencentCloudRequest({ secretId, secretKey, service, host, action, version, region, payload }) {
  const algorithm = "TC3-HMAC-SHA256";
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const body = JSON.stringify(payload);
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = "content-type;host;x-tc-action";
  const hashedRequestPayload = sha256(body);
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    hashedRequestPayload,
  ].join("\n");
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [
    algorithm,
    String(timestamp),
    credentialScope,
    sha256(canonicalRequest),
  ].join("\n");
  const secretDate = hmac(`TC3${secretKey}`, date);
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, "tc3_request");
  const signature = hmac(secretSigning, stringToSign, "hex");
  const authorization = `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(`https://${host}`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
      Host: host,
      "X-TC-Action": action,
      "X-TC-Timestamp": String(timestamp),
      "X-TC-Version": version,
      "X-TC-Region": region,
    },
    body,
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`腾讯云 TTS 返回非 JSON：${text.slice(0, 300)}`);
  }
  if (!response.ok || data.Response?.Error) {
    const error = data.Response?.Error;
    throw new Error(`腾讯云 TTS 失败：${error?.Code || response.status} ${error?.Message || text.slice(0, 300)}`);
  }
  return data;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key, value, encoding) {
  return crypto.createHmac("sha256", key).update(value, "utf8").digest(encoding);
}
