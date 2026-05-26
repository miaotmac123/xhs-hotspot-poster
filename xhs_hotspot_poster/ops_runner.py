from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from .config import PROJECT_ROOT, AppConfig
from .ops_queue import enqueue_draft
from .ops_status import collect_ops_status
from .storage import save_post
from .trends import collect_trends, Trend
from .generator import build_generation_batches, generate_post, generate_template_post
from .content_brief import brief_enabled, generate_content_brief
from .content_pipeline import run_writing_pipeline
from .openai_client import OpenAIError
from .quality_gate import evaluate_post
from .storage import render_markdown


def log_cron(message: str) -> None:
    log_dir = PROJECT_ROOT / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    line = f"{datetime.now().isoformat(timespec='seconds')} {message}\n"
    with (log_dir / "cron.log").open("a", encoding="utf-8") as file:
        file.write(line)


def prepare_slot(config: AppConfig, slot: str, articles: int = 1) -> list[Path]:
    log_cron(f"prepare slot={slot} articles={articles} start")
    trends = collect_trends(config.data)
    if not trends:
        log_cron(f"prepare slot={slot} failed: no trends")
        raise RuntimeError("No trends collected.")

    batches = build_generation_batches(config, trends)[:articles]
    paths: list[Path] = []
    for topic_trends in batches:
        brief = None
        try:
            if brief_enabled(config.data):
                brief = generate_content_brief(config, topic_trends)
            post = generate_post(config, topic_trends, content_brief=brief)
        except (OpenAIError, ValueError) as exc:
            post = generate_template_post(config, topic_trends, str(exc))
        if brief_enabled(config.data) and brief:
            post["content_brief"] = brief
        post = run_writing_pipeline(post, config)
        path = save_post(config.output_dir, post)
        post["quality_report"] = evaluate_post(post, config)
        path.write_text(json.dumps(post, ensure_ascii=False, indent=2), encoding="utf-8")
        path.with_suffix(".md").write_text(render_markdown(post), encoding="utf-8")
        queue_path = enqueue_draft(path, slot)
        paths.append(queue_path)
        log_cron(f"prepare slot={slot} ok draft={path.name} queue={queue_path.name}")

    log_cron(f"prepare slot={slot} done count={len(paths)}")
    return paths


def run_cli_prepare(config_path: str | None, slot: str, articles: int) -> int:
    from .config import load_config

    config = load_config(config_path)
    prepare_slot(config, slot, articles=articles)
    return 0


def run_cli_ops_status(config_path: str | None) -> int:
    from .config import load_config

    config = load_config(config_path)
    status = collect_ops_status(config.output_dir)
    print(json.dumps(status, ensure_ascii=False, indent=2))
    return 0
