from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .config import PROJECT_ROOT
from .hit_library import load_hit_library
from .ops_queue import list_slot_files, queue_root


def load_calendar() -> dict[str, Any]:
    path = PROJECT_ROOT / "ops" / "calendar.json"
    if not path.exists():
        return {"slots": []}
    return json.loads(path.read_text(encoding="utf-8"))


def read_cron_log_tail(limit: int = 40) -> list[str]:
    path = PROJECT_ROOT / "logs" / "cron.log"
    if not path.exists():
        return []
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    return lines[-limit:]


def collect_ops_status(output_dir: Path) -> dict[str, Any]:
    calendar = load_calendar()
    slots_status: list[dict[str, Any]] = []
    for slot_cfg in calendar.get("slots", []):
        if not isinstance(slot_cfg, dict):
            continue
        slot = str(slot_cfg.get("id", ""))
        pending = [p for p in list_slot_files(slot, state="pending") if not p.name.endswith(".meta.json")]
        published = [p for p in list_slot_files(slot, state="published") if not p.name.endswith(".meta.json")]
        failed = [p for p in list_slot_files(slot, state="failed") if not p.name.endswith(".meta.json")]
        slots_status.append(
            {
                "id": slot,
                "label": slot_cfg.get("label", slot),
                "prepare_at": slot_cfg.get("prepare_at", ""),
                "pending_count": len(pending),
                "published_count": len(published),
                "failed_count": len(failed),
            }
        )

    pipeline_scores: list[int] = []
    if output_dir.exists():
        for path in sorted(output_dir.glob("*/*.json"), reverse=True)[:30]:
            try:
                post = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                continue
            wp = post.get("writing_pipeline") if isinstance(post.get("writing_pipeline"), dict) else {}
            if "proofread_score" in wp:
                pipeline_scores.append(int(wp["proofread_score"]))

    avg_proofread = round(sum(pipeline_scores) / len(pipeline_scores), 1) if pipeline_scores else 0
    return {
        "queue_root": str(queue_root()),
        "slots": slots_status,
        "cron_log_tail": read_cron_log_tail(),
        "hit_library": load_hit_library().get("stats", {}),
        "pipeline_avg_proofread": avg_proofread,
        "recent_pipeline_samples": len(pipeline_scores),
    }
