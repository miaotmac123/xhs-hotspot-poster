from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from base64 import b64decode
from typing import Any

from .config import AppConfig
from .openai_client import urlopen_bytes, urlopen_json


class JimengImageError(RuntimeError):
    pass


def jimeng_image_settings(config: AppConfig) -> dict[str, Any]:
    image_cfg = config.data.get("image_generation") if isinstance(config.data.get("image_generation"), dict) else {}
    video_cfg = config.data.get("video_generation") if isinstance(config.data.get("video_generation"), dict) else {}

    def pick(key: str, default: object) -> object:
        if key in image_cfg and image_cfg[key] not in (None, ""):
            return image_cfg[key]
        if key in video_cfg and video_cfg[key] not in (None, ""):
            return video_cfg[key]
        return default

    api_key_env = str(pick("jimeng_api_key_env", "ARK_API_KEY"))
    model_env = str(pick("jimeng_model_env", "ARK_IMAGE_MODEL"))
    api_key = os.getenv(api_key_env) or os.getenv("ARK_API_KEY") or os.getenv("JIMENG_API_KEY")
    model = os.getenv(model_env) or str(pick("jimeng_model", "")) or os.getenv("ARK_IMAGE_MODEL")

    return {
        "api_key": api_key,
        "model": model,
        "endpoint": str(
            pick(
                "jimeng_endpoint",
                "https://ark.cn-beijing.volces.com/api/v3/images/generations",
            )
        ),
        "size": str(pick("jimeng_size", "1440x2560")),
        "response_format": str(pick("jimeng_response_format", "url")),
        "watermark": bool(pick("jimeng_watermark", False)),
        "unit_cost_cny": float(pick("jimeng_unit_cost_cny", 0.25)),
    }


def create_jimeng_image(*, prompt: str, config: AppConfig) -> tuple[bytes, dict[str, Any]]:
    settings = jimeng_image_settings(config)
    api_key = settings["api_key"]
    model = settings["model"]
    if not api_key:
        raise JimengImageError(
            "未找到即梦/火山方舟 API Key。请在 .env.local 配置 ARK_API_KEY（或 config 中的 jimeng_api_key_env）。"
        )
    if not model:
        raise JimengImageError(
            "未配置即梦模型 ID。请在 .env.local 设置 ARK_IMAGE_MODEL（如 doubao-seedream-4-5-251128）。"
        )

    payload = {
        "model": model,
        "prompt": prompt,
        "size": settings["size"],
        "response_format": settings["response_format"],
        "watermark": settings["watermark"],
    }
    request = urllib.request.Request(
        settings["endpoint"],
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        data = urlopen_json(request, timeout=180)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise JimengImageError(f"即梦生图失败（HTTP {exc.code}）：{body[:500]}") from exc
    except urllib.error.URLError as exc:
        raise JimengImageError(f"即梦生图网络错误：{exc}") from exc

    item = data.get("data", [{}])[0] if isinstance(data.get("data"), list) else {}
    if not item:
        item = (data.get("Data") or data.get("Result") or [{}])[0] if isinstance(data.get("Data") or data.get("Result"), list) else {}

    image_url = str(item.get("url") or item.get("image_url") or item.get("ImageUrl") or "")
    base64_data = str(item.get("b64_json") or item.get("base64") or item.get("B64Json") or "")
    if base64_data:
        image_bytes = b64decode(base64_data)
    elif image_url:
        image_bytes = fetch_bytes(image_url)
    else:
        raise JimengImageError("即梦 API 未返回图片 URL 或 base64 数据。")

    meta = {
        "model": model,
        "size": settings["size"],
        "endpoint": settings["endpoint"],
        "image_url": image_url,
        "unit_cost_cny": settings["unit_cost_cny"],
        "estimated_cost_cny": settings["unit_cost_cny"],
    }
    return image_bytes, meta


def fetch_bytes(url: str) -> bytes:
    request = urllib.request.Request(url, method="GET")
    try:
        return urlopen_bytes(request, timeout=120)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise JimengImageError(f"下载即梦图片失败（HTTP {exc.code}）：{body[:300]}") from exc
    except urllib.error.URLError as exc:
        raise JimengImageError(f"下载即梦图片网络错误：{exc}") from exc
