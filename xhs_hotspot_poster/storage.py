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

    origin = post.get("content_origin", "hotspot")
    origin_line = f"\n**内容来源**：{origin}\n" if origin != "hotspot" else ""

    source_block = ""
    source_material = post.get("source_material") if isinstance(post.get("source_material"), dict) else {}
    if source_material.get("raw_text"):
        author = source_material.get("author") or "未知"
        url = source_material.get("source_url") or ""
        source_block = f"""
## 原文摘要（搬运依据）

- 作者：{author}
- 链接：{url or "未提供"}
- 字数：{source_material.get("char_count", len(str(source_material.get("raw_text", ""))))}

<details>
<summary>展开原文</summary>

{source_material.get("raw_text", "")}

</details>
"""

    wechat_block = ""
    packages = post.get("platform_packages") if isinstance(post.get("platform_packages"), dict) else {}
    wechat = packages.get("wechat") if isinstance(packages.get("wechat"), dict) else {}
    if wechat.get("body"):
        wechat_block = f"""
## 公众号版

**标题**：{wechat.get("title", "")}

**摘要**：{wechat.get("summary", "")}

{wechat.get("body", "")}
"""

    repurpose = post.get("repurpose") if isinstance(post.get("repurpose"), dict) else {}
    summary_block = ""
    if repurpose.get("source_summary"):
        summary_block = f"\n## 原文核心（中文）\n\n{repurpose['source_summary']}\n"

    return f"""# {post.get("selected_topic", "小红书草稿")}
{origin_line}

## 切入角度

{post.get("angle", "")}
{summary_block}{source_block}
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
{wechat_block}
"""
