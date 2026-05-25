from __future__ import annotations

import argparse
import json
from pathlib import Path

from .config import load_config
from .generator import generate_post, generate_template_post
from .images import generate_image_for_post
from .openai_client import OpenAIError
from .publisher import PublishSkipped, publish_if_configured
from .storage import save_post
from .trends import collect_trends
from .trends import Trend
from .web import serve_dashboard


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate Xiaohongshu drafts from daily hotspots.")
    parser.add_argument("--config", default=None, help="Path to config.json")
    parser.add_argument("--once", action="store_true", help="Run one generation now")
    parser.add_argument("--dry-run", action="store_true", help="Collect trends only; do not call OpenAI")
    parser.add_argument("--publish", action="store_true", help="Send draft to configured publisher endpoint")
    parser.add_argument("--no-image", action="store_true", help="Skip image generation for new drafts")
    parser.add_argument("--serve", action="store_true", help="Open the local draft review dashboard")
    parser.add_argument("--host", default="127.0.0.1", help="Dashboard host")
    parser.add_argument("--port", type=int, default=8765, help="Dashboard port")
    args = parser.parse_args()

    config = load_config(args.config)
    if args.serve:
        serve_dashboard(config, host=args.host, port=args.port)
        return 0

    trends = collect_trends(config.data)
    if not trends:
        raise RuntimeError("No trends collected. Check trend_sources in config.json.")

    if args.dry_run:
        print(json.dumps([trend.__dict__ for trend in trends[: config.candidate_count]], ensure_ascii=False, indent=2))
        return 0

    post_paths: list[Path] = []
    batches = build_generation_batches(config, trends)
    for topic_trends in batches:
        try:
            post = generate_post(config, topic_trends)
        except (OpenAIError, ValueError) as exc:
            post = generate_template_post(config, topic_trends, str(exc))
            print(f"LLM generation failed; saved template fallback instead: {exc}")
        path = save_post(config.output_dir, post)
        if config.image_generation_enabled and not args.no_image:
            try:
                image_path = generate_image_for_post(post, config, path)
                print(f"Generated image: {image_path}")
            except OpenAIError as exc:
                post["image_generation_error"] = str(exc)[:1000]
                path.write_text(json.dumps(post, ensure_ascii=False, indent=2), encoding="utf-8")
                print(f"Image generation failed; saved draft without image: {exc}")
        post_paths.append(path)
        if args.publish:
            try:
                result = publish_if_configured(config.data, post)
                print(f"Published via configured endpoint: {result[:200]}")
            except PublishSkipped as exc:
                print(str(exc))

    print("Generated drafts:")
    for path in post_paths:
        print(path)
    return 0


def build_generation_batches(config: object, trends: list[Trend]) -> list[list[Trend]]:
    categories = config.data.get("content_categories", [])
    if categories:
        batches: list[list[Trend]] = []
        for category in categories[: config.posts_per_day]:
            name = str(category.get("name", "热点"))
            topic = str(category.get("topic", name))
            angle = str(category.get("angle", ""))
            category_seed = Trend(
                title=f"{name}｜{topic}",
                source="category",
                summary=angle,
            )
            related = [trend for trend in trends if trend.source != "system"]
            batches.append([category_seed, *related])
        return batches
    return [trends for _ in range(config.posts_per_day)]
