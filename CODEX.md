# CODEX.md

This repo is a local controlled-cost automated content operations system. It started as a Xiaohongshu draft tool, but should now be treated as a platform-neutral hotspot-to-content/video system for controlled passive-income experiments.

## Start Here

- Read `docs/architecture-quality-roadmap.md` before implementing quality upgrades, multi-platform packages, X/YouTube ingestion, or ops automation. It is the canonical implementation roadmap (phases A–E).
- Read `docs/content-engine-architecture.md` before changing architecture, video, image providers, UI behavior, generation cost, or data model.
- Read `docs/business-goal-low-cost-content-ops.md` before changing product direction, platform strategy, monetization assumptions, or data model.
- Read `docs/dashboard-redesign-spec.md` before changing the Web dashboard layout or interactions.
- Use the local project skill `hotspot-content-engine` for this repo: `/Users/zhangmiao/.codex/skills/hotspot-content-engine`.

## Useful Skills

- `hotspot-content-engine`: use for hotspot fetching, content generation, Web dashboard changes, image providers, video rendering, cache cleanup, and publishing packages in this project.
- `git-github-workflow`: use for Git initialization, `.gitignore` checks, safe commits, remotes, and GitHub pushes across projects.

Do not load every skill by default. Load a skill when the task names it or clearly matches its scope.

## Project Boundaries

- Python owns orchestration, hotspot fetching, LLM draft generation, local Web APIs, cover generation, storage, and publishing packages.
- Node.js owns video generation. Keep core video logic in `video-renderer/src/`.
- Web files only provide review/edit/trigger UI: `web/index.html`, `web/app.js`, `web/styles.css`.
- Draft JSON files under `output/YYYY-MM-DD/*.json` are the source of truth.
- Do not delete draft JSON, Markdown drafts, publish packages, or user-uploaded files unless the user explicitly asks.

## Roadmap Status

Planned but not necessarily implemented yet (check `docs/architecture-quality-roadmap.md` progress checkboxes):

- Phase A: LLM video script, publish-tier TTS, image scoring, quality gate
- Phase B: `content_brief`, cover publish tier
- Phase C: `platform_packages` for 小红书 / 视频号 / 抖音 / 今日头条
- Phase D: X/YouTube reference ingestion (`source_references`, rewrite-only)
- Phase E: semi-auto ops (review queue, calendar, publisher adapters)

## Important Paths

- `docs/architecture-quality-roadmap.md`: quality and multi-platform implementation roadmap.
- `xhs_hotspot_poster/cli.py`: command entry point.
- `xhs_hotspot_poster/trends.py`: hotspot fetching.
- `xhs_hotspot_poster/generator.py`: LLM prompt/schema/fallback logic.
- `xhs_hotspot_poster/video_script.py`: LLM video voiceover seed generation.
- `xhs_hotspot_poster/quality_gate.py`: publish readiness checks and `quality_report`.
- `xhs_hotspot_poster/quality_config.py`: merges `quality_profiles` by `quality_tier`.
- `xhs_hotspot_poster/images.py`: cover/image generation.
- `xhs_hotspot_poster/web.py`: local dashboard API and asset serving.
- `xhs_hotspot_poster/video_bridge.py`: thin Python-to-Node bridge.
- `video-renderer/src/render.js`: video CLI entry point.
- `video-renderer/src/video-plan.js`: video script, scenes, subtitles.
- `video-renderer/src/image-assets.js`: Tencent WIMGS and other image providers.
- `video-renderer/src/cards.js`: 9:16 scene card rendering.
- `video-renderer/src/tts.js`: TTS provider layer.
- `video-renderer/src/ffmpeg.js`: final MP4 composition.

## Cost And Quality Rules

- Do not run paid or quota-bound providers unless the user asks.
- Before any new paid provider integration or paid smoke test, stop and confirm: provider, model id, endpoint, unit cost, maximum calls for this run, fallback policy, and whether a real paid call is allowed.
- `python3 -m xhs_hotspot_poster --once` can call the LLM.
- Web “生成今日热点” can call the LLM.
- OpenAI image generation can cost money.
- Tencent WIMGS can cost money; current estimate is about 0.06 RMB per image-search call.
- Full video generation may call Tencent WIMGS or Jimeng/Volcengine depending on config.
- Jimeng/Volcengine image generation uses Ark image models. Current known working model is `doubao-seedream-4-5-251128`; size must be at least 3686400 pixels, so use `1440x2560` for 9:16 source images and downscale in video.
- Prefer `--dry-run`, `node --check`, and zero-cost video configs for code verification.
- Do not confuse low cost with no cost. For publishable output, choose providers by quality, bounded cost, and measurable ROI.

## Token Hygiene

- Use `rg` to locate relevant functions before opening whole files.
- Avoid printing full draft JSON, generated video JSON, provider prompts, signed image URLs, or full `background_attempts` in chat. Summarize provider, model, status, error code, request id, call count, and estimated cost.
- For paid provider failures, inspect the first error only unless the user asks for full logs.
- Browser verification is optional. If the user only needs a URL, start the server and provide the URL. Use Browser only for UI verification, screenshots, or user-visible interaction.
- Prefer one zero-cost validation, then one bounded paid smoke test, then ask before scaling to multiple assets.

## Low-Cost Verification

Run from repo root:

```bash
python3 -m compileall -q xhs_hotspot_poster
python3 -m xhs_hotspot_poster --config config.json --dry-run
node --check web/app.js
node --check video-renderer/src/render.js
node --check video-renderer/src/video-plan.js
node --check video-renderer/src/image-assets.js
node --check video-renderer/src/cards.js
node --check video-renderer/src/tts.js
node --check video-renderer/src/ffmpeg.js
```

Or run the skill helper:

```bash
/Users/zhangmiao/.codex/skills/hotspot-content-engine/scripts/health_check.sh
```

## Local Server

```bash
python3 -m xhs_hotspot_poster --serve
```

Default URL is `http://127.0.0.1:8765`, but the user may run another port such as `9876`.

## Product Rules

- The system should generate content from current hotspots, not keep recycling stale titles.
- Text posts and video scripts are different assets. Do not directly turn the article body into voiceover.
- Video narration should be short spoken analysis with clean subtitle segments.
- The video flow should be: generate/read script, show editable script, save script, render video, preview video.
- macOS `say` is only a flow-verification TTS provider. Better voice quality should be added as a provider adapter.
- Remote images must be scored and filtered; bad images should be rejected, not hidden behind black overlays.
- UI state must be stable. Generating covers, videos, or errors must not jump back to the first draft.
- Errors should persist visibly on the selected draft.

## Cleanup Rules

Usually safe to remove:

- `__pycache__/`
- intermediate scene card files
- per-segment `.aiff` voice files
- remote image cache
- stale generated videos/subtitles/audio only when no current draft JSON references them

Do not remove by default:

- `output/**/*.json`
- `output/**/*.md`
- `publish_packages/`
- uploaded images
- final assets referenced by draft JSON
