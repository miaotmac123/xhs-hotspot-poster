#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeSceneCards } from "./cards.js";
import { concatAudioFiles, probeMediaDuration, renderVideo } from "./ffmpeg.js";
import { attachBackgroundImages } from "./image-assets.js";
import { writeSrtSubtitles } from "./subtitles.js";
import { synthesizeVoiceoverSegments } from "./tts.js";
import {
  applyVoiceoverToPlan,
  buildVideoPlan,
  retimePlanToSegmentDurations,
  videoScriptText,
  voiceoverSegmentsForPlan,
} from "./video-plan.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

main().catch(async (error) => {
  const postPath = parseArgs(process.argv.slice(2)).post;
  if (postPath) {
    try {
      const resolvedPost = path.resolve(PROJECT_ROOT, postPath);
      const post = JSON.parse(await readFile(resolvedPost, "utf8"));
      post.video_generation_error = error.message;
      await writeFile(resolvedPost, `${JSON.stringify(post, null, 2)}\n`, "utf8");
    } catch {
      // Keep the original error as the CLI failure.
    }
  }
  console.error(error.stack || error.message);
  process.exit(1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.post) throw new Error("Missing --post path.");

  const postPath = path.resolve(PROJECT_ROOT, args.post);
  const configPath = path.resolve(PROJECT_ROOT, args.config || "config.json");
  const post = JSON.parse(await readFile(postPath, "utf8"));
  const config = applyQualityProfile(JSON.parse(await readFile(configPath, "utf8")));
  const videoConfig = config.video_generation || {};
  const outputDir = path.join(path.dirname(postPath), "assets");
  await mkdir(outputDir, { recursive: true });

  const slug = `${timestamp()}-${slugify(post.selected_topic || firstTitle(post) || "video")}`;
  let plan = args.fresh || !post.video_plan ? buildVideoPlan(post, config) : post.video_plan;
  if (args.script) {
    plan = applyVoiceoverToPlan(plan, args.script);
  } else if (!args.fresh && post.video_plan?.voiceover) {
    plan = applyVoiceoverToPlan(plan, post.video_plan.voiceover);
  }
  if (args.planOnly) {
    post.video_plan = plan;
    delete post.video_generation_error;
    await writeFile(postPath, `${JSON.stringify(post, null, 2)}\n`, "utf8");
    process.stdout.write(JSON.stringify({ ok: true, video_plan: plan }, null, 2));
    return;
  }
  plan.scenes = await attachBackgroundImages({ scenes: plan.scenes, outputDir, slug, config });
  const audioPath = path.join(outputDir, `${slug}-voice.aiff`);
  const voiceSegments = voiceoverSegmentsForPlan(plan);
  const tts = await synthesizeVoiceoverSegments({
    segments: voiceSegments,
    outputDir,
    slug,
    voiceName: videoConfig.voice_name || "Flo (中文（中国大陆）)",
    rate: videoConfig.voice_rate || 170,
    provider: videoConfig.voice_provider || "macos_say",
    config,
  });
  const segmentDurations = [];
  for (const file of tts.files) {
    segmentDurations.push(await probeMediaDuration(file.path));
  }
  await concatAudioFiles({ files: tts.files, outputPath: audioPath, workDir: outputDir });
  const audioDurationSeconds = await probeMediaDuration(audioPath);
  plan = retimePlanToSegmentDurations(plan, segmentDurations);
  const cards = await writeSceneCards({ plan, outputDir, slug });
  const outputPath = path.join(outputDir, `${slug}-video.mp4`);
  const scriptPath = path.join(outputDir, `${slug}-video-script.txt`);
  const subtitlePath = path.join(outputDir, `${slug}-subtitles.srt`);
  await writeFile(scriptPath, videoScriptText(plan), "utf8");
  await writeSrtSubtitles({ plan, outputPath: subtitlePath });
  await renderVideo({
    cards,
    audioPath,
    outputPath,
    workDir: outputDir,
    fps: Number.parseInt(videoConfig.fps || 30, 10),
    subtitlePath,
    burnSubtitles: Boolean(videoConfig.burn_subtitles),
  });

  const imageUsage = summarizeImageSearchUsage(plan.scenes);
  const ttsCost = Number(tts.estimatedCostCny || 0);
  const imageCost = Number(imageUsage.estimated_cost_cny || 0);

  post.video_plan = plan;
  post.generated_video = {
    path: relativeOutputPath(outputPath),
    provider: "node_local_card_video",
    duration_seconds: plan.durationSeconds,
    audio_duration_seconds: roundNumber(audioDurationSeconds),
    timing_source: plan.timing_source,
    style_preset: plan.stylePreset || videoConfig.style_preset || "xiaohongshu",
    voice_provider: tts.provider || videoConfig.voice_provider || "macos_say",
    voice_name: tts.voiceName,
    voice_type: tts.voiceType,
    voice_codec: tts.codec,
    voice_character_count: tts.characterCount,
    voice_rate: videoConfig.voice_rate || 170,
    tts_estimated_cost_cny: ttsCost,
    estimated_total_cost_cny: roundNumber(ttsCost + imageCost),
    quality_tier: config.effective_quality_tier || config.quality_tier || "standard",
    fallback_from_voice_name: tts.fallbackFrom || undefined,
    script_path: relativeOutputPath(scriptPath),
    subtitle_path: relativeOutputPath(subtitlePath),
    source_assets: cards.flatMap((card) => [relativeOutputPath(card.svgPath), relativeOutputPath(card.imagePath)]),
    background_sources: plan.scenes.map((scene) => scene.backgroundImageSource).filter(Boolean),
    background_attempts: plan.scenes.flatMap((scene) => scene.backgroundImageAttempts || []),
    image_search_usage: imageUsage,
    generated_at: new Date().toISOString().slice(0, 19),
  };
  delete post.video_generation_error;
  await writeFile(postPath, `${JSON.stringify(post, null, 2)}\n`, "utf8");

  process.stdout.write(JSON.stringify({ ok: true, generated_video: post.generated_video }, null, 2));
}

function roundNumber(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--post") args.post = argv[++index];
    else if (item === "--config") args.config = argv[++index];
    else if (item === "--plan-only") args.planOnly = true;
    else if (item === "--fresh") args.fresh = true;
    else if (item === "--script") args.script = argv[++index];
  }
  return args;
}

function timestamp() {
  const now = new Date();
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join("");
}

function slugify(value) {
  return String(value)
    .replace(/[^\w\u4e00-\u9fff-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "video";
}

function firstTitle(post) {
  return Array.isArray(post.title_options) && post.title_options.length ? post.title_options[0] : "";
}

function summarizeImageSearchUsage(scenes) {
  const usage = scenes.reduce((latest, scene) => scene.imageSearchUsage || latest, {});
  return {
    jimeng_calls: usage.jimengCalls || 0,
    jimeng_unit_cost_cny: usage.jimengUnitCostCny || 0.25,
    jimeng_estimated_cost_cny: usage.jimengEstimatedCostCny || 0,
    jimeng_quota_used_before: usage.jimengQuotaUsed || 0,
    jimeng_quota_used_after: (usage.jimengQuotaUsed || 0) + (usage.jimengCalls || 0),
    jimeng_quota_total: usage.jimengQuotaTotal || 0,
    max_jimeng_calls_per_video: usage.maxJimengCalls || 0,
    tencent_wimgs_calls: usage.tencentWimgsCalls || 0,
    tencent_wimgs_estimated_cost_cny: usage.tencentEstimatedCostCny || 0,
    estimated_cost_cny: usage.estimatedCostCny || 0,
    unit_cost_cny: 0.06,
    max_tencent_wimgs_calls_per_video: usage.maxTencentWimgsCalls || 0,
  };
}

function relativeOutputPath(filePath) {
  const outputRoot = path.join(PROJECT_ROOT, "output");
  return path.relative(outputRoot, path.resolve(filePath)).replaceAll(path.sep, "/");
}

function applyQualityProfile(config) {
  const tier = config.quality_tier || "standard";
  const profiles = config.quality_profiles || {};
  const profile = profiles[tier] || {};
  return {
    ...config,
    effective_quality_tier: tier,
    image_generation: {
      ...(config.image_generation || {}),
      ...(profile.image_generation || {}),
    },
    video_generation: {
      ...(config.video_generation || {}),
      ...(profile.video_generation || {}),
    },
  };
}
