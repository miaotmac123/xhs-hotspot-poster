from __future__ import annotations

import json
import os
import ssl
import urllib.error
import urllib.request
from base64 import b64decode
from datetime import datetime
from pathlib import Path
from typing import Any, Optional


API_URL = "https://api.openai.com/v1/responses"
IMAGE_API_URL = "https://api.openai.com/v1/images/generations"
DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions"
PROJECT_ROOT = Path(__file__).resolve().parents[1]


class OpenAIError(RuntimeError):
    pass


def create_response(*, model: str, instructions: str, input_text: str, temperature: float) -> str:
    provider = os.getenv("LLM_PROVIDER", "openai").lower()
    if provider == "deepseek":
        return create_deepseek_chat_completion(
            model=model,
            instructions=instructions,
            input_text=input_text,
            temperature=temperature,
        )

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise OpenAIError("OPENAI_API_KEY is missing. Add it to .env.local.")

    payload: dict[str, Any] = {
        "model": model,
        "instructions": instructions,
        "input": input_text,
        "temperature": temperature,
    }
    request = urllib.request.Request(
        API_URL,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        data = urlopen_json(request, timeout=90)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise OpenAIError(f"OpenAI API request failed: HTTP {exc.code} {body}") from exc
    except urllib.error.URLError as exc:
        raise OpenAIError(f"OpenAI API network error: {exc}") from exc

    if data.get("output_text"):
        return str(data["output_text"])

    chunks: list[str] = []
    for output in data.get("output", []):
        for content in output.get("content", []):
            if content.get("type") == "output_text" and content.get("text"):
                chunks.append(content["text"])
    if not chunks:
        raise OpenAIError(f"OpenAI API returned no text. Response id: {data.get('id', 'unknown')}")
    return "\n".join(chunks)


def create_deepseek_chat_completion(*, model: str, instructions: str, input_text: str, temperature: float) -> str:
    api_key = os.getenv("DEEPSEEK_API_KEY")
    if not api_key:
        raise OpenAIError("DEEPSEEK_API_KEY is missing. Add it to .env.local.")

    api_url = os.getenv("DEEPSEEK_BASE_URL", DEEPSEEK_API_URL).rstrip("/")
    if api_url.endswith("/v1"):
        api_url = f"{api_url}/chat/completions"
    elif not api_url.endswith("/chat/completions"):
        api_url = f"{api_url}/chat/completions"

    payload: dict[str, Any] = {
        "model": model,
        "messages": [
            {"role": "system", "content": instructions},
            {"role": "user", "content": input_text},
        ],
        "temperature": temperature,
        "stream": False,
    }
    request = urllib.request.Request(
        api_url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        data = urlopen_json(request, timeout=120)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise OpenAIError(f"DeepSeek API request failed: HTTP {exc.code} {body}") from exc
    except urllib.error.URLError as exc:
        raise OpenAIError(f"DeepSeek API network error: {exc}") from exc

    choices = data.get("choices", [])
    if choices and choices[0].get("message", {}).get("content"):
        log_usage(provider="deepseek", model=model, usage=data.get("usage", {}))
        return str(choices[0]["message"]["content"])
    raise OpenAIError("DeepSeek API returned no message content.")


def log_usage(*, provider: str, model: str, usage: dict[str, Any]) -> None:
    if not usage:
        return
    log_dir = PROJECT_ROOT / "logs"
    log_dir.mkdir(exist_ok=True)
    record = {
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "provider": provider,
        "model": model,
        "usage": usage,
    }
    with (log_dir / "llm_usage.jsonl").open("a", encoding="utf-8") as file:
        file.write(json.dumps(record, ensure_ascii=False) + "\n")


def create_image(
    *,
    model: str,
    prompt: str,
    size: str,
    quality: str,
    output_format: str = "png",
) -> bytes:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise OpenAIError("OPENAI_API_KEY is missing. Add it to .env.local.")

    payload: dict[str, Any] = {
        "model": model,
        "prompt": prompt,
        "size": size,
        "quality": quality,
        "n": 1,
        "output_format": output_format,
    }
    request = urllib.request.Request(
        IMAGE_API_URL,
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
        raise OpenAIError(format_openai_http_error("OpenAI image request failed", exc.code, body)) from exc
    except urllib.error.URLError as exc:
        raise OpenAIError(f"OpenAI image network error: {exc}") from exc

    images = data.get("data", [])
    if not images or not images[0].get("b64_json"):
        raise OpenAIError("OpenAI image API returned no image data.")
    return b64decode(images[0]["b64_json"])


def format_openai_http_error(prefix: str, status_code: int, body: str) -> str:
    message = body.strip()
    error_code = ""
    try:
        payload = json.loads(body)
        error = payload.get("error") or {}
        message = str(error.get("message") or message)
        error_code = str(error.get("code") or "")
    except json.JSONDecodeError:
        pass

    if error_code == "billing_hard_limit_reached":
        return (
            "OpenAI 图片生成失败：API 账户已达到 billing hard limit。"
            "这不是代码问题，需要到 OpenAI Platform 调整用量上限或充值后再试。"
            "也可以先用“本地生成封面”或上传图片继续流程。"
            f" 原始错误：HTTP {status_code} {message}"
        )
    if error_code == "insufficient_quota":
        return (
            "OpenAI 图片生成失败：API 额度或余额不足。"
            "需要检查 OpenAI Platform billing/usage，或先改用本地封面、上传图片。"
            f" 原始错误：HTTP {status_code} {message}"
        )
    return f"{prefix}: HTTP {status_code} {body}"


def urlopen_json(request: urllib.request.Request, *, timeout: int) -> dict[str, Any]:
    try:
        return read_json_response(request, timeout=timeout)
    except urllib.error.URLError as exc:
        if "CERTIFICATE_VERIFY_FAILED" not in str(exc):
            raise
        context = ssl._create_unverified_context()
        return read_json_response(request, timeout=timeout, context=context)


def read_json_response(
    request: urllib.request.Request,
    *,
    timeout: int,
    context: Optional[ssl.SSLContext] = None,
) -> dict[str, Any]:
    with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
        return json.loads(response.read().decode("utf-8"))
