"""Internal defaults and constants for clink."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_TIMEOUT_SECONDS = 1800
DEFAULT_STREAM_LIMIT = 10 * 1024 * 1024  # 10MB per stream

PROJECT_ROOT = Path(__file__).resolve().parent.parent
BUILTIN_PROMPTS_DIR = PROJECT_ROOT / "systemprompts" / "clink"
CONFIG_DIR = PROJECT_ROOT / "conf" / "cli_clients"
USER_CONFIG_DIR = Path.home() / ".pal" / "cli_clients"


@dataclass(frozen=True)
class CLIInternalDefaults:
    """Internal defaults applied to a CLI client during registry load."""

    parser: str
    additional_args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    default_role_prompt: str | None = None
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS
    runner: str | None = None


# Each CLI's own flag for running without permission prompts. Never shipped as a
# default: a deployment opts in with HERALD_CLI_FULL_PERMISSIONS=1 (headless
# Herald runs cannot answer a prompt, so an owner who delegates fully sets it).
FULL_PERMISSION_ARGS: dict[str, list[str]] = {
    "antigravity": ["--dangerously-skip-permissions"],
    "agy": ["--dangerously-skip-permissions"],
    "gemini": ["--dangerously-skip-permissions"],
    "codex": ["--dangerously-bypass-approvals-and-sandbox"],
    "claude": ["--dangerously-skip-permissions"],
}
FULL_PERMISSIONS_ENV = "HERALD_CLI_FULL_PERMISSIONS"


INTERNAL_DEFAULTS: dict[str, CLIInternalDefaults] = {
    "antigravity": CLIInternalDefaults(
        parser="antigravity_json",
        additional_args=["--output-format", "json"],
        default_role_prompt="systemprompts/clink/default.txt",
        runner="antigravity",
    ),
    "agy": CLIInternalDefaults(
        parser="antigravity_json",
        additional_args=["--output-format", "json"],
        default_role_prompt="systemprompts/clink/default.txt",
        runner="antigravity",
    ),
    "gemini": CLIInternalDefaults(
        parser="antigravity_json",
        additional_args=["--output-format", "json"],
        default_role_prompt="systemprompts/clink/default.txt",
        runner="antigravity",
    ),
    "codex": CLIInternalDefaults(
        parser="codex_jsonl",
        additional_args=["exec"],
        default_role_prompt="systemprompts/clink/default.txt",
        runner="codex",
    ),
    "claude": CLIInternalDefaults(
        parser="claude_json",
        additional_args=["--print", "--output-format", "json"],
        default_role_prompt="systemprompts/clink/default.txt",
        runner="claude",
    ),
    "lmstudio": CLIInternalDefaults(
        parser="lmstudio_json",
        additional_args=[],
        default_role_prompt="systemprompts/clink/default.txt",
        runner="lmstudio",
    ),
}
