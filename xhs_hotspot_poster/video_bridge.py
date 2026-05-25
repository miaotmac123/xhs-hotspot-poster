from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

from .config import AppConfig, PROJECT_ROOT


class VideoGenerationError(RuntimeError):
    pass


def generate_local_video_for_post(config: AppConfig, draft_path: Path, *, plan_only: bool = False, fresh: bool = False) -> dict[str, Any]:
    renderer = PROJECT_ROOT / "video-renderer" / "src" / "render.js"
    if not renderer.exists():
        raise VideoGenerationError(f"Node video renderer not found: {renderer}")

    command = [
        "node",
        str(renderer),
        "--post",
        str(draft_path.relative_to(PROJECT_ROOT)),
        "--config",
        str(config.path.relative_to(PROJECT_ROOT)),
    ]
    if plan_only:
        command.append("--plan-only")
    if fresh:
        command.append("--fresh")
    try:
        result = subprocess.run(
            command,
            cwd=PROJECT_ROOT,
            check=True,
            text=True,
            capture_output=True,
            timeout=300,
        )
    except FileNotFoundError as exc:
        raise VideoGenerationError("Node.js is not available on PATH.") from exc
    except subprocess.TimeoutExpired as exc:
        raise VideoGenerationError("Video generation timed out after 300 seconds.") from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or "").strip()
        raise VideoGenerationError(detail or "Node video renderer failed.") from exc

    try:
        return json.loads(result.stdout or "{}")
    except json.JSONDecodeError:
        return {"ok": True, "stdout": result.stdout}
