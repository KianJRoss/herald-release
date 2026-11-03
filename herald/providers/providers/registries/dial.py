# Derived from pal-mcp-server (https://github.com/BeehiveInnovations/pal-mcp-server), file providers/registries/dial.py.
# Copyright 2025 Beehive Innovations. Licensed under the Apache License, Version 2.0;
# see LICENSES/Apache-2.0-pal-mcp-server.txt and THIRD_PARTY_NOTICES.md. Unmodified copy.
"""Registry loader for DIAL provider capabilities."""

from __future__ import annotations

from ..shared import ProviderType
from .base import CapabilityModelRegistry


class DialModelRegistry(CapabilityModelRegistry):
    """Capability registry backed by ``conf/dial_models.json``."""

    def __init__(self, config_path: str | None = None) -> None:
        super().__init__(
            env_var_name="DIAL_MODELS_CONFIG_PATH",
            default_filename="dial_models.json",
            provider=ProviderType.DIAL,
            friendly_prefix="DIAL ({model})",
            config_path=config_path,
        )
