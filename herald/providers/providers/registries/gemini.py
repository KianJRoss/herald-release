# Derived from pal-mcp-server (https://github.com/BeehiveInnovations/pal-mcp-server), file providers/registries/gemini.py.
# Copyright 2025 Beehive Innovations. Licensed under the Apache License, Version 2.0;
# see LICENSES/Apache-2.0-pal-mcp-server.txt and THIRD_PARTY_NOTICES.md. Unmodified copy.
"""Registry loader for Gemini model capabilities."""

from __future__ import annotations

from ..shared import ProviderType
from .base import CapabilityModelRegistry


class GeminiModelRegistry(CapabilityModelRegistry):
    """Capability registry backed by ``conf/gemini_models.json``."""

    def __init__(self, config_path: str | None = None) -> None:
        super().__init__(
            env_var_name="GEMINI_MODELS_CONFIG_PATH",
            default_filename="gemini_models.json",
            provider=ProviderType.GOOGLE,
            friendly_prefix="Gemini ({model})",
            config_path=config_path,
        )
