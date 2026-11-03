# Derived from pal-mcp-server (https://github.com/BeehiveInnovations/pal-mcp-server), file providers/registries/custom.py.
# Copyright 2025 Beehive Innovations. Licensed under the Apache License, Version 2.0;
# see LICENSES/Apache-2.0-pal-mcp-server.txt and THIRD_PARTY_NOTICES.md. Unmodified copy.
"""Registry loader for custom OpenAI-compatible endpoints."""

from __future__ import annotations

from ..shared import ModelCapabilities, ProviderType
from .base import CAPABILITY_FIELD_NAMES, CapabilityModelRegistry


class CustomEndpointModelRegistry(CapabilityModelRegistry):
    """Capability registry backed by ``conf/custom_models.json``."""

    def __init__(self, config_path: str | None = None) -> None:
        super().__init__(
            env_var_name="CUSTOM_MODELS_CONFIG_PATH",
            default_filename="custom_models.json",
            provider=ProviderType.CUSTOM,
            friendly_prefix="Custom ({model})",
            config_path=config_path,
        )

    def _finalise_entry(self, entry: dict) -> tuple[ModelCapabilities, dict]:
        filtered = {k: v for k, v in entry.items() if k in CAPABILITY_FIELD_NAMES}
        filtered.setdefault("provider", ProviderType.CUSTOM)
        capability = ModelCapabilities(**filtered)
        return capability, {}
