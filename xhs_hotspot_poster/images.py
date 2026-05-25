from __future__ import annotations

import json
import random
import shutil
import subprocess
import textwrap
from datetime import datetime
from pathlib import Path
from xml.sax.saxutils import escape
from typing import Any, Optional

from .config import AppConfig
from .openai_client import create_image
from .storage import render_markdown, slugify


LOCAL_COVER_PALETTES = [
    ("#101114", "#F5F1E8", "#FF4F7B", "#45E6FF", "#F7D046"),
    ("#F8EDEB", "#201A1B", "#D93A4A", "#2B6F77", "#FFE16A"),
    ("#121826", "#F9F7F0", "#7CFFCB", "#FF6A3D", "#8EA7FF"),
    ("#FFF7E0", "#191919", "#E93F5C", "#0E8A83", "#8B5CF6"),
]


def build_image_prompt(post: dict[str, Any], config: AppConfig) -> str:
    image_style = config.data.get("image_generation", {}).get("style", "")
    topic = post.get("selected_topic", "今日热点")
    cover_text = post.get("cover_text", "")
    angle = post.get("angle", "")
    hashtags = " ".join(post.get("hashtags", []))
    return f"""Use case: ads-marketing
Asset type: Xiaohongshu vertical cover image / first carousel image
Primary request: Create a bold, imaginative, cyber-inspired visual for a Xiaohongshu post.
Topic: {topic}
Angle: {angle}
Cover text to support visually, but do not render readable text in the image: {cover_text}
Hashtag context: {hashtags}
Style: {image_style}
Composition: vertical 2:3 poster, strong center focal point, editorial lighting, premium social media cover, enough clean negative space near the top for app-added Chinese title text.
Scene/backdrop: futuristic city light, holographic UI panels, luminous glass, energetic but not chaotic.
Subject: abstract symbolic objects that represent the topic, not portraits of real politicians, celebrities, or private people.
Constraints: no readable text, no watermark, no app UI, no real brand logos, no fake news screenshot, no identifiable public figure face, no political propaganda, no gore, no medical procedure close-up.
Output feel: creative, polished, scroll-stopping, cyber, high contrast, suitable for 小红书.
"""


def generate_image_for_post(post: dict[str, Any], config: AppConfig, draft_path: Path) -> Path:
    provider = config.data.get("image_generation", {}).get("provider", "local_cover")
    if provider == "local_cover":
        return generate_local_cover_for_post(post, config, draft_path)
    return generate_openai_image_for_post(post, config, draft_path)


def generate_openai_image_for_post(post: dict[str, Any], config: AppConfig, draft_path: Path) -> Path:
    prompt = build_image_prompt(post, config)
    image_bytes = create_image(
        model=config.image_model,
        prompt=prompt,
        size=config.image_size,
        quality=config.image_quality,
        output_format="png",
    )

    assets_dir = draft_path.parent / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%H%M%S")
    name = f"{stamp}-{slugify(str(post.get('selected_topic', 'cover')))}.png"
    image_path = assets_dir / name
    image_path.write_bytes(image_bytes)

    relative = image_path.relative_to(config.output_dir).as_posix()
    post["generated_image"] = {
        "path": relative,
        "provider": "openai_image",
        "prompt": prompt,
        "model": config.image_model,
        "size": config.image_size,
        "quality": config.image_quality,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
    }
    draft_path.write_text(json.dumps(post, ensure_ascii=False, indent=2), encoding="utf-8")
    draft_path.with_suffix(".md").write_text(render_markdown(post), encoding="utf-8")
    return image_path


def generate_local_cover_for_post(post: dict[str, Any], config: AppConfig, draft_path: Path) -> Path:
    assets_dir = draft_path.parent / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)

    topic = str(post.get("selected_topic") or "今日热点")
    cover_text = str(post.get("cover_text") or topic)
    hashtags = [str(tag) for tag in post.get("hashtags", [])[:3]]
    stamp = datetime.now().strftime("%H%M%S")
    image_path = assets_dir / f"{stamp}-{slugify(topic)}-cover.svg"
    svg = build_local_cover_svg(cover_text=cover_text, topic=topic, hashtags=hashtags)
    image_path.write_text(svg, encoding="utf-8")
    public_image_path = render_svg_to_png(image_path) or image_path

    relative = public_image_path.relative_to(config.output_dir).as_posix()
    post["generated_image"] = {
        "path": relative,
        "source_svg": image_path.relative_to(config.output_dir).as_posix(),
        "provider": "local_cover",
        "model": "local-svg",
        "size": "1024x1536",
        "quality": "local",
        "generated_at": datetime.now().isoformat(timespec="seconds"),
    }
    post.pop("image_generation_error", None)
    draft_path.write_text(json.dumps(post, ensure_ascii=False, indent=2), encoding="utf-8")
    draft_path.with_suffix(".md").write_text(render_markdown(post), encoding="utf-8")
    return public_image_path


def attach_uploaded_image_to_post(
    post: dict[str, Any],
    config: AppConfig,
    draft_path: Path,
    image_bytes: bytes,
    filename: str,
) -> Path:
    suffix = Path(filename).suffix.lower()
    if suffix not in {".png", ".jpg", ".jpeg", ".webp"}:
        raise ValueError("Only png, jpg, jpeg, and webp images are supported.")
    assets_dir = draft_path.parent / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)
    topic = str(post.get("selected_topic") or "cover")
    stamp = datetime.now().strftime("%H%M%S")
    image_path = assets_dir / f"{stamp}-{slugify(topic)}-uploaded{suffix}"
    image_path.write_bytes(image_bytes)

    relative = image_path.relative_to(config.output_dir).as_posix()
    post["generated_image"] = {
        "path": relative,
        "provider": "manual_upload",
        "model": "manual",
        "size": "uploaded",
        "quality": "uploaded",
        "filename": filename,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
    }
    post.pop("image_generation_error", None)
    draft_path.write_text(json.dumps(post, ensure_ascii=False, indent=2), encoding="utf-8")
    draft_path.with_suffix(".md").write_text(render_markdown(post), encoding="utf-8")
    return image_path


def render_svg_to_png(svg_path: Path) -> Path | None:
    final = svg_path.with_suffix(".png")
    sips = shutil.which("sips")
    if sips:
        try:
            subprocess.run(
                [sips, "-s", "format", "png", str(svg_path), "--out", str(final)],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if final.exists():
                return final
        except (OSError, subprocess.CalledProcessError):
            pass

    qlmanage = shutil.which("qlmanage")
    if not qlmanage:
        return None
    try:
        subprocess.run(
            [qlmanage, "-t", "-s", "1536", "-o", str(svg_path.parent), str(svg_path)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    generated = svg_path.with_name(f"{svg_path.name}.png")
    if generated.exists():
        generated.replace(final)
        return final
    return None


def build_local_cover_svg(*, cover_text: str, topic: str, hashtags: list[str]) -> str:
    bg, ink, accent, cyan, yellow = random.choice(LOCAL_COVER_PALETTES)
    title_lines = wrap_cjk(cover_text, width=7, max_lines=3)
    topic_lines = wrap_cjk(topic, width=19, max_lines=2)
    tag_text = "  ".join(hashtags) if hashtags else "#热点  #小红书"
    title_font_size = 92 if max(len(line) for line in title_lines) <= 7 else 82
    title_line_height = 108 if title_font_size == 92 else 98
    title_y = 560 if len(title_lines) <= 2 else 520
    title_shadow_text = make_text_lines(
        title_lines,
        x=90,
        y=title_y + 4,
        line_height=title_line_height,
        fill="#000000",
        font_size=title_font_size,
        font_weight=900,
        opacity=0.34,
    )
    title_text = make_text_lines(
        title_lines,
        x=86,
        y=title_y,
        line_height=title_line_height,
        fill="#ffffff",
        font_size=title_font_size,
        font_weight=900,
    )
    topic_text = make_text_lines(
        topic_lines,
        x=92,
        y=1098,
        line_height=44,
        fill=ink,
        font_size=31,
        font_weight=760,
        opacity=0.84,
    )
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1536" viewBox="0 0 1024 1536">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="{bg}"/>
      <stop offset="52%" stop-color="{shift_color(bg, 22)}"/>
      <stop offset="100%" stop-color="{shift_color(accent, -30)}"/>
    </linearGradient>
    <pattern id="grid" width="64" height="64" patternUnits="userSpaceOnUse">
      <path d="M 64 0 L 0 0 0 64" fill="none" stroke="{escape(cyan)}" stroke-width="1" opacity="0.16"/>
    </pattern>
  </defs>
  <rect width="1024" height="1536" fill="url(#bg)"/>
  <rect width="1024" height="1536" fill="url(#grid)" opacity="0.72"/>
  <circle cx="838" cy="248" r="250" fill="{escape(cyan)}" opacity="0.18"/>
  <circle cx="172" cy="1250" r="305" fill="{escape(accent)}" opacity="0.16"/>
  <path d="M58 336 C232 210 386 288 514 172 C668 32 832 98 960 54" fill="none" stroke="{escape(yellow)}" stroke-width="10" opacity="0.72"/>
  <rect x="56" y="96" width="912" height="1344" rx="42" fill="#ffffff" opacity="0.20" stroke="{escape(ink)}" stroke-width="2" stroke-opacity="0.16"/>
  <text x="82" y="202" fill="{escape(ink)}" font-size="38" font-weight="850" font-family="PingFang SC, Hiragino Sans GB, Microsoft YaHei, Arial, sans-serif" letter-spacing="0">今日热点笔记</text>
  <text x="82" y="256" fill="{escape(ink)}" font-size="26" font-weight="650" opacity="0.72" font-family="PingFang SC, Hiragino Sans GB, Microsoft YaHei, Arial, sans-serif">先看结论，再看影响</text>
  <rect x="72" y="404" width="880" height="486" rx="34" fill="#1c1d21" opacity="0.90"/>
  <rect x="72" y="404" width="14" height="486" rx="7" fill="{escape(accent)}"/>
  {title_shadow_text}
  {title_text}
  {topic_text}
  <rect x="82" y="1210" width="860" height="88" rx="44" fill="#1c1d21" opacity="0.90"/>
  <text x="122" y="1267" fill="#ffffff" font-size="28" font-weight="800" font-family="PingFang SC, Hiragino Sans GB, Microsoft YaHei, Arial, sans-serif">{escape(tag_text)}</text>
  <text x="82" y="1364" fill="{escape(ink)}" font-size="24" font-weight="700" opacity="0.66" font-family="PingFang SC, Hiragino Sans GB, Microsoft YaHei, Arial, sans-serif">自动生成草稿 · 发布前请核实事实</text>
</svg>
"""


def wrap_cjk(text: str, width: int, max_lines: int) -> list[str]:
    clean = " ".join(text.split())
    lines = textwrap.wrap(clean, width=width, break_long_words=True, replace_whitespace=False)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        lines[-1] = lines[-1].rstrip("，。,. ") + "…"
    return lines or ["今日热点"]


def make_tspans(lines: list[str], *, x: int, y: int, line_height: int) -> str:
    return "".join(
        f'<tspan x="{x}" y="{y + index * line_height}">{escape(line)}</tspan>'
        for index, line in enumerate(lines)
    )


def make_text_lines(
    lines: list[str],
    *,
    x: int,
    y: int,
    line_height: int,
    fill: str,
    font_size: int,
    font_weight: int,
    opacity: Optional[float] = None,
) -> str:
    opacity_attr = "" if opacity is None else f' opacity="{opacity}"'
    return "\n  ".join(
        (
            f'<text x="{x}" y="{y + index * line_height}" fill="{escape(fill)}" '
            f'font-size="{font_size}" font-weight="{font_weight}"{opacity_attr} '
            'font-family="PingFang SC, Hiragino Sans GB, Microsoft YaHei, Arial, sans-serif">'
            f"{escape(line)}</text>"
        )
        for index, line in enumerate(lines)
    )


def shift_color(color: str, amount: int) -> str:
    color = color.lstrip("#")
    channels = [max(0, min(255, int(color[i : i + 2], 16) + amount)) for i in (0, 2, 4)]
    return "#" + "".join(f"{channel:02x}" for channel in channels)
