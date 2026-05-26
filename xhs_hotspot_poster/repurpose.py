from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from .config import AppConfig
from .generator import parse_json_object
from .ingestion.paste import build_source_from_paste
from .content_pipeline import run_writing_pipeline
from .openai_client import OpenAIError, create_response
from .writing_style import style_prompt_block, style_system_suffix


def build_repurpose_system_prompt(config: AppConfig) -> str:
    base = """你是中文本地化编辑，不是热点策划人。
任务：把用户提供的 X（Twitter）原文，忠实翻译并改写成适合中文平台发布的稿件。
要求：
- 以原文为唯一事实来源，禁止编造新数据、新引语、新事件、新结论。
- 允许：翻译、口语化、分段、标题优化、平台排版；不允许：大幅偏离原意的发挥。
- 保留原文的信息结构；若原文是串文/列表，用清晰的小标题或分段体现顺序。
- 小红书版要短、好读、信息清楚；禁止营销号浮夸腔，不要震惊体标题。
- 公众号版可稍长，但仍需忠实、克制。
- 两个版本文末都必须包含 attribution_line（来源说明）。
- 输出必须是严格 JSON，不要 Markdown，不要代码块。
"""
    return base + style_system_suffix(config.data, platform="xiaohongshu")


def repurpose_config(config: AppConfig) -> dict[str, Any]:
    return config.data.get("repurpose") or {}


def repurpose_temperature(config: AppConfig) -> float:
    repurpose = repurpose_config(config)
    if "temperature" in repurpose:
        return float(repurpose["temperature"])
    return 0.35


def default_targets(config: AppConfig) -> list[str]:
    repurpose = repurpose_config(config)
    targets = repurpose.get("targets_default") or ["xiaohongshu", "wechat"]
    return [str(item) for item in targets if str(item) in {"xiaohongshu", "wechat"}] or ["xiaohongshu", "wechat"]


def build_repurpose_prompt(source_material: dict[str, Any], config: AppConfig, targets: list[str]) -> str:
    return json.dumps(
        {
            "account_profile": config.data.get("profile", {}),
            "targets": targets,
            "source_material": source_material,
            "writing_style": style_prompt_block(config.data, platform="xiaohongshu"),
            "hard_rules": [
                "禁止添加原文没有的事实。",
                "如果原文信息不完整，在 risk_notes 里说明，不要自行补全。",
                "attribution_line 必须包含作者或原文链接（若提供）。",
                "cover_text 不超过 12 个汉字。",
                "小红书标题与正文遵守 writing_style，禁止浮夸营销号语气。",
            ],
            "output_schema": {
                "source_summary": "用中文概括原文核心，3-5 句",
                "risk_notes": ["需要人工核实的点"],
                "publish_checklist": ["发布前检查项"],
                "xiaohongshu": {
                    "title_options": ["标题1", "标题2", "标题3"],
                    "body": "小红书正文，分段",
                    "cover_text": "封面字",
                    "hashtags": ["#话题1", "#话题2"],
                    "attribution_line": "来源：...",
                },
                "wechat": {
                    "title": "公众号标题",
                    "summary": "摘要 80-120 字",
                    "body": "公众号正文，可用小标题",
                    "sections": [{"heading": "小标题", "content": "段落"}],
                    "attribution_line": "来源：...",
                },
            },
        },
        ensure_ascii=False,
        indent=2,
    )


def repurpose_from_source(
    config: AppConfig,
    source_material: dict[str, Any],
    *,
    targets: list[str] | None = None,
) -> dict[str, Any]:
    chosen_targets = targets or default_targets(config)
    prompt = build_repurpose_prompt(source_material, config, chosen_targets)
    text = create_response(
        model=config.model,
        instructions=build_repurpose_system_prompt(config),
        input_text=prompt,
        temperature=repurpose_temperature(config),
    )
    parsed = parse_json_object(text)
    parsed["mode"] = "faithful_localize"
    parsed["model"] = config.model
    parsed["targets"] = chosen_targets
    parsed["generated_at"] = datetime.now().isoformat(timespec="seconds")
    return normalize_repurpose_result(parsed, source_material)


def import_and_repurpose_paste(
    config: AppConfig,
    raw_text: str,
    *,
    author: str = "",
    source_url: str = "",
    language: str = "auto",
    targets: list[str] | None = None,
) -> dict[str, Any]:
    ingestion = config.data.get("ingestion") or {}
    x_cfg = ingestion.get("x_paste") or {}
    min_chars = int(x_cfg.get("min_chars", 80))
    source_material = build_source_from_paste(
        raw_text,
        author=author,
        source_url=source_url,
        language=language,
        min_chars=min_chars,
    )
    try:
        repurpose = repurpose_from_source(config, source_material, targets=targets)
        post = build_post_from_import(source_material, repurpose)
        try:
            post = run_writing_pipeline(post, config)
        except OpenAIError as exc:
            post["writing_pipeline_error"] = str(exc)[:500]
        return post
    except (OpenAIError, ValueError) as exc:
        return build_post_from_import_error(source_material, str(exc))


def normalize_repurpose_result(parsed: dict[str, Any], source_material: dict[str, Any]) -> dict[str, Any]:
    xhs = parsed.get("xiaohongshu") if isinstance(parsed.get("xiaohongshu"), dict) else {}
    wechat = parsed.get("wechat") if isinstance(parsed.get("wechat"), dict) else {}
    author = source_material.get("author") or ""
    url = source_material.get("source_url") or ""
    default_attr = build_attribution_line(author, url)

    xhs["attribution_line"] = str(xhs.get("attribution_line") or default_attr).strip() or default_attr
    wechat["attribution_line"] = str(wechat.get("attribution_line") or default_attr).strip() or default_attr
    xhs["title_options"] = normalize_titles(xhs.get("title_options"))
    xhs["body"] = append_attribution(str(xhs.get("body", "")).strip(), xhs["attribution_line"])
    xhs["cover_text"] = str(xhs.get("cover_text", "")).strip()[:12]
    xhs["hashtags"] = normalize_hashtags(xhs.get("hashtags"))

    wechat["title"] = str(wechat.get("title") or xhs["title_options"][0] or source_material.get("title_hint") or "公众号稿").strip()
    wechat["summary"] = str(wechat.get("summary", "")).strip()
    wechat["body"] = append_attribution(str(wechat.get("body", "")).strip(), wechat["attribution_line"])
    if not wechat["body"] and isinstance(wechat.get("sections"), list):
        wechat["body"] = append_attribution(sections_to_body(wechat["sections"]), wechat["attribution_line"])

    parsed["xiaohongshu"] = xhs
    parsed["wechat"] = wechat
    parsed["source_summary"] = str(parsed.get("source_summary", "")).strip()
    parsed["risk_notes"] = normalize_string_list(parsed.get("risk_notes"))
    parsed["publish_checklist"] = normalize_publish_checklist(parsed.get("publish_checklist"))
    return parsed


def build_post_from_import(source_material: dict[str, Any], repurpose: dict[str, Any]) -> dict[str, Any]:
    xhs = repurpose.get("xiaohongshu") or {}
    wechat = repurpose.get("wechat") or {}
    title = xhs.get("title_options", ["X 搬运稿"])[0]
    return {
        "content_origin": "x_paste",
        "selected_topic": title,
        "angle": repurpose.get("source_summary", ""),
        "title_options": xhs.get("title_options", []),
        "body": xhs.get("body", ""),
        "cover_text": xhs.get("cover_text", ""),
        "image_ideas": [
            "保留原文信息结构，封面不依赖他人肖像",
            "用抽象场景或信息图风格配图",
            "发布前核对来源标注",
        ],
        "hashtags": xhs.get("hashtags", []),
        "risk_notes": repurpose.get("risk_notes", []),
        "publish_checklist": repurpose.get("publish_checklist", []),
        "source_material": source_material,
        "repurpose": repurpose,
        "platform_packages": {
            "xiaohongshu": {
                "title": title,
                "body": xhs.get("body", ""),
                "hashtags": xhs.get("hashtags", []),
                "cover_text": xhs.get("cover_text", ""),
                "attribution_line": xhs.get("attribution_line", ""),
            },
            "wechat": {
                "title": wechat.get("title", ""),
                "summary": wechat.get("summary", ""),
                "body": wechat.get("body", ""),
                "attribution_line": wechat.get("attribution_line", ""),
            },
        },
        "manual_review_required": True,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "model": repurpose.get("model", ""),
    }


def build_post_from_import_error(source_material: dict[str, Any], error: str) -> dict[str, Any]:
    return {
        "content_origin": "x_paste",
        "selected_topic": source_material.get("title_hint", "X 搬运稿"),
        "angle": "搬运生成失败，请检查 API 或稍后重试。",
        "title_options": [source_material.get("title_hint", "X 搬运稿")],
        "body": source_material.get("raw_text", "")[:2000],
        "cover_text": "搬运稿",
        "hashtags": [],
        "risk_notes": ["原文仅作暂存，尚未完成忠实本地化。", error[:300]],
        "publish_checklist": ["确认版权与转载规则", "补充来源标注", "人工润色后再发布"],
        "source_material": source_material,
        "repurpose_error": error[:1000],
        "manual_review_required": True,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "model": "import_error",
    }


def build_attribution_line(author: str, url: str) -> str:
    parts = []
    if author:
        parts.append(f"来源：{author}")
    if url:
        parts.append(f"原文：{url}")
    return " · ".join(parts) if parts else "来源：X 原文搬运，发布前请核对"


def append_attribution(body: str, attribution_line: str) -> str:
    if not body:
        return attribution_line
    if attribution_line and attribution_line in body:
        return body
    return f"{body.rstrip()}\n\n{attribution_line}".strip()


def normalize_titles(value: object) -> list[str]:
    if not isinstance(value, list):
        return ["X 搬运稿"]
    titles = [str(item).strip() for item in value if str(item).strip()]
    return titles[:3] or ["X 搬运稿"]


def normalize_hashtags(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    tags: list[str] = []
    for item in value:
        tag = str(item).strip()
        if not tag:
            continue
        if not tag.startswith("#"):
            tag = f"#{tag.lstrip('#')}"
        tags.append(tag)
    return tags[:8]


def normalize_string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()][:6]


def normalize_publish_checklist(value: object) -> list[str]:
    defaults = ["确认已获得转载授权或符合平台规则", "核对来源标注", "检查是否有敏感表述"]
    extra = normalize_string_list(value)
    merged = defaults + [item for item in extra if item not in defaults]
    return merged[:8]


def sections_to_body(sections: object) -> str:
    if not isinstance(sections, list):
        return ""
    blocks: list[str] = []
    for item in sections:
        if not isinstance(item, dict):
            continue
        heading = str(item.get("heading", "")).strip()
        content = str(item.get("content", "")).strip()
        if heading and content:
            blocks.append(f"## {heading}\n\n{content}")
        elif content:
            blocks.append(content)
    return "\n\n".join(blocks).strip()
