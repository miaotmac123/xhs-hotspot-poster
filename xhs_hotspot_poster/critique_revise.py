from __future__ import annotations

import json
from typing import Any

from .config import AppConfig
from .generator import parse_json_object
from .openai_client import OpenAIError, create_response
from .writing_style import generation_temperature, style_system_suffix


CRITIQUE_SYSTEM = """你是中文内容质检编辑。给小红书/公众号稿件打分并指出问题。
要求：
- 重点扣分项：AI腔、浮夸营销、空洞形容词、标题党、缺乏具体信息。
- 满分100，70分及格。
- 输出严格 JSON，不要 Markdown。"""


REVISE_SYSTEM = """你是中文内容编辑。根据质检意见修订稿件，降低 AI 味，保持克制具体。
输出必须是严格 JSON，不要 Markdown。"""


def pipeline_config(data: dict[str, Any]) -> dict[str, Any]:
    base = {
        "enabled": True,
        "proofread_enabled": True,
        "critique_enabled": True,
        "pass_score": 70,
        "max_rounds": 2,
    }
    custom = data.get("writing_pipeline")
    if isinstance(custom, dict):
        base.update({key: value for key, value in custom.items() if value is not None})
    return base


def build_critique_prompt(post: dict[str, Any], config: AppConfig) -> str:
    return json.dumps(
        {
            "account_profile": config.data.get("profile", {}),
            "draft": {
                "selected_topic": post.get("selected_topic", ""),
                "title_options": post.get("title_options", []),
                "body": post.get("body", ""),
                "angle": post.get("angle", ""),
            },
            "output_schema": {
                "score": 0,
                "summary": "一句话评语",
                "issues": ["问题1"],
                "must_fix": ["必须修改点"],
            },
        },
        ensure_ascii=False,
        indent=2,
    )


def critique_post(post: dict[str, Any], config: AppConfig) -> dict[str, Any]:
    text = create_response(
        model=config.model,
        instructions=CRITIQUE_SYSTEM + style_system_suffix(config.data),
        input_text=build_critique_prompt(post, config),
        temperature=0.2,
    )
    parsed = parse_json_object(text)
    score = int(parsed.get("score", 0))
    return {
        "score": max(0, min(100, score)),
        "summary": str(parsed.get("summary", "")).strip(),
        "issues": [str(item) for item in (parsed.get("issues") or []) if str(item).strip()][:6],
        "must_fix": [str(item) for item in (parsed.get("must_fix") or []) if str(item).strip()][:6],
    }


def build_revise_prompt(post: dict[str, Any], critique: dict[str, Any], config: AppConfig) -> str:
    return json.dumps(
        {
            "account_profile": config.data.get("profile", {}),
            "critique": critique,
            "draft": {
                "selected_topic": post.get("selected_topic", ""),
                "title_options": post.get("title_options", []),
                "body": post.get("body", ""),
                "cover_text": post.get("cover_text", ""),
                "hashtags": post.get("hashtags", []),
                "angle": post.get("angle", ""),
            },
            "hard_rules": [
                "保留事实，不编造新信息。",
                "去掉 AI 腔和浮夸营销词。",
                "正文短段，具体可执行。",
            ],
            "output_schema": {
                "selected_topic": "可微调",
                "title_options": ["标题1", "标题2", "标题3"],
                "body": "修订后正文",
                "cover_text": "12字内",
                "hashtags": ["#话题"],
                "angle": "切入角度",
            },
        },
        ensure_ascii=False,
        indent=2,
    )


def revise_post(post: dict[str, Any], critique: dict[str, Any], config: AppConfig) -> dict[str, Any]:
    text = create_response(
        model=config.model,
        instructions=REVISE_SYSTEM + style_system_suffix(config.data),
        input_text=build_revise_prompt(post, critique, config),
        temperature=generation_temperature(config.data, 0.5),
    )
    parsed = parse_json_object(text)
    for key in ("selected_topic", "body", "cover_text", "angle"):
        if parsed.get(key):
            post[key] = parsed[key]
    if isinstance(parsed.get("title_options"), list) and parsed["title_options"]:
        post["title_options"] = [str(item).strip() for item in parsed["title_options"] if str(item).strip()][:3]
    if isinstance(parsed.get("hashtags"), list) and parsed["hashtags"]:
        post["hashtags"] = [str(item).strip() for item in parsed["hashtags"] if str(item).strip()][:8]
    return post


def run_critique_loop(post: dict[str, Any], config: AppConfig) -> dict[str, Any]:
    cfg = pipeline_config(config.data)
    pass_score = int(cfg.get("pass_score", 70))
    max_rounds = int(cfg.get("max_rounds", 2))
    scores: list[int] = []
    critiques: list[dict[str, Any]] = []

    current = dict(post)
    for _ in range(max_rounds):
        try:
            critique = critique_post(current, config)
        except (OpenAIError, ValueError):
            break
        critiques.append(critique)
        score = int(critique.get("score", 0))
        scores.append(score)
        if score >= pass_score:
            break
        try:
            current = revise_post(current, critique, config)
        except (OpenAIError, ValueError):
            break

    post.update(current)
    existing = post.get("writing_pipeline") if isinstance(post.get("writing_pipeline"), dict) else {}
    post["writing_pipeline"] = {
        **existing,
        "critique_scores": scores,
        "critiques": critiques[-2:],
        "revised": bool(scores) and (len(scores) > 1 or scores[-1] >= pass_score),
        "critique_pass_score": pass_score,
    }
    return post
