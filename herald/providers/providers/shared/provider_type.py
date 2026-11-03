# Derived from pal-mcp-server (https://github.com/BeehiveInnovations/pal-mcp-server), file providers/shared/provider_type.py.
# Copyright 2025 Beehive Innovations. Licensed under the Apache License, Version 2.0;
# see LICENSES/Apache-2.0-pal-mcp-server.txt and THIRD_PARTY_NOTICES.md. Modified for Herald.
"""Enumeration describing which backend owns a given model."""

from enum import Enum

__all__ = ["ProviderType"]


class ProviderType(Enum):
    """Canonical identifiers for every supported provider backend."""

    GOOGLE = "google"
    OPENAI = "openai"
    AZURE = "azure"
    XAI = "xai"
    MISTRAL = "mistral"
    DEEPSEEK = "deepseek"
    OPENROUTER = "openrouter"
    CUSTOM = "custom"
    DIAL = "dial"
    G4F = "g4f"
