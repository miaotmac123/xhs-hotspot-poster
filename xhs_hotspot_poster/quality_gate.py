from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from .config import AppConfig
from .quality_config import merge_quality_profile


def evaluate_post(post: dict[str, Any], config: AppConfig) -> dict[str, Any]:
    merged = merge_quality_profile(config.data)
    tier = str(merged.get("effective_quality_tier") or merged.get("quality_tier") or "standard")
    video_cfg = merged.get("video_generation") or {}
    checks: list[dict[str, Any]] = []
    score = 100

    def add_check(name: str, status: str, message: str, *, weight: int = 10) -> None:
        nonlocal score
        checks.append({"name": name, "status": status, "message": message})
        if status == "fail":
            score -= weight
        elif status == "warn":
            score -= max(2, weight // 2)

    title = ""
    options = post.get("title_options") or []
    if isinstance(options, list) and options:
        title = str(options[0])
    add_check("title_present", "pass" if title.strip() else "fail", "需要至少一个标题候选")
    if title and len(title) > 28:
        add_check("title_length", "warn", "标题偏长，发布前建议再压缩")

    body = str(post.get("body", "")).strip()
    add_check("body_present", "pass" if len(body) >= 80 else "warn", "正文较短，图文吸引力可能不足")

    cover_text = str(post.get("cover_text", "")).strip()
    if cover_text and len(cover_text) > 12:
        add_check("cover_text_length", "fail", "封面字建议不超过 12 个字")
    elif not cover_text:
        add_check("cover_text_present", "warn", "未设置封面大字")

    plan = post.get("video_plan") if isinstance(post.get("video_plan"), dict) else {}
    voiceover = str(plan.get("voiceover", "")).strip()
    lines = [line for line in re.split(r"[\n。！？!?；;]+", voiceover) if line.strip()]
    if not voiceover:
        add_check("video_voiceover", "warn", "尚未生成视频口播稿")
    else:
        long_lines = [line for line in lines if len(line.strip()) > 24]
        if long_lines:
            add_check("video_line_length", "warn", f"有 {len(long_lines)} 句口播偏长，字幕可能换行过多")
        seed = post.get("video_script_seed") if isinstance(post.get("video_script_seed"), dict) else {}
        hook = str(seed.get("hook_line", "")).strip() or (lines[0] if lines else "")
        add_check("video_hook", "pass" if hook else "warn", "建议有明确前 3 秒钩子句")

    generated_video = post.get("generated_video") if isinstance(post.get("generated_video"), dict) else {}
    if generated_video.get("path"):
        provider = str(generated_video.get("voice_provider") or video_cfg.get("voice_provider") or "")
        if tier in {"standard", "publish"} and provider == "macos_say":
            add_check("tts_provider", "warn", "发布档建议使用腾讯云 TTS，而非 macOS say")
        elif provider == "tencent_tts":
            add_check("tts_provider", "pass", "已使用腾讯云 TTS")
        scenes = (post.get("video_plan") or {}).get("scenes") or []
        with_bg = sum(1 for scene in scenes if scene.get("backgroundImagePath"))
        if scenes and with_bg == 0:
            add_check("video_background", "warn", "视频未使用远程/生成背景图")
        elif with_bg:
            add_check("video_background", "pass", f"{with_bg}/{len(scenes)} 个分镜有背景图")
    else:
        add_check("video_output", "warn", "尚未生成视频文件")

    image = post.get("generated_image") if isinstance(post.get("generated_image"), dict) else {}
    if tier == "publish" and not image.get("path"):
        add_check("cover_image", "warn", "发布档建议生成封面或配图")

    topic_blob = f"{post.get('selected_topic', '')} {body} {' '.join(post.get('hashtags', []))}"
    if re.search(r"股|楼|房|经济|利率|投资", topic_blob):
        risks = post.get("risk_notes") or []
        if not risks:
            add_check("risk_notes", "warn", "财经/房产类建议保留风险提示")

    if post.get("content_origin") == "x_paste":
        evaluate_x_paste_post(post, checks, add_check)

    evaluate_writing_pipeline(post, checks, add_check)

    fail_count = sum(1 for item in checks if item["status"] == "fail")
    warn_count = sum(1 for item in checks if item["status"] == "warn")
    if post.get("content_origin") == "x_paste":
        publish_ready = fail_count == 0 and len(str(post.get("body", "")).strip()) >= 80
        wechat = (post.get("platform_packages") or {}).get("wechat") if isinstance(post.get("platform_packages"), dict) else {}
        if wechat:
            publish_ready = publish_ready and len(str(wechat.get("body", "")).strip()) >= 120
    else:
        publish_ready = fail_count == 0 and len(body) >= 80
        wp = post.get("writing_pipeline") if isinstance(post.get("writing_pipeline"), dict) else {}
        if wp.get("enabled"):
            proofread_score = wp.get("proofread_score")
            if proofread_score is not None and int(proofread_score) < int((wp.get("proofread") or {}).get("pass_score", 85)):
                publish_ready = False
            critique_scores = wp.get("critique_scores") or []
            pass_score = int(wp.get("critique_pass_score", 70))
            if critique_scores and max(int(item) for item in critique_scores) < pass_score:
                publish_ready = False
        if tier == "publish" and video_cfg.get("enabled", True):
            if generated_video.get("path") and generated_video.get("voice_provider") == "macos_say":
                publish_ready = False

    return {
        "score": max(0, min(100, score)),
        "tier": tier,
        "checks": checks,
        "publish_ready": bool(publish_ready),
        "summary": f"{fail_count} 项未通过，{warn_count} 项待优化",
        "evaluated_at": datetime.now().isoformat(timespec="seconds"),
    }


def evaluate_x_paste_post(
    post: dict[str, Any],
    checks: list[dict[str, Any]],
    add_check: Any,
) -> None:
    source = post.get("source_material") if isinstance(post.get("source_material"), dict) else {}
    raw_text = str(source.get("raw_text", "")).strip()
    add_check("source_present", "pass" if len(raw_text) >= 80 else "fail", "需要保留完整原文作为搬运依据")

    xhs = (post.get("platform_packages") or {}).get("xiaohongshu") if isinstance(post.get("platform_packages"), dict) else {}
    wechat = (post.get("platform_packages") or {}).get("wechat") if isinstance(post.get("platform_packages"), dict) else {}
    attr = str(xhs.get("attribution_line") or wechat.get("attribution_line") or "").strip()
    add_check("attribution_present", "pass" if attr else "fail", "搬运稿必须带来源标注")

    if post.get("repurpose_error"):
        add_check("repurpose_error", "fail", "忠实本地化失败，请重试或人工编辑")

    if post.get("manual_review_required", True):
        add_check("manual_review", "warn", "搬运内容默认需人工审核后再发布")


def evaluate_writing_pipeline(
    post: dict[str, Any],
    checks: list[dict[str, Any]],
    add_check: Any,
) -> None:
    wp = post.get("writing_pipeline") if isinstance(post.get("writing_pipeline"), dict) else {}
    if not wp.get("enabled"):
        return

    proofread_score = wp.get("proofread_score")
    pass_score = int((wp.get("proofread") or {}).get("pass_score", 85))
    if proofread_score is not None:
        status = "pass" if int(proofread_score) >= pass_score else "fail"
        add_check(
            "proofread_score",
            status,
            f"AI腔检测 {proofread_score}/{pass_score} 分",
            weight=12,
        )

    critique_scores = wp.get("critique_scores") or []
    critique_pass = int(wp.get("critique_pass_score", 70))
    if critique_scores:
        best = max(int(item) for item in critique_scores)
        status = "pass" if best >= critique_pass else "fail"
        trail = "→".join(str(item) for item in critique_scores)
        add_check("critique_score", status, f"评委 {trail}（及格 {critique_pass}）", weight=12)

    if wp.get("critique_error"):
        add_check("critique_error", "warn", "评委循环未完成，请人工复核")
