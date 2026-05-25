from __future__ import annotations

import json
import mimetypes
import shutil
import subprocess
import sys
from datetime import datetime
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from .config import AppConfig, PROJECT_ROOT
from .images import attach_uploaded_image_to_post, generate_image_for_post, generate_local_cover_for_post, generate_openai_image_for_post
from .openai_client import OpenAIError
from .video_bridge import VideoGenerationError, generate_local_video_for_post


WEB_ROOT = PROJECT_ROOT / "web"


def remove_prefix(value: str, prefix: str) -> str:
    return value[len(prefix) :] if value.startswith(prefix) else value


def remove_suffix(value: str, suffix: str) -> str:
    return value[: -len(suffix)] if suffix and value.endswith(suffix) else value


def datetime_now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def list_drafts(output_dir: Path, limit: int = 10) -> list[dict[str, object]]:
    drafts: list[dict[str, object]] = []
    if not output_dir.exists():
        return drafts
    for path in sorted(output_dir.glob("*/*.json"), reverse=True):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        drafts.append(
            {
                "id": path.relative_to(output_dir).as_posix(),
                "date": path.parent.name,
                "filename": path.name,
                "topic": data.get("selected_topic", path.stem),
                "cover_text": data.get("cover_text", ""),
                "generated_at": data.get("generated_at", ""),
                "model": data.get("model", ""),
                "has_error": bool(data.get("generation_error")),
                "has_image": bool((data.get("generated_image") or {}).get("path")) if isinstance(data.get("generated_image"), dict) else False,
                "has_video": bool((data.get("generated_video") or {}).get("path")) if isinstance(data.get("generated_video"), dict) else False,
                "has_image_error": bool(data.get("image_generation_error")),
                "has_video_error": bool(data.get("video_generation_error")),
                "hashtags": data.get("hashtags", []),
            }
        )
        if len(drafts) >= limit:
            break
    return drafts


class DashboardHandler(BaseHTTPRequestHandler):
    config: AppConfig

    def log_message(self, format: str, *args: object) -> None:
        return

    def do_HEAD(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/drafts":
            self.send_json(list_drafts(self.config.output_dir), head_only=True)
            return
        if parsed.path.startswith("/assets/"):
            self.send_output_asset(remove_prefix(parsed.path, "/assets/"), head_only=True)
            return
        self.send_static(parsed.path, head_only=True)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/drafts":
            self.send_json(list_drafts(self.config.output_dir))
            return
        if parsed.path.startswith("/api/drafts/"):
            self.send_draft(remove_prefix(parsed.path, "/api/drafts/"))
            return
        if parsed.path.startswith("/assets/"):
            self.send_output_asset(remove_prefix(parsed.path, "/assets/"))
            return
        self.send_static(parsed.path)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/generate-once":
            self.generate_once()
            return
        if parsed.path.startswith("/api/drafts/") and parsed.path.endswith("/publish-package"):
            draft_id = remove_suffix(remove_prefix(parsed.path, "/api/drafts/"), "/publish-package")
            self.create_publish_package(draft_id)
            return
        if parsed.path.startswith("/api/drafts/") and parsed.path.endswith("/image-local"):
            draft_id = remove_suffix(remove_prefix(parsed.path, "/api/drafts/"), "/image-local")
            self.generate_draft_image(draft_id, provider="local")
            return
        if parsed.path.startswith("/api/drafts/") and parsed.path.endswith("/image-ai"):
            draft_id = remove_suffix(remove_prefix(parsed.path, "/api/drafts/"), "/image-ai")
            self.generate_draft_image(draft_id, provider="ai")
            return
        if parsed.path.startswith("/api/drafts/") and parsed.path.endswith("/upload-image"):
            draft_id = remove_suffix(remove_prefix(parsed.path, "/api/drafts/"), "/upload-image")
            self.upload_draft_image(draft_id)
            return
        if parsed.path.startswith("/api/drafts/") and parsed.path.endswith("/video-local"):
            draft_id = remove_suffix(remove_prefix(parsed.path, "/api/drafts/"), "/video-local")
            self.generate_draft_video(draft_id)
            return
        if parsed.path.startswith("/api/drafts/") and parsed.path.endswith("/video-plan-local"):
            draft_id = remove_suffix(remove_prefix(parsed.path, "/api/drafts/"), "/video-plan-local")
            self.generate_draft_video_plan(draft_id)
            return
        if parsed.path.startswith("/api/drafts/") and parsed.path.endswith("/video-script"):
            draft_id = remove_suffix(remove_prefix(parsed.path, "/api/drafts/"), "/video-script")
            self.update_draft_video_script(draft_id)
            return
        if parsed.path.startswith("/api/drafts/") and parsed.path.endswith("/image"):
            draft_id = remove_suffix(remove_prefix(parsed.path, "/api/drafts/"), "/image")
            self.generate_draft_image(draft_id)
            return
        self.send_error(404)

    def generate_once(self) -> None:
        command = [
            sys.executable,
            "-m",
            "xhs_hotspot_poster",
            "--config",
            str(self.config.path),
            "--once",
        ]
        try:
            result = subprocess.run(
                command,
                cwd=PROJECT_ROOT,
                check=True,
                text=True,
                capture_output=True,
                timeout=600,
            )
        except subprocess.TimeoutExpired as exc:
            self.send_json({"ok": False, "error": "生成超时，已超过 10 分钟。", "stdout": exc.stdout or "", "stderr": exc.stderr or ""})
            return
        except subprocess.CalledProcessError as exc:
            detail = (exc.stderr or exc.stdout or "").strip()
            self.send_json({"ok": False, "error": detail or "生成失败。", "stdout": exc.stdout or "", "stderr": exc.stderr or ""})
            return
        generated_paths = parse_generated_paths(result.stdout or "")
        latest_draft_id = ""
        if generated_paths:
            latest_path = Path(generated_paths[-1])
            try:
                latest_draft_id = latest_path.relative_to(self.config.output_dir).as_posix()
            except ValueError:
                latest_draft_id = ""
        self.send_json({
            "ok": True,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "generated_paths": generated_paths,
            "latest_draft_id": latest_draft_id,
            "drafts": list_drafts(self.config.output_dir),
        })

    def send_draft(self, draft_id: str) -> None:
        path = self.resolve_output_path(draft_id)
        if not path or path.suffix != ".json" or not path.exists():
            self.send_error(404)
            return
        self.send_json(json.loads(path.read_text(encoding="utf-8")))

    def generate_draft_image(self, draft_id: str, provider: str | None = None) -> None:
        path = self.resolve_output_path(draft_id)
        if not path or path.suffix != ".json" or not path.exists():
            self.send_error(404)
            return
        post = json.loads(path.read_text(encoding="utf-8"))
        try:
            if provider == "local":
                image_path = generate_local_cover_for_post(post, self.config, path)
            elif provider == "ai":
                image_path = generate_openai_image_for_post(post, self.config, path)
            else:
                image_path = generate_image_for_post(post, self.config, path)
        except (OpenAIError, ValueError) as exc:
            post["image_generation_error"] = str(exc)[:1000]
            path.write_text(json.dumps(post, ensure_ascii=False, indent=2), encoding="utf-8")
            self.send_json({"ok": False, "error": str(exc), "draft": post})
            return
        self.send_json({"ok": True, "image_path": image_path.relative_to(self.config.output_dir).as_posix(), "draft": post})

    def upload_draft_image(self, draft_id: str) -> None:
        path = self.resolve_output_path(draft_id)
        if not path or path.suffix != ".json" or not path.exists():
            self.send_error(404)
            return
        content_type = self.headers.get("Content-Type", "")
        if not content_type.startswith("multipart/form-data"):
            self.send_error(400, "Expected multipart/form-data")
            return
        post = json.loads(path.read_text(encoding="utf-8"))
        length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(length)
        message = BytesParser(policy=default).parsebytes(
            f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8") + raw_body
        )
        image_part = None
        for part in message.iter_parts():
            if part.get_param("name", header="content-disposition") == "image":
                image_part = part
                break
        if image_part is None or not image_part.get_filename():
            self.send_error(400, "Missing image file")
            return
        try:
            image_path = attach_uploaded_image_to_post(
                post=post,
                config=self.config,
                draft_path=path,
                image_bytes=image_part.get_payload(decode=True) or b"",
                filename=image_part.get_filename() or "uploaded.png",
            )
        except ValueError as exc:
            self.send_json({"ok": False, "error": str(exc), "draft": post})
            return
        self.send_json({"ok": True, "image_path": image_path.relative_to(self.config.output_dir).as_posix(), "draft": post})

    def generate_draft_video(self, draft_id: str) -> None:
        path = self.resolve_output_path(draft_id)
        if not path or path.suffix != ".json" or not path.exists():
            self.send_error(404)
            return
        try:
            result = generate_local_video_for_post(self.config, path)
            post = json.loads(path.read_text(encoding="utf-8"))
        except VideoGenerationError as exc:
            post = json.loads(path.read_text(encoding="utf-8"))
            post["video_generation_error"] = str(exc)[:2000]
            path.write_text(json.dumps(post, ensure_ascii=False, indent=2), encoding="utf-8")
            self.send_json({"ok": False, "error": str(exc), "draft": post})
            return
        self.send_json({"ok": True, "result": result, "draft": post})

    def generate_draft_video_plan(self, draft_id: str) -> None:
        path = self.resolve_output_path(draft_id)
        if not path or path.suffix != ".json" or not path.exists():
            self.send_error(404)
            return
        try:
            result = generate_local_video_for_post(self.config, path, plan_only=True, fresh=True)
            post = json.loads(path.read_text(encoding="utf-8"))
        except VideoGenerationError as exc:
            post = json.loads(path.read_text(encoding="utf-8"))
            post["video_generation_error"] = str(exc)[:2000]
            path.write_text(json.dumps(post, ensure_ascii=False, indent=2), encoding="utf-8")
            self.send_json({"ok": False, "error": str(exc), "draft": post})
            return
        self.send_json({"ok": True, "result": result, "draft": post})

    def update_draft_video_script(self, draft_id: str) -> None:
        path = self.resolve_output_path(draft_id)
        if not path or path.suffix != ".json" or not path.exists():
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        voiceover = str(payload.get("voiceover", "")).strip()
        post = json.loads(path.read_text(encoding="utf-8"))
        if not post.get("video_plan"):
            try:
                generate_local_video_for_post(self.config, path, plan_only=True, fresh=True)
                post = json.loads(path.read_text(encoding="utf-8"))
            except VideoGenerationError as exc:
                self.send_json({"ok": False, "error": str(exc), "draft": post})
                return
        post["video_plan"]["voiceover"] = voiceover
        post["video_plan"]["edited_at"] = datetime_now()
        path.write_text(json.dumps(post, ensure_ascii=False, indent=2), encoding="utf-8")
        self.send_json({"ok": True, "draft": post})

    def create_publish_package(self, draft_id: str) -> None:
        path = self.resolve_output_path(draft_id)
        if not path or path.suffix != ".json" or not path.exists():
            self.send_error(404)
            return
        post = json.loads(path.read_text(encoding="utf-8"))
        if not post.get("generated_image", {}).get("path"):
            image_path = generate_image_for_post(post, self.config, path)
        else:
            image_path = self.config.output_dir / post["generated_image"]["path"]

        title = first_title(post)
        body = str(post.get("body", "")).strip()
        hashtags = " ".join(str(tag) for tag in post.get("hashtags", []))
        video_path = None
        if post.get("generated_video", {}).get("path"):
            video_path = self.config.output_dir / post["generated_video"]["path"]
        video_script = video_script_text(post)
        export_dir = create_publish_export(path, image_path, title, body, hashtags, video_path=video_path, video_script=video_script)
        latest_package_path = PROJECT_ROOT / "tmp" / "latest_publish_package.json"
        temp_package_path = Path("/private/tmp/xhs_publish_package.json")
        package = {
            "ok": True,
            "creator_url": "https://creator.xiaohongshu.com/",
            "selected_draft_id": path.relative_to(self.config.output_dir).as_posix(),
            "title": title,
            "body": body,
            "hashtags": hashtags,
            "combined_text": "\n\n".join(part for part in [title, body, hashtags] if part),
            "image_url": f"/assets/{image_path.relative_to(self.config.output_dir).as_posix()}",
            "image_path": str(image_path),
            "export_dir": str(export_dir),
            "publish_txt": str(export_dir / "publish.txt"),
            "cover_png": str(export_dir / "cover.png"),
            "video_path": str(video_path) if video_path and video_path.exists() else "",
            "video_url": f"/assets/{video_path.relative_to(self.config.output_dir).as_posix()}" if video_path and video_path.exists() else "",
            "video_script": video_script,
            "draft": post,
            "latest_package_json": str(latest_package_path),
            "temp_package_json": str(temp_package_path),
        }
        write_publish_package_pointer(package, latest_package_path)
        write_publish_package_pointer(package, temp_package_path)
        self.send_json(package)

    def send_output_asset(self, asset_id: str, *, head_only: bool = False) -> None:
        path = self.resolve_output_path(asset_id)
        if not path or not path.exists() or path.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp", ".svg", ".mp4", ".aiff", ".txt", ".srt"}:
            self.send_error(404)
            return
        mime_type = mimetypes.guess_type(path.name)[0] or "image/png"
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if head_only:
            return
        self.write_body(body)

    def resolve_output_path(self, relative_id: str) -> Path | None:
        safe_id = unquote(relative_id).lstrip("/")
        path = (self.config.output_dir / safe_id).resolve()
        output_root = self.config.output_dir.resolve()
        if path == output_root or output_root not in path.parents:
            return None
        return path

    def send_static(self, request_path: str, *, head_only: bool = False) -> None:
        relative = "index.html" if request_path in ("", "/") else request_path.lstrip("/")
        path = (WEB_ROOT / relative).resolve()
        if WEB_ROOT.resolve() not in path.parents and path != WEB_ROOT.resolve():
            self.send_error(403)
            return
        if not path.exists() or path.is_dir():
            self.send_error(404)
            return
        mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", f"{mime_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if head_only:
            return
        self.write_body(body)

    def send_json(self, payload: object, *, head_only: bool = False) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if head_only:
            return
        self.write_body(body)

    def write_body(self, body: bytes) -> None:
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            return


def serve_dashboard(config: AppConfig, host: str = "127.0.0.1", port: int = 8765) -> None:
    handler = type("ConfiguredDashboardHandler", (DashboardHandler,), {"config": config})
    server = ThreadingHTTPServer((host, port), handler)
    print(f"Dashboard running at http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nDashboard stopped.")


def parse_generated_paths(stdout: str) -> list[str]:
    paths: list[str] = []
    collecting = False
    for line in stdout.splitlines():
      value = line.strip()
      if value == "Generated drafts:":
          collecting = True
          continue
      if collecting and value.endswith(".json"):
          paths.append(value)
    return paths


def first_title(post: dict[str, object]) -> str:
    titles = post.get("title_options", [])
    if isinstance(titles, list) and titles:
        return str(titles[0])
    return str(post.get("selected_topic", "小红书草稿"))


def create_publish_export(
    draft_path: Path,
    image_path: Path,
    title: str,
    body: str,
    hashtags: str,
    *,
    video_path: Path | None = None,
    video_script: str = "",
) -> Path:
    export_dir = draft_path.parent / "publish_packages" / draft_path.stem
    export_dir.mkdir(parents=True, exist_ok=True)
    cover_target = export_dir / "cover.png"
    ensure_png_cover(image_path, cover_target)
    combined = "\n\n".join(part for part in [title, body, hashtags] if part)
    (export_dir / "publish.txt").write_text(combined, encoding="utf-8")
    (export_dir / "title.txt").write_text(title, encoding="utf-8")
    (export_dir / "body.txt").write_text(body, encoding="utf-8")
    (export_dir / "hashtags.txt").write_text(hashtags, encoding="utf-8")
    if video_path and video_path.exists():
        shutil.copy2(video_path, export_dir / "video.mp4")
        (export_dir / "video_script.txt").write_text(video_script, encoding="utf-8")
        subtitle_path = video_subtitle_path(draft_path, video_path)
        if subtitle_path and subtitle_path.exists():
            shutil.copy2(subtitle_path, export_dir / "subtitles.srt")
    return export_dir


def ensure_png_cover(image_path: Path, cover_target: Path) -> None:
    if image_path.suffix.lower() == ".png":
        shutil.copy2(image_path, cover_target)
        return

    sips = shutil.which("sips")
    if sips:
        try:
            subprocess.run(
                [sips, "-s", "format", "png", str(image_path), "--out", str(cover_target)],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if cover_target.exists():
                return
        except (OSError, subprocess.CalledProcessError):
            pass

    shutil.copy2(image_path, cover_target)


def write_publish_package_pointer(package: dict[str, object], target_path: Path) -> None:
    target_path.parent.mkdir(parents=True, exist_ok=True)
    target_path.write_text(json.dumps(package, ensure_ascii=False, indent=2), encoding="utf-8")


def video_script_text(post: dict[str, object]) -> str:
    plan = post.get("video_plan", {})
    if not isinstance(plan, dict):
        return ""
    lines = ["# 视频口播稿", "", str(plan.get("voiceover", ""))]
    scenes = plan.get("scenes", [])
    if isinstance(scenes, list):
        lines.extend(["", "# 分镜"])
        for scene in scenes:
            if isinstance(scene, dict):
                lines.append(f"- {scene.get('title', '')}｜{scene.get('subtitle', '')}")
    return "\n".join(lines).strip() + "\n"


def video_subtitle_path(draft_path: Path, video_path: Path) -> Path | None:
    try:
        post = json.loads(draft_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    subtitle = post.get("generated_video", {}).get("subtitle_path")
    if subtitle:
        return draft_path.parents[1] / subtitle
    fallback = video_path.with_name(video_path.name.replace("-video.mp4", "-subtitles.srt"))
    return fallback
