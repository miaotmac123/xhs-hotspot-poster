from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from .config import PROJECT_ROOT


@dataclass(frozen=True)
class ProofreadIssue:
    category: str
    label: str
    match: str
    penalty: int


@dataclass(frozen=True)
class ProofreadResult:
    score: int
    base_score: int
    pass_score: int
    passed: bool
    issues: list[ProofreadIssue]


def load_tone_rules(config_data: dict[str, Any] | None = None) -> dict[str, Any]:
    if config_data:
        custom = config_data.get("ai_tone_rules")
        if isinstance(custom, dict) and custom.get("categories"):
            return custom
    path = PROJECT_ROOT / "config" / "ai_tone_rules.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {"base_score": 100, "pass_score": 85, "categories": []}


def proofread_text(text: str, config_data: dict[str, Any] | None = None) -> ProofreadResult:
    rules = load_tone_rules(config_data)
    base_score = int(rules.get("base_score", 100))
    pass_score = int(rules.get("pass_score", 85))
    issues: list[ProofreadIssue] = []
    total_penalty = 0

    for category in rules.get("categories", []):
        if not isinstance(category, dict):
            continue
        penalty = int(category.get("penalty", 5))
        label = str(category.get("label", category.get("id", "规则")))
        cat_id = str(category.get("id", "rule"))
        for pattern in category.get("patterns", []):
            try:
                matches = re.findall(str(pattern), text, flags=re.I)
            except re.error:
                continue
            for match in matches[:3]:
                snippet = match if isinstance(match, str) else str(match)
                issues.append(
                    ProofreadIssue(
                        category=cat_id,
                        label=label,
                        match=snippet[:80],
                        penalty=penalty,
                    )
                )
                total_penalty += penalty

    score = max(0, min(100, base_score - total_penalty))
    return ProofreadResult(
        score=score,
        base_score=base_score,
        pass_score=pass_score,
        passed=score >= pass_score,
        issues=issues,
    )


def proofread_post_text(post: dict[str, Any]) -> str:
    parts = [
        str(post.get("selected_topic", "")),
        " ".join(str(item) for item in post.get("title_options", []) if item),
        str(post.get("body", "")),
        str(post.get("angle", "")),
    ]
    packages = post.get("platform_packages")
    if isinstance(packages, dict):
        wechat = packages.get("wechat")
        if isinstance(wechat, dict):
            parts.append(str(wechat.get("body", "")))
    return "\n".join(part for part in parts if part.strip())


def proofread_result_to_dict(result: ProofreadResult) -> dict[str, Any]:
    return {
        "score": result.score,
        "base_score": result.base_score,
        "pass_score": result.pass_score,
        "passed": result.passed,
        "issues": [
            {
                "category": issue.category,
                "label": issue.label,
                "match": issue.match,
                "penalty": issue.penalty,
            }
            for issue in result.issues[:20]
        ],
    }
