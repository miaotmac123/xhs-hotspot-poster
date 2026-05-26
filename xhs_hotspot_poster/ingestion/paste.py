from __future__ import annotations

import re
from typing import Any


def build_source_from_paste(
    raw_text: str,
    *,
    author: str = "",
    source_url: str = "",
    language: str = "auto",
    min_chars: int = 80,
) -> dict[str, Any]:
    text = normalize_raw_text(raw_text)
    if len(text) < min_chars:
        raise ValueError(f"粘贴内容太短，至少需要约 {min_chars} 个字符。")

    detected_author = clean_author(author) or detect_author(text)
    detected_url = clean_url(source_url) or detect_url(text)
    title_hint = first_line(text)

    return {
        "platform": "x",
        "raw_text": text,
        "author": detected_author,
        "source_url": detected_url,
        "language": language or "auto",
        "title_hint": title_hint[:120],
        "char_count": len(text),
    }


def normalize_raw_text(value: str) -> str:
    text = str(value or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text


def clean_author(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if not text.startswith("@"):
        text = f"@{text.lstrip('@')}"
    return text[:80]


def clean_url(value: str) -> str:
    text = str(value or "").strip()
    if text and not text.startswith("http"):
        return ""
    return text[:500]


def detect_author(text: str) -> str:
    match = re.search(r"(?:^|\n)@([A-Za-z0-9_]{1,30})\b", text)
    if match:
        return f"@{match.group(1)}"
    return ""


def detect_url(text: str) -> str:
    match = re.search(r"https?://(?:x\.com|twitter\.com)/[^\s)]+", text, flags=re.I)
    return match.group(0) if match else ""


def first_line(text: str) -> str:
    for line in text.splitlines():
        clean = line.strip()
        if clean and not clean.startswith("http"):
            return clean[:120]
    return "X 搬运稿"
