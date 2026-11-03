# Derived from pal-mcp-server (https://github.com/BeehiveInnovations/pal-mcp-server), file clink/parsers/base.py.
# Copyright 2025 Beehive Innovations. Licensed under the Apache License, Version 2.0;
# see LICENSES/Apache-2.0-pal-mcp-server.txt and THIRD_PARTY_NOTICES.md. Unmodified copy.
"""Parser interfaces for clink runner outputs."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class ParsedCLIResponse:
    """Result of parsing CLI stdout/stderr."""

    content: str
    metadata: dict[str, Any]


class ParserError(RuntimeError):
    """Raised when CLI output cannot be parsed into a structured response."""


class BaseParser:
    """Base interface for CLI output parsers."""

    name: str = "base"

    def parse(self, stdout: str, stderr: str) -> ParsedCLIResponse:
        raise NotImplementedError("Parsers must implement parse()")
