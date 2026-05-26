from __future__ import annotations

from typing import Any


DEFAULT_WRITING_STYLE: dict[str, Any] = {
    "tone": "克制、具体、像朋友聊天；有信息密度，不喊口号",
    "temperature": 0.6,
    "avoid_phrases": [
        "震撼",
        "绝了",
        "封神",
        "天花板",
        "神仙",
        "必看",
        "爆哭",
        "我不允许你不知道",
        "教科书级",
        "全网疯传",
        "家人们谁懂啊",
        "姐妹们冲",
        "狠狠",
        "绝绝子",
        "YYDS",
        "一整个",
    ],
    "title_rules": [
        "标题用陈述或具体问题，信息点明确",
        "不用连续感叹号，不用「震惊」「爆」「必看」",
        "不标题党，不夸大效果",
    ],
    "body_rules": [
        "短段落，一段一个意思；优先具体事实、数字、步骤",
        "少用 emoji，不用堆砌；不用「家人们」「姐妹们」开头",
        "不用「首先其次最后」套话堆满全文",
        "结尾可一句收束，不要煽动转发",
    ],
    "xiaohongshu_rules": [
        "像真人笔记：经历 + 观察 + 可执行建议",
        "可收藏，但不要用「建议收藏」当正文主旋律",
    ],
}


def writing_style_config(data: dict[str, Any]) -> dict[str, Any]:
    custom = data.get("writing_style")
    if not isinstance(custom, dict):
        return dict(DEFAULT_WRITING_STYLE)
    merged = dict(DEFAULT_WRITING_STYLE)
    for key, value in custom.items():
        if value is not None and value != "":
            merged[key] = value
    return merged


def generation_temperature(data: dict[str, Any], default: float) -> float:
    style = writing_style_config(data)
    if "temperature" in style:
        return float(style["temperature"])
    generation = data.get("generation") if isinstance(data.get("generation"), dict) else {}
    return float(generation.get("temperature", default))


def style_prompt_block(data: dict[str, Any], *, platform: str = "xiaohongshu") -> dict[str, Any]:
    style = writing_style_config(data)
    rules = list(style.get("title_rules") or []) + list(style.get("body_rules") or [])
    if platform == "xiaohongshu":
        rules.extend(style.get("xiaohongshu_rules") or [])
    avoid = style.get("avoid_phrases") or []
    return {
        "tone": style.get("tone", ""),
        "avoid_phrases": avoid,
        "style_rules": rules,
    }


def style_system_suffix(data: dict[str, Any], *, platform: str = "xiaohongshu") -> str:
    block = style_prompt_block(data, platform=platform)
    avoid = "、".join(str(item) for item in block.get("avoid_phrases", [])[:16])
    rules = "\n".join(f"- {rule}" for rule in block.get("style_rules", [])[:12])
    return (
        f"\n文风（必须遵守）：{block.get('tone', '')}\n"
        f"禁用词/套路（不要出现）：{avoid}\n"
        f"写作规则：\n{rules}"
    )
