from __future__ import annotations

import html
import json
import re
import ssl
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Any


USER_AGENT = "Mozilla/5.0 (compatible; xhs-hotspot-poster/0.1)"


@dataclass(frozen=True)
class Trend:
    title: str
    source: str
    url: str = ""
    heat: str = ""
    summary: str = ""


def fetch_url(url: str, timeout: int = 15) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        return read_url_response(request, timeout=timeout)
    except urllib.error.URLError as exc:
        if "CERTIFICATE_VERIFY_FAILED" not in str(exc):
            raise
        context = ssl._create_unverified_context()
        return read_url_response(request, timeout=timeout, context=context)


def read_url_response(request: urllib.request.Request, *, timeout: int, context: ssl.SSLContext | None = None) -> str:
    with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        return response.read().decode(charset, errors="replace")


def strip_tags(value: str) -> str:
    value = re.sub(r"<script\b[^>]*>.*?</script>", "", value, flags=re.I | re.S)
    value = re.sub(r"<style\b[^>]*>.*?</style>", "", value, flags=re.I | re.S)
    value = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", html.unescape(value)).strip()


def parse_baidu_top(page: str, source: str, url: str) -> list[Trend]:
    trends: list[Trend] = []

    # Baidu embeds useful data in JSON fragments. Try that first.
    for block in re.findall(r'"word"\s*:\s*"((?:\\.|[^"])*)"', page):
        title = decode_json_string(block).strip()
        if title:
            trends.append(Trend(title=title, source=source, url=url))

    if trends:
        return dedupe(trends)

    # Fallback for crawled/static HTML.
    text = strip_tags(page)
    chunks = re.split(r"\s+\d+\s+", text)
    for chunk in chunks:
        chunk = chunk.strip()
        if 6 <= len(chunk) <= 60 and not chunk.startswith(("新闻", "hao123", "地图")):
            trends.append(Trend(title=chunk, source=source, url=url))
    return dedupe(trends)


def decode_json_string(value: str) -> str:
    try:
        return str(json.loads(f'"{value}"'))
    except json.JSONDecodeError:
        return html.unescape(value)


def parse_rss(page: str, source: str) -> list[Trend]:
    root = ET.fromstring(page)
    items = root.findall(".//item")
    trends: list[Trend] = []
    for item in items:
        title = item.findtext("title") or ""
        link = item.findtext("link") or ""
        description = strip_tags(item.findtext("description") or "")
        if title.strip():
            trends.append(Trend(title=title.strip(), source=source, url=link.strip(), summary=description))
    return trends


def fetch_source(source: dict[str, Any]) -> list[Trend]:
    if not source.get("enabled", True):
        return []
    source_type = source.get("type")
    name = source.get("name", source_type or "unknown")
    url = source.get("url", "")
    if not url:
        return []
    page = fetch_url(url)
    if source_type == "baidu_top":
        return parse_baidu_top(page, name, url)
    if source_type == "rss":
        return parse_rss(page, name)
    if source_type == "json":
        return parse_json_list(page, name, source)
    raise ValueError(f"Unsupported trend source type: {source_type}")


def parse_json_list(page: str, source: str, config: dict[str, Any]) -> list[Trend]:
    payload = json.loads(page)
    item_path = config.get("item_path", "data")
    title_field = config.get("title_field", "title")
    url_field = config.get("url_field", "url")
    items: Any = payload
    for part in item_path.split("."):
        if not part:
            continue
        items = items.get(part, []) if isinstance(items, dict) else []
    trends: list[Trend] = []
    if isinstance(items, list):
        for item in items:
            if isinstance(item, dict) and item.get(title_field):
                trends.append(
                    Trend(
                        title=str(item.get(title_field, "")).strip(),
                        source=source,
                        url=str(item.get(url_field, "")).strip(),
                        heat=str(item.get("hot", item.get("heat", ""))).strip(),
                    )
                )
    return trends


def dedupe(trends: list[Trend]) -> list[Trend]:
    seen: set[str] = set()
    result: list[Trend] = []
    for trend in trends:
        key = re.sub(r"\s+", "", trend.title.lower())
        if not key or key in seen:
            continue
        seen.add(key)
        result.append(trend)
    return result


def collect_trends(config: dict[str, Any]) -> list[Trend]:
    trends: list[Trend] = []
    for source in config.get("trend_sources", []):
        try:
            trends.extend(fetch_source(source))
        except Exception as exc:  # Keep daily automation resilient when one source breaks.
            trends.append(Trend(title=f"热点源失败：{source.get('name', 'unknown')}", source="system", summary=str(exc)))

    for topic in config.get("manual_topics", []):
        trends.append(Trend(title=str(topic), source="manual"))

    return filter_trends(dedupe(trends), config)


def filter_trends(trends: list[Trend], config: dict[str, Any]) -> list[Trend]:
    excludes = [
        str(keyword).strip()
        for keyword in config.get("content_filters", {}).get("exclude_keywords", [])
        if str(keyword).strip()
    ]
    if not excludes:
        return trends
    result: list[Trend] = []
    for trend in trends:
        if any(keyword in trend.title for keyword in excludes):
            continue
        result.append(trend)
    return result
