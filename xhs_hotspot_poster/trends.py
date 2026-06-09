from __future__ import annotations

import html
import json
import re
import ssl
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Any


USER_AGENT = "Mozilla/5.0 (compatible; xhs-hotspot-poster/0.1)"


@dataclass(frozen=True)
class Trend:
    title: str
    source: str
    url: str = ""
    heat: str = ""
    summary: str = ""
    tags: tuple[str, ...] = ()


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
    url = str(source.get("url", "")).strip()
    path = str(source.get("path", "")).strip()
    if not url and not path:
        return []
    page = read_source_payload(source)
    if source_type == "baidu_top":
        return parse_baidu_top(page, name, url)
    if source_type == "rss":
        return parse_rss(page, name)
    if source_type == "json":
        return parse_json_list(page, name, source)
    if source_type == "trendradar_json":
        return parse_trendradar_json(page, name)
    raise ValueError(f"Unsupported trend source type: {source_type}")


def read_source_payload(source: dict[str, Any]) -> str:
    url = str(source.get("url", "")).strip()
    path = str(source.get("path", "")).strip()
    if path:
        return Path(path).expanduser().read_text(encoding="utf-8")
    if url.startswith("file://"):
        return Path(urllib.request.url2pathname(url.removeprefix("file://"))).expanduser().read_text(encoding="utf-8")
    return fetch_url(url)


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


def parse_trendradar_json(page: str, source: str) -> list[Trend]:
    payload = json.loads(page)
    items = extract_trendradar_items(payload)
    trends: list[Trend] = []
    for item in items:
        trend = trend_from_trendradar_item(item, source)
        if trend:
            trends.append(trend)
    return dedupe(trends)


def extract_trendradar_items(payload: Any, inherited_source: str = "") -> list[dict[str, Any]]:
    if isinstance(payload, list):
        items: list[dict[str, Any]] = []
        for item in payload:
            if not isinstance(item, dict):
                continue
            if looks_like_news_item(item):
                enriched = dict(item)
                if inherited_source and not first_text(enriched, "platform", "platform_id", "source", "source_id", "feed_id", "feed", "site"):
                    enriched["_trendradar_parent_source"] = inherited_source
                items.append(enriched)
            else:
                next_source = first_text(item, "platform", "platform_id", "source", "source_id", "feed_id", "feed", "site") or inherited_source
                items.extend(extract_trendradar_items(item, next_source))
        return items
    if not isinstance(payload, dict):
        return []

    preferred_keys = (
        "news",
        "items",
        "data",
        "results",
        "hotlist",
        "rss",
        "new_items",
        "latest_news",
        "latest_rss",
        "articles",
    )
    items: list[dict[str, Any]] = []
    for key in preferred_keys:
        value = payload.get(key)
        if isinstance(value, list):
            items.extend(extract_trendradar_items(value, inherited_source))
        elif isinstance(value, dict):
            next_source = first_text(value, "platform", "platform_id", "source", "source_id", "feed_id", "feed", "site") or inherited_source
            items.extend(extract_trendradar_items(value, next_source))
    if items:
        return items

    nested: list[dict[str, Any]] = []
    for value in payload.values():
        if isinstance(value, list):
            nested.extend(extract_trendradar_items(value, inherited_source))
        elif isinstance(value, dict):
            next_source = first_text(value, "platform", "platform_id", "source", "source_id", "feed_id", "feed", "site") or inherited_source
            nested.extend(extract_trendradar_items(value, next_source))
    return nested


def looks_like_news_item(item: dict[str, Any]) -> bool:
    return any(item.get(key) for key in ("title", "name", "text", "headline")) and any(
        key in item for key in ("url", "link", "platform", "source", "rank", "position", "summary", "description")
    )


def trend_from_trendradar_item(item: dict[str, Any], default_source: str) -> Trend | None:
    title = first_text(item, "title", "name", "text", "headline")
    if not title:
        return None
    platform = first_text(item, "platform", "platform_id", "source", "source_id", "feed_id", "feed", "site", "_trendradar_parent_source")
    source = f"trendradar:{platform}" if platform else f"trendradar:{default_source}"
    url = first_text(item, "url", "link", "href", "source_url")
    rank = first_text(item, "rank", "position", "index")
    heat = first_text(item, "hot", "heat", "score", "popularity", "weight")
    heat_value = " / ".join(part for part in [rank and f"#{rank}", heat] if part)
    summary = first_text(item, "summary", "description", "desc", "abstract", "content", "translated_title")
    tags = tuple(str(tag).strip() for tag in item.get("tags", []) if str(tag).strip()) if isinstance(item.get("tags"), list) else ()
    return Trend(title=title, source=source, url=url, heat=heat_value, summary=summary, tags=tags)


def first_text(item: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = item.get(key)
        if value is None:
            continue
        if isinstance(value, (str, int, float)):
            text = str(value).strip()
            if text:
                return strip_tags(text)
    return ""


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


def collect_trendradar_candidates(config: dict[str, Any]) -> list[Trend]:
    trends: list[Trend] = []
    for source in config.get("trend_sources", []):
        if source.get("type") != "trendradar_json":
            continue
        try:
            trends.extend(fetch_source(source))
        except Exception as exc:
            trends.append(Trend(title=f"TrendRadar 源失败：{source.get('name', 'trendradar')}", source="system", summary=str(exc)))
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
