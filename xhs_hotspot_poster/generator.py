from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any

from .openai_client import create_response
from .trends import Trend


SYSTEM_PROMPT = """你是一个资深小红书内容策划。
任务：基于热点生成适合小红书发布的中文帖子草稿。
要求：
- hot_topics 第 1 条如果来源是 category，就是本篇必须服务的固定栏目；不得改成完全无关的热点。
- selected_topic 要体现固定栏目，也要尽量结合今天真实热搜或当天可验证的新信息；不要长期复用旧日期、旧事件或旧标题。
- 不编造新闻事实；对热点只做生活化角度、经验、清单、观点或避坑延展。
- 不写夸张承诺，不写医疗、金融、法律等高风险确定性建议。
- 风格真实、有用、有情绪钩子，但不要像硬广。
- 输出必须是严格 JSON，不要 Markdown，不要代码块。
"""


def trends_to_prompt(trends: list[Trend], profile: dict[str, Any], count: int) -> str:
    trend_lines = []
    for index, trend in enumerate(trends[:count], start=1):
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
            "hard_rules": [
                "如果第 1 条 hot_topics 以“栏目｜主题”形式出现，selected_topic 必须服务这个栏目，但标题和正文要尽量结合今天的热搜候选或新的公开信息。",
                "不要把栏目主题机械复述成每天相同的文章；需要给出当天化的切口。",
                "财经、股市、房产内容必须加入非投资建议/非购房建议风险提示。",
            ],
            "output_schema": {
                "selected_topic": "选择的热点标题",
                "angle": "切入角度",
                "title_options": ["标题1", "标题2", "标题3"],
                "body": "小红书正文，分段清晰，适合直接复制",
                "cover_text": "封面大字，12字以内",
                "image_ideas": ["配图建议1", "配图建议2", "配图建议3"],
                "hashtags": ["#话题1", "#话题2"],
                "risk_notes": ["需要人工核实的点"],
                "publish_checklist": ["发布前检查项"]
            },
        },
        ensure_ascii=False,
        indent=2,
    )


def parse_json_object(text: str) -> dict[str, Any]:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    match = re.search(r"\{.*\}", text, flags=re.S)
    if not match:
        raise ValueError("Model output did not contain a JSON object.")
    return json.loads(match.group(0))


def generate_post(config: Any, trends: list[Trend]) -> dict[str, Any]:
    prompt = trends_to_prompt(
        trends=trends,
        profile=config.data.get("profile", {}),
        count=config.candidate_count,
    )
    text = create_response(
        model=config.model,
        instructions=SYSTEM_PROMPT,
        input_text=prompt,
        temperature=config.temperature,
    )
    post = parse_json_object(text)
    post["generated_at"] = datetime.now().isoformat(timespec="seconds")
    post["model"] = config.model
    post["trend_candidates"] = [trend.__dict__ for trend in trends[: config.candidate_count]]
    return post


def generate_template_post(config: Any, trends: list[Trend], reason: str) -> dict[str, Any]:
    chosen = next((trend for trend in trends if trend.source != "system"), trends[0])
    niche = config.data.get("profile", {}).get("niche", "账号定位")
    return {
        "selected_topic": chosen.title,
        "angle": f"从“{chosen.title}”延展到 {niche} 用户关心的经验、避坑或清单。",
        "title_options": [
            f"{chosen.title}，普通人可以关注什么？",
            f"看到{chosen.title}，我整理了这几点",
            f"{chosen.title}背后的实用提醒",
        ],
        "body": (
            f"今天刷到“{chosen.title}”，先别急着跟风。\n\n"
            "我会建议从这 3 个角度看：\n"
            "1. 这件事和自己的生活/工作有什么关系？\n"
            "2. 哪些信息还需要再核实，不要只看标题？\n"
            "3. 能不能沉淀成一个可执行的小清单？\n\n"
            "如果要写成小红书笔记，可以把重点放在真实体验、具体步骤和避坑提醒上。"
        ),
        "cover_text": "热点别只看热闹",
        "image_ideas": ["热点截图打码后做背景", "三点清单式封面", "生活化场景图"],
        "hashtags": ["#热点", "#小红书运营", "#内容创作"],
        "risk_notes": [
            "这是额度不足或 API 调用失败后的模板草稿，需要人工补充细节。",
            "涉及新闻事实的部分发布前必须核实来源。",
        ],
        "publish_checklist": ["核实热点事实", "替换为自己的真实经历", "检查标题是否夸张"],
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "model": "template_fallback",
        "generation_error": reason[:500],
        "trend_candidates": [trend.__dict__ for trend in trends[: config.candidate_count]],
    }
