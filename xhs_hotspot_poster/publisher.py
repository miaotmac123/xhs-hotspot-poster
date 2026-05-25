from __future__ import annotations

import json
import os
import urllib.request
from typing import Any


class PublishSkipped(RuntimeError):
    pass


def publish_if_configured(config: dict[str, Any], post: dict[str, Any]) -> str:
    publisher = config.get("publisher", {})
    mode = publisher.get("mode", "draft_only")
    endpoint = publisher.get("api_endpoint", "")
    token_env = publisher.get("api_token_env", "XHS_API_TOKEN")

    if mode == "draft_only":
        raise PublishSkipped("publisher.mode is draft_only; saved draft only.")
    if not endpoint:
        raise PublishSkipped("publisher.api_endpoint is empty; saved draft only.")

    token = os.getenv(token_env, "")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(post, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read().decode("utf-8", errors="replace")

