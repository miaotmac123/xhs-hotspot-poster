from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any


def slugify(value: str) -> str:
    value = re.sub(r"[^\w\u4e00-\u9fff-]+", "-", value, flags=re.U)
    value = re.sub(r"-+", "-", value).strip("-")
    return value[:40] or "post"


def save_post(output_root: Path, post: dict[str, Any]) -> Path:
    today = datetime.now().strftime("%Y-%m-%d")
    folder = output_root / today
    folder.mkdir(parents=True, exist_ok=True)
    topic = post.get("selected_topic") or post.get("title_options", ["post"])[0]
    stamp = datetime.now().strftime("%H%M%S")
    path = folder / f"{stamp}-{slugify(str(topic))}.json"
    path.write_text(json.dumps(post, ensure_ascii=False, indent=2), encoding="utf-8")

    markdown = folder / f"{stamp}-{slugify(str(topic))}.md"
    markdown.write_text(render_markdown(post), encoding="utf-8")
    return path


def render_markdown(post: dict[str, Any]) -> str:
    titles = "\n".join(f"- {title}" for title in post.get("title_options", []))
    hashtags = " ".join(post.get("hashtags", []))
    images = "\n".join(f"- {item}" for item in post.get("image_ideas", []))
    risks = "\n".join(f"- {item}" for item in post.get("risk_notes", []))
    checklist = "\n".join(f"- [ ] {item}" for item in post.get("publish_checklist", []))
    generated_image = post.get("generated_image", {})
    generated_image_block = ""
    if generated_image.get("path"):
        generated_image_block = f'\n![生成配图]({generated_image["path"]})\n'
    return f"""# {post.get("selected_topic", "小红书草稿")}

## 切入角度

{post.get("angle", "")}

## 标题备选

{titles}

## 正文

{post.get("body", "")}

## 封面文字

{post.get("cover_text", "")}

## 配图建议

{images}

## 生成配图

{generated_image_block or "暂无生成配图"}

## 话题

{hashtags}

## 风险提示

{risks}

## 发布前检查

{checklist}
"""
