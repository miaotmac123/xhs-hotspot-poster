from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


@dataclass(frozen=True)
class AppConfig:
    data: dict[str, Any]
    path: Path

    @property
    def posts_per_day(self) -> int:
        return int(self.data.get("generation", {}).get("posts_per_day", 1))

    @property
    def candidate_count(self) -> int:
        return int(self.data.get("generation", {}).get("candidate_count", 8))

    @property
    def model(self) -> str:
        configured = self.data.get("generation", {}).get("model", "gpt-5.2")
        provider = self.llm_provider
        if provider == "deepseek":
            return os.getenv("DEEPSEEK_MODEL", configured)
        return os.getenv("OPENAI_MODEL", configured)

    @property
    def llm_provider(self) -> str:
        configured = self.data.get("generation", {}).get("provider", "openai")
        return os.getenv("LLM_PROVIDER", configured).lower()

    @property
    def temperature(self) -> float:
        return float(self.data.get("generation", {}).get("temperature", 0.8))

    @property
    def image_model(self) -> str:
        configured = self.data.get("image_generation", {}).get("model", "gpt-image-2")
        return os.getenv("OPENAI_IMAGE_MODEL", configured)

    @property
    def image_size(self) -> str:
        return str(self.data.get("image_generation", {}).get("size", "1024x1536"))

    @property
    def image_quality(self) -> str:
        return str(self.data.get("image_generation", {}).get("quality", "high"))

    @property
    def image_generation_enabled(self) -> bool:
        return bool(self.data.get("image_generation", {}).get("enabled", True))

    @property
    def output_dir(self) -> Path:
        return self.path.parent / "output"


def load_config(config_path: str | None = None) -> AppConfig:
    load_env_file(PROJECT_ROOT / ".env.local")
    load_env_file(PROJECT_ROOT / ".env")

    path = Path(config_path).expanduser() if config_path else PROJECT_ROOT / "config.json"
    if not path.exists():
        example = PROJECT_ROOT / "config.example.json"
        if example.exists():
            path.write_text(example.read_text(encoding="utf-8"), encoding="utf-8")
        else:
            raise FileNotFoundError(f"Config file not found: {path}")
    return AppConfig(data=json.loads(path.read_text(encoding="utf-8")), path=path)
