from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from .generator import parse_json_object
from .openai_client import create_response
from .trends import Trend
from .writing_style import generation_temperature, style_system_suffix


BRIEF_SYSTEM = """你是内容策划编辑。根据热点候选，先产出 content_brief，再供下游写小红书稿。
要求：事实克制、角度清晰、不编造；禁止浮夸营销腔。
输出必须是严格 JSON，不要 Markdown。"""


def brief_enabled(config_data: dict[str, Any]) -> bool:
    brief_cfg = config_data.get("content_brief")
    if isinstance(brief_cfg, dict):
        return bool(brief_cfg.get("enabled", False))
    return bool(config_data.get("use_content_brief", False))


def build_brief_prompt(trends: list[Trend], profile: dict[str, Any]) -> str:
    trend_lines = []
    for index, trend in enumerate(trends, start=1):
        extra = f" 来源：{trend.source}"
        if trend.heat:
            extra += f" 热度：{trend.heat}"
        if trend.summary:
            extra += f" 摘要：{trend.summary[:120]}"
        trend_lines.append(f"{index}. {trend.title}{extra}")

    return json.dumps(
        {
            "account_profile": profile,
            "today": datetime.now().strftime("%Y-%m-%d"),
            "hot_topics": trend_lines,
            "output_schema": {
                "selected_topic": "推荐选题",
                "angle": "切入角度",
                "facts": ["可核实事实点"],
                "hook_lines": ["克制开场句"],
                "outline": ["段落要点1", "段落要点2"],
                "title_hooks": ["标题方向1", "标题方向2"],
                "visual_direction": "配图/封面方向",
                "risk_notes": ["风险点"],
                "audience": "目标读者",
            },
        },
        ensure_ascii=False,
        indent=2,
    )


def generate_content_brief(config: Any, trends: list[Trend]) -> dict[str, Any]:
    prompt = build_brief_prompt(trends, config.data.get("profile", {}))
    text = create_response(
        model=config.model,
        instructions=BRIEF_SYSTEM + style_system_suffix(config.data),
        input_text=prompt,
        temperature=generation_temperature(config.data, config.temperature),
    )
    brief = parse_json_object(text)
    brief["generated_at"] = datetime.now().isoformat(timespec="seconds")
    brief["model"] = config.model
    return brief
