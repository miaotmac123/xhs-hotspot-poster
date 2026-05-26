from __future__ import annotations

from typing import Any

from .config import AppConfig
from .critique_revise import pipeline_config, run_critique_loop
from .openai_client import OpenAIError
from .proofread import proofread_post_text, proofread_result_to_dict, proofread_text


def run_writing_pipeline(post: dict[str, Any], config: AppConfig) -> dict[str, Any]:
    cfg = pipeline_config(config.data)
    if not cfg.get("enabled", True):
        return post

    pipeline_meta: dict[str, Any] = {
        "enabled": True,
        "version": "v1",
    }

    if cfg.get("proofread_enabled", True):
        result = proofread_text(proofread_post_text(post), config.data)
        pipeline_meta["proofread"] = proofread_result_to_dict(result)
        pipeline_meta["proofread_score"] = result.score

    if cfg.get("critique_enabled", True):
        try:
            post = run_critique_loop(post, config)
            nested = post.get("writing_pipeline") if isinstance(post.get("writing_pipeline"), dict) else {}
            pipeline_meta.update(nested)
        except OpenAIError as exc:
            pipeline_meta["critique_error"] = str(exc)[:500]

    post["writing_pipeline"] = pipeline_meta
    return post
