from __future__ import annotations

import argparse
import json
from pathlib import Path

from .config import load_config
from .content_brief import brief_enabled, generate_content_brief
from .content_pipeline import run_writing_pipeline
from .generator import build_generation_batches, generate_post, generate_template_post
from .ops_runner import run_cli_ops_status, run_cli_prepare
from .quality_gate import evaluate_post
from .storage import render_markdown
from .images import generate_image_for_post
from .images import ImageGenerationError
from .jimeng_image import JimengImageError
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
    parser.add_argument("--prepare-slot", default="", help="Prepare drafts for a time slot, e.g. 07:00")
    parser.add_argument("--articles", type=int, default=1, help="Number of articles when using --prepare-slot")
    parser.add_argument("--ops-status", action="store_true", help="Print ops queue and pipeline status JSON")
    parser.add_argument("--host", default="127.0.0.1", help="Dashboard host")
    parser.add_argument("--port", type=int, default=8765, help="Dashboard port")
    args = parser.parse_args()

    config = load_config(args.config)
    if args.ops_status:
        return run_cli_ops_status(args.config)
    if args.prepare_slot:
        return run_cli_prepare(args.config, args.prepare_slot, args.articles)
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
        brief = None
        try:
            if brief_enabled(config.data):
                brief = generate_content_brief(config, topic_trends)
            post = generate_post(config, topic_trends, content_brief=brief)
        except (OpenAIError, ValueError) as exc:
            post = generate_template_post(config, topic_trends, str(exc))
            print(f"LLM generation failed; saved template fallback instead: {exc}")
        else:
            if brief:
                post["content_brief"] = brief
        try:
            post = run_writing_pipeline(post, config)
        except OpenAIError as exc:
            post["writing_pipeline_error"] = str(exc)[:500]
        path = save_post(config.output_dir, post)
        post["quality_report"] = evaluate_post(post, config)
        path.write_text(json.dumps(post, ensure_ascii=False, indent=2), encoding="utf-8")
        path.with_suffix(".md").write_text(render_markdown(post), encoding="utf-8")
        if config.image_generation_enabled and not args.no_image:
            try:
                image_path = generate_image_for_post(post, config, path)
                print(f"Generated image: {image_path}")
            except (OpenAIError, JimengImageError, ImageGenerationError) as exc:
                post["image_generation_error"] = str(exc)[:1000]
                path.write_text(json.dumps(post, ensure_ascii=False, indent=2), encoding="utf-8")
                print(f"Image generation failed; saved draft without image: {exc}")
        post_paths.append(path)
        if args.publish:
            publisher = config.data.get("publisher") or {}
            if str(publisher.get("mode", "draft_only")) == "draft_only":
                print("Publish skipped: publisher.mode is draft_only (human review required).")
            else:
                try:
                    result = publish_if_configured(config.data, post)
                    print(f"Published via configured endpoint: {result[:200]}")
                except PublishSkipped as exc:
                    print(str(exc))

    print("Generated drafts:")
    for path in post_paths:
        print(path)
    return 0


