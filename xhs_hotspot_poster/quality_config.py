from __future__ import annotations

from copy import deepcopy
from typing import Any


def merge_quality_profile(data: dict[str, Any]) -> dict[str, Any]:
    """Apply quality_profiles[tier] onto image_generation and video_generation."""
    merged = deepcopy(data)
    tier = str(merged.get("quality_tier") or "standard").strip()
    profiles = merged.get("quality_profiles") or {}
    profile = profiles.get(tier) if isinstance(profiles, dict) else {}
    if not isinstance(profile, dict):
        profile = {}

    image_profile = profile.get("image_generation") if isinstance(profile.get("image_generation"), dict) else {}
    video_profile = profile.get("video_generation") if isinstance(profile.get("video_generation"), dict) else {}

    base_image = merged.get("image_generation") if isinstance(merged.get("image_generation"), dict) else {}
    base_video = merged.get("video_generation") if isinstance(merged.get("video_generation"), dict) else {}

    merged["image_generation"] = {**base_image, **image_profile}
    merged["video_generation"] = {**base_video, **video_profile}
    merged["effective_quality_tier"] = tier
    return merged
