from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from .config import PROJECT_ROOT


def hit_library_path() -> Path:
    return PROJECT_ROOT / "data" / "hit_library.json"


def load_hit_library() -> dict[str, Any]:
    path = hit_library_path()
    if not path.exists():
        return {"keywords": [], "keyword_boost": 8, "records": [], "stats": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def save_hit_library(data: dict[str, Any]) -> None:
    path = hit_library_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    data["updated_at"] = datetime.now().isoformat(timespec="seconds")
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def keyword_boost(text: str, library: dict[str, Any] | None = None) -> int:
    lib = library or load_hit_library()
    boost_unit = int(lib.get("keyword_boost", 8))
    score = 0
    for keyword in lib.get("keywords", []):
        if keyword and str(keyword).lower() in text.lower():
            score += boost_unit
    return score


def record_performance(
    *,
    draft_id: str,
    topic: str,
    reads: int = 0,
    comments: int = 0,
    shares: int = 0,
    platform: str = "xiaohongshu",
) -> dict[str, Any]:
    lib = load_hit_library()
    records = lib.get("records") if isinstance(lib.get("records"), list) else []
    records.append(
        {
            "draft_id": draft_id,
            "topic": topic,
            "reads": reads,
            "comments": comments,
            "shares": shares,
            "platform": platform,
            "recorded_at": datetime.now().isoformat(timespec="seconds"),
        }
    )
    lib["records"] = records[-200:]
    total = len(lib["records"])
    avg_reads = sum(int(item.get("reads", 0)) for item in lib["records"]) / total if total else 0
    hits = sum(1 for item in lib["records"] if int(item.get("reads", 0)) >= 100)
    lib["stats"] = {
        "total_records": total,
        "avg_reads": round(avg_reads, 1),
        "hit_rate": round(hits / total, 4) if total else 0,
    }
    save_hit_library(lib)
    return lib
