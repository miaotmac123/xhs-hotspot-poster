from __future__ import annotations

import json
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any

from .config import PROJECT_ROOT


def queue_root() -> Path:
    return PROJECT_ROOT / "queue"


def slot_dir(slot: str, *, state: str = "pending") -> Path:
    return queue_root() / state / slot


def enqueue_draft(draft_path: Path, slot: str) -> Path:
    target_dir = slot_dir(slot, state="pending")
    target_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    target_json = target_dir / f"{stamp}-{draft_path.stem}.json"
    shutil.copy2(draft_path, target_json)
    post = json.loads(draft_path.read_text(encoding="utf-8"))
    meta = {
        "draft_id": draft_path.name,
        "slot": slot,
        "enqueued_at": datetime.now().isoformat(timespec="seconds"),
        "topic": post.get("selected_topic", ""),
        "writing_pipeline": post.get("writing_pipeline", {}),
        "content_origin": post.get("content_origin", "hotspot"),
    }
    target_json.with_suffix(".meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return target_json


def list_slot_files(slot: str, *, state: str = "pending") -> list[Path]:
    folder = slot_dir(slot, state=state)
    if not folder.exists():
        return []
    return sorted(folder.glob("*.json"))
