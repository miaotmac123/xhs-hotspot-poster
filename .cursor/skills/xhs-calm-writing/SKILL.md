---
name: xhs-calm-writing
description: Keep Xiaohongshu copy calm and specific for xhs-hotspot-poster. Use when editing generator/repurpose prompts, writing_style config, or when user complains about hype/fluffy 小红书文案.
---

# 小红书克制文风（本项目）

## 配置入口（优先改这里，不必改代码）

`config.json` → `writing_style`：

- `tone`：总文风
- `temperature`：建议 0.5–0.65，越低越稳
- `avoid_phrases`：禁用词列表
- `title_rules` / `body_rules` / `xiaohongshu_rules`：追加规则

`profile.tone` 会一并传给模型，与 `writing_style` 保持一致。

## 代码入口

- 热点草稿：`xhs_hotspot_poster/generator.py` + `writing_style.py`
- X 搬运：`xhs_hotspot_poster/repurpose.py`
- 视频口播：`xhs_hotspot_poster/video_script.py`（口播可保留钩子，但避免震惊体）

## 原则

- 信息 > 情绪；具体事实/步骤 > 形容词
- 标题：陈述或提问，不用「震惊」「必看」「绝了」
- 正文：短段、少 emoji、不「家人们」开头
- 已有草稿不会自动重写；需重新「生成今日热点」或重新 X 导入

## 外部 Skill

公开市场没有统一的「去浮夸小红书」Skill。本项目用 `writing_style` 配置即可；若需全局 Agent 记忆，可同步写到 Cursor User Rules。
