# Derived from pal-mcp-server (https://github.com/BeehiveInnovations/pal-mcp-server), file providers/shared/model_response.py.
# Copyright 2025 Beehive Innovations. Licensed under the Apache License, Version 2.0;
# see LICENSES/Apache-2.0-pal-mcp-server.txt and THIRD_PARTY_NOTICES.md. Unmodified copy.
"""Dataclass used to normalise provider SDK responses."""

from dataclasses import dataclass, field
from typing import Any

from .provider_type import ProviderType

__all__ = ["ModelResponse"]


@dataclass
class ModelResponse:
    """Portable representation of a provider completion."""

    content: str
    usage: dict[str, int] = field(default_factory=dict)
    model_name: str = ""
    friendly_name: str = ""
    provider: ProviderType = ProviderType.GOOGLE
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def total_tokens(self) -> int:
        """Return the total token count if the provider reported usage data."""

        return self.usage.get("total_tokens", 0)
