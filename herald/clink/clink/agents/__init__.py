# Derived from pal-mcp-server (https://github.com/BeehiveInnovations/pal-mcp-server), file clink/agents/__init__.py.
# Copyright 2025 Beehive Innovations. Licensed under the Apache License, Version 2.0;
# see LICENSES/Apache-2.0-pal-mcp-server.txt and THIRD_PARTY_NOTICES.md. Modified for Herald.
"""Agent factory for clink CLI integrations."""

from __future__ import annotations

from clink.models import ResolvedCLIClient

from .base import AgentOutput, BaseCLIAgent, CLIAgentError
from .claude import ClaudeAgent
from .codex import CodexAgent
from .gemini import GeminiAgent

_AGENTS: dict[str, type[BaseCLIAgent]] = {
    "antigravity": BaseCLIAgent,
    "agy": BaseCLIAgent,
    "gemini": BaseCLIAgent,
    "codex": CodexAgent,
    "claude": ClaudeAgent,
}


def create_agent(client: ResolvedCLIClient) -> BaseCLIAgent:
    agent_key = (client.runner or client.name).lower()
    agent_cls = _AGENTS.get(agent_key, BaseCLIAgent)
    return agent_cls(client)


__all__ = [
    "AgentOutput",
    "BaseCLIAgent",
    "CLIAgentError",
    "create_agent",
]
