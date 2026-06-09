#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import time
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_API_URL = "https://newsnow.busiyi.world/api/s"
DEFAULT_PLATFORMS = [
    "weibo",
    "zhihu",
    "toutiao",
    "baidu",
    "thepaper",
    "cls-hot",
    "wallstreetcn-hot",
    "douyin",
]


def main() -> int:
    parser = argparse.ArgumentParser(description="Sync NewsNow/TrendRadar hotlist data into xhs-hotspot-poster bridge JSON.")
    parser.add_argument("--output", default="data/trendradar/latest.json", help="Bridge JSON path consumed by trendradar_json.")
    parser.add_argument("--api-url", default=DEFAULT_API_URL, help="NewsNow-compatible API base URL.")
    parser.add_argument("--platform", action="append", dest="platforms", help="Platform id to fetch. Repeatable.")
    parser.add_argument("--keyword", action="append", dest="keywords", help="Keyword/tag filter. Repeatable; comma-separated values are also supported.")
    parser.add_argument("--limit", type=int, default=15, help="Max items per platform.")
    parser.add_argument("--interval", type=float, default=0.25, help="Delay between platform requests in seconds.")
    args = parser.parse_args()

    platforms = args.platforms or DEFAULT_PLATFORMS
    keywords = normalize_keywords(args.keywords or [])
    output = Path(args.output).expanduser()
    items: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []

    for platform in platforms:
        try:
            payload = fetch_platform(args.api_url, platform)
            for rank, item in enumerate(payload.get("items", [])[: args.limit], start=1):
                title = clean_text(item.get("title") or item.get("id"))
                if not title:
                    continue
                summary = ""
                matched_tags = match_keywords(f"{title} {summary}", keywords)
                if keywords and not matched_tags:
                    continue
                items.append(
                    {
                        "title": title,
                        "platform": platform,
                        "url": clean_text(item.get("url") or item.get("mobileUrl")),
                        "rank": rank,
                        "heat": clean_text((item.get("extra") or {}).get("info")),
                        "summary": summary,
                        "tags": matched_tags,
                        "updated_at": clean_text(payload.get("updatedTime")),
                    }
                )
        except Exception as exc:
            failures.append({"platform": platform, "error": str(exc)[:300]})
        time.sleep(max(args.interval, 0))

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"data": items, "failures": failures}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(output), "items": len(items), "platforms": platforms, "keywords": keywords, "failures": failures}, ensure_ascii=False, indent=2))
    return 0 if items else 1


def fetch_platform(api_url: str, platform: str) -> dict[str, Any]:
    url = f"{api_url}?id={platform}&latest"
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; xhs-hotspot-poster trendradar bridge)",
            "Accept": "application/json, text/plain, */*",
        },
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        payload = json.loads(response.read().decode("utf-8", errors="replace"))
    status = payload.get("status")
    if status not in {"success", "cache"}:
        raise RuntimeError(f"unexpected status: {status}")
    return payload


def clean_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def normalize_keywords(values: list[str]) -> list[str]:
    keywords: list[str] = []
    for value in values:
        for part in str(value).replace("，", ",").split(","):
            text = part.strip()
            if text and text not in keywords:
                keywords.append(text)
    return keywords


def match_keywords(text: str, keywords: list[str]) -> list[str]:
    if not keywords:
        return []
    lowered = text.lower()
    return [keyword for keyword in keywords if keyword.lower() in lowered]


if __name__ == "__main__":
    raise SystemExit(main())
