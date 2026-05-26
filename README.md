# xhs-hotspot-poster

每日基于热点生成小红书帖子草稿的本地程序。

> 当前项目正在从“小红书草稿工具”升级为“热点内容生成引擎”。视频生成核心已放在 Node.js 的 `video-renderer/`，后续会逐步支持小红书、视频号、抖音、今日头条等平台适配。**质量与多平台实施路线图**见 `docs/architecture-quality-roadmap.md`；架构规范见 `docs/content-engine-architecture.md`。
> 
> 为了减少后续沟通和 token 消耗，项目维护规范已沉淀为本地 Codex skill：`/Users/zhangmiao/.codex/skills/hotspot-content-engine`。后续让 Codex 改这个项目时，可以直接提到 `hotspot-content-engine`。
>
> 模型上手卡片见 `CODEX.md`，后续改代码优先读它。

它会做三件事：

1. 抓取热点候选，比如百度热搜。
2. 结合账号定位，用 DeepSeek 或 OpenAI 生成小红书标题、正文、话题标签和封面建议。
3. 默认在本地生成适合小红书首图/封面的竖版文字封面，不消耗 OpenAI 图片额度。
4. 保存到 `output/YYYY-MM-DD/`，方便你审核后发布。

## 为什么默认不直接登录发布

小红书公开、稳定、面向普通账号的发帖 API 并不明确。为了避免账号风控和违反平台规则，本项目默认是 `draft_only`：自动生成、人工审核、手动发布。

如果你有合规的发布接口，可以在 `config.json` 的 `publisher.api_endpoint` 配置，程序会把草稿 JSON POST 到你的接口。

不要把小红书账号密码写进配置文件，也不要发到聊天里。需要进入小红书创作中心时，建议你自己在浏览器里登录；程序只负责生成和展示草稿。

## 初始化

```bash
cd /Users/zhangmiao/Documents/Codex/xhs-hotspot-poster
cp config.example.json config.json
python3 -m xhs_hotspot_poster --once
```

默认用 DeepSeek。你的 `.env.local` 需要包含：

```env
LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=你的DeepSeek key
DEEPSEEK_MODEL=deepseek-v4-flash
```

如果要切回 OpenAI：

```env
LLM_PROVIDER=openai
OPENAI_API_KEY=你的key
OPENAI_MODEL=gpt-5.2
```

可选：

```env
OPENAI_IMAGE_MODEL=gpt-image-2
XHS_API_TOKEN=你的发布接口token
TENCENTCLOUD_SECRET_ID=你的腾讯云SecretId
TENCENTCLOUD_SECRET_KEY=你的腾讯云SecretKey
PEXELS_API_KEY=你的Pexels key
PIXABAY_API_KEY=你的Pixabay key
```

## 每天自动运行

macOS 可以用 launchd：

```bash
./scripts/install_launchd.sh
```

默认每天 09:30 运行一次。日志在 `logs/` 目录。

## 常用命令

```bash
python3 -m xhs_hotspot_poster --once
python3 -m xhs_hotspot_poster --config config.json --dry-run
python3 -m xhs_hotspot_poster --serve
python3 -m xhs_hotspot_poster --publish
```

`--publish` 只有在 `publisher.mode` 不是 `draft_only` 且配置了合规发布接口时才会发送。

低成本健康检查：

```bash
/Users/zhangmiao/.codex/skills/hotspot-content-engine/scripts/health_check.sh
```

## 本地生成视频

草稿台支持把单篇草稿生成 9:16 口播卡片视频。视频核心逻辑在 Node.js 子目录 `video-renderer/`，Python 只负责从 Web 界面调用它。

```bash
node video-renderer/src/render.js \
  --post output/YYYY-MM-DD/某篇草稿.json \
  --config config.json
```

第一版不会抓取 YouTube，也不会调用 AI 视频模型。它会把草稿重写成视频专用的分析口播稿，按关键词选择可视化方式，并按 `video_generation.image_providers` 的顺序检索或生成图片源。默认优先使用即梦/火山方舟文生图，再回退到 Pexels、Pixabay、Wikimedia、腾讯云 WIMGS；未配置对应密钥时会自动跳过。即梦默认每条视频最多生成 1 张，按 0.25 元/张写回成本和额度；腾讯 WIMGS 默认最多 1 次，按 0.06 元/次估算。随后调用腾讯云 TTS 或本机语音生成配音，再用 `ffmpeg` 合成 MP4。生成结果会写回草稿 JSON 的 `video_plan` 和 `generated_video` 字段，并额外导出 `.srt` 字幕文件。

## 可视化查看

```bash
python3 -m xhs_hotspot_poster --serve
```

然后打开：

```text
http://127.0.0.1:8765
```

页面里每篇草稿都有 `生成封面图` 按钮。默认生成纯背景 + 大字标题的小红书常见封面，图片会保存到当天目录的 `assets/` 子目录，并自动显示在预览区。

`准备发布到草稿` 会复制标题、正文和标签，自动准备封面图，并打开小红书创作中心。你需要自己登录小红书；程序不会保存账号密码。保存草稿或发布前请人工确认内容。

同时它会生成一个发布包目录，里面固定包含：

```text
cover.png
publish.txt
title.txt
body.txt
hashtags.txt
```

如果浏览器自动化不可用，你只需要上传 `cover.png`，再把 `publish.txt` 粘贴到正文区。

如果当前草稿已经生成视频，发布包会额外包含：

```text
video.mp4
video_script.txt
subtitles.srt
```

如果你把 `config.json` 里的 `image_generation.provider` 改成其他 API 图片方案，看到 `billing_hard_limit_reached` 或 `insufficient_quota`，说明 OpenAI Platform 账单额度不足，需要在 Platform 里调整充值、账单或 hard limit 后重试。
