from __future__ import annotations

import json
import re
from typing import Any

from .config import AppConfig
from .generator import parse_json_object
from .openai_client import OpenAIError, create_response


SYSTEM_PROMPT = """你是资深中文短视频口播策划。
任务：根据热点草稿，写一段适合 9:16 竖屏口播视频的分析稿。
要求：
- 这是“听”的内容，不是图文笔记；不要照搬正文长段落。
- 前 3 秒必须有强钩子句（好奇、反差、数字或提问）。
- 每句口播尽量短，适合字幕，单句不超过 22 个汉字。
- 全稿 6-10 句，总时长控制在 35-50 秒口播感。
- 财经、房产、股市必须有一句风险提示，不做买卖建议。
- 不编造新闻事实；不确定的表述要留余地。
- 输出必须是严格 JSON，不要 Markdown，不要代码块。
"""


def video_script_enabled(config: AppConfig) -> bool:
    video = config.data.get("video_generation") or {}
    return bool(video.get("use_llm_video_script", True))


def build_video_script_prompt(post: dict[str, Any], config: AppConfig) -> str:
    style = str((config.data.get("video_generation") or {}).get("style_preset") or post.get("video_style_preset") or "xiaohongshu")
    return json.dumps(
        {
            "account_profile": config.data.get("profile", {}),
            "style_preset": style,
            "selected_topic": post.get("selected_topic", ""),
            "angle": post.get("angle", ""),
            "title_options": post.get("title_options", [])[:3],
            "body_excerpt": str(post.get("body", ""))[:1200],
            "hashtags": post.get("hashtags", [])[:6],
            "risk_notes": post.get("risk_notes", [])[:4],
            "output_schema": {
                "hook_line": "前3秒钩子，一句",
                "voiceover_lines": ["短句口播1", "短句口播2"],
                "scene_hints": [
                    {
                        "title": "分镜标题",
                        "subtitle": "屏幕短字幕",
                        "keywords": ["关键词1", "关键词2"],
                    }
                ],
                "risk_reminder": "可选风险提示一句",
            },
        },
        ensure_ascii=False,
        indent=2,
    )


def normalize_video_script_seed(raw: dict[str, Any]) -> dict[str, Any]:
    hook = clean_line(raw.get("hook_line", ""))
    lines = [clean_line(item) for item in raw.get("voiceover_lines", []) if clean_line(item)]
    if hook and (not lines or lines[0] != hook):
        lines = [hook, *[line for line in lines if line != hook]]
    if not lines and hook:
        lines = [hook]
    if len(lines) < 4:
        lines = pad_short_script(lines, raw)

    hints = []
    for item in raw.get("scene_hints", [])[:9]:
        if not isinstance(item, dict):
            continue
        hints.append(
            {
                "title": clean_line(item.get("title", "")) or "要点",
                "subtitle": clean_line(item.get("subtitle", "")) or clean_line(lines[min(len(hints), len(lines) - 1)]),
                "keywords": normalize_keywords(item.get("keywords", [])),
            }
        )

    risk = clean_line(raw.get("risk_reminder", ""))
    if risk and (not lines or risk not in lines[-1]):
        if len(lines) >= 9:
            lines[-1] = risk
        else:
            lines.append(risk)

    return {
        "hook_line": hook or (lines[0] if lines else ""),
        "voiceover_lines": lines[:10],
        "scene_hints": hints,
        "risk_reminder": risk,
        "provider": raw.get("provider", "llm"),
        "model": raw.get("model", ""),
        "generation_error": raw.get("generation_error", ""),
    }


def generate_video_script_seed(config: AppConfig, post: dict[str, Any]) -> dict[str, Any]:
    if not video_script_enabled(config):
        return normalize_video_script_seed(fallback_video_script_seed(post, reason="llm_disabled"))

    prompt = build_video_script_prompt(post, config)
    try:
        text = create_response(
            model=config.model,
            instructions=SYSTEM_PROMPT,
            input_text=prompt,
            temperature=min(config.temperature, 0.75),
        )
        parsed = parse_json_object(text)
        parsed["provider"] = "llm"
        parsed["model"] = config.model
        return normalize_video_script_seed(parsed)
    except (OpenAIError, ValueError) as exc:
        seed = fallback_video_script_seed(post, reason=str(exc))
        seed["generation_error"] = str(exc)[:300]
        return seed


def fallback_video_script_seed(post: dict[str, Any], *, reason: str = "") -> dict[str, Any]:
    topic = clean_line(post.get("selected_topic", "")) or "今日热点"
    title = ""
    options = post.get("title_options") or []
    if isinstance(options, list) and options:
        title = clean_line(options[0])
    hook = title or f"今天这条{topic}，别只看热闹。"
    lines = [
        hook,
        f"先说结论：{topic}，普通人先盯三件事。",
        "第一，这件事和你有没有直接关系。",
        "第二，哪些信息还需要再核实。",
        "第三，能不能变成自己的行动清单。",
        "热点会过去，判断方法要留下。",
    ]
    risks = post.get("risk_notes") or []
    if risks:
        lines.append(clean_line(str(risks[0]))[:44])
    return normalize_video_script_seed(
        {
            "hook_line": hook,
            "voiceover_lines": lines,
            "scene_hints": [],
            "risk_reminder": clean_line(str(risks[0])) if risks else "",
            "provider": "template_fallback",
            "model": "template_fallback",
            "generation_error": reason[:300] if reason else "",
        }
    )


def clean_line(value: object) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    text = re.sub(r"^[#\-*\d.、\s]+", "", text)
    return text[:120]


def normalize_keywords(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value:
        word = clean_line(item).replace("#", "")
        if word and word not in result:
            result.append(word[:8])
        if len(result) >= 3:
            break
    return result or ["热点", "观察"]


def pad_short_script(lines: list[str], raw: dict[str, Any]) -> list[str]:
    padded = list(lines)
    fillers = [
        "先把情绪放一边，我们看事实。",
        "别急着站队，先看数据有没有更新。",
        "真正有用的，是能落地的提醒。",
    ]
    for filler in fillers:
        if len(padded) >= 6:
            break
        if filler not in padded:
            padded.append(filler)
    if not padded:
        topic = clean_line(raw.get("selected_topic", "")) or "热点"
        padded = [f"今天聊{topic}。"]
    return padded
