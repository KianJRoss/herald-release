# Derived from pal-mcp-server (https://github.com/BeehiveInnovations/pal-mcp-server), file providers/registries/xai.py.
# Copyright 2025 Beehive Innovations. Licensed under the Apache License, Version 2.0;
# see LICENSES/Apache-2.0-pal-mcp-server.txt and THIRD_PARTY_NOTICES.md. Unmodified copy.
"""Registry loader for X.AI model capabilities."""

from __future__ import annotations

from ..shared import ProviderType
from .base import CapabilityModelRegistry


class XAIModelRegistry(CapabilityModelRegistry):
    """Capability registry backed by ``conf/xai_models.json``."""

    def __init__(self, config_path: str | None = None) -> None:
        super().__init__(
            env_var_name="XAI_MODELS_CONFIG_PATH",
            default_filename="xai_models.json",
            provider=ProviderType.XAI,
            friendly_prefix="X.AI ({model})",
            config_path=config_path,
        )
