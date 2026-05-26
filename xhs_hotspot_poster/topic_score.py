from __future__ import annotations

from typing import Any

from .hit_library import keyword_boost, load_hit_library
from .trends import Trend


SOURCE_WEIGHT = {
    "category": 28,
    "baidu": 22,
    "baidu_top": 22,
    "rss": 15,
    "manual": 18,
    "system": 10,
}


def score_trend(trend: Trend, library: dict[str, Any] | None = None) -> dict[str, Any]:
    lib = library or load_hit_library()
    source_weight = SOURCE_WEIGHT.get(trend.source, 15)
    source_score = float(source_weight) ** 1.3
    heat_score = 10.0
    if trend.heat:
        digits = "".join(ch for ch in str(trend.heat) if ch.isdigit())
        if digits:
            heat_score = min(25.0, float(digits[:6]) / 10000.0)
    text = f"{trend.title} {trend.summary or ''}"
    hit_score = float(keyword_boost(text, lib))
    total = round(source_score * 0.22 + heat_score * 0.25 + hit_score * 0.2 + 20, 1)
    return {
        "topic": trend.title,
        "score": total,
        "source": trend.source,
        "source_score": round(source_score, 1),
        "heat_score": round(heat_score, 1),
        "hit_keyword_score": hit_score,
    }


def rank_trends(trends: list[Trend]) -> list[dict[str, Any]]:
    library = load_hit_library()
    scored = [score_trend(trend, library) for trend in trends if trend.source != "system"]
    return sorted(scored, key=lambda item: item["score"], reverse=True)
