## Unreleased ? MCP bridge resource protection

- The stdio gateway avoids MCP v1's warning capture/replay loop, which can grow without bound when a logging handler emits warnings.
- Windows gateway processes have a default 512 MiB memory allowance, a process-local Job Object cap and a watchdog that exits only the bridge. Router/tool subprocesses are exempt from that bridge cap. Set `HERALD_MCP_MEMORY_LIMIT_MB` (or the module's `--memory-limit-mb`) to adjust it; `0` disables the safeguard for controlled diagnosis.
- This does not establish the cause of every historical memory-exhaustion incident. Existing client enable/disable choices are preserved.

﻿# Herald Changelog & Release Notes

All notable changes, architectural updates, and breaking risk warnings for Herald are documented in this file.

---

## [0.3.0] - 2026-10-20

First public release, as three products that share the `herald` import name:

- **herald-router**: Herald itself, the Router: models, coding CLIs and MCP tools behind one
  API, the device mesh, and the `herald` command.
- **herald-sdk**: the programming package (`import herald`) for building on a Router.
- **herald-pi**: the interactive coding interface (`herald-pi`).

Also new: `/v1/decide`, typed answers (choice / score / yes-no with confidence) from a decision
model, with `RouterClient.decide`. Install with `install.ps1` / `install.sh`; they download these
wheels and check each against `release-manifest.json`. Nothing installs by name from PyPI.

## [Unreleased]

### Native CLI execution

- Run unattended native Codex, Claude Code, and Antigravity sessions with
  their supported permission flags while retaining their native tools.
- Use the configured Router workspace when a CLI profile has no working directory.
- Assemble Antigravity response deltas and reject empty replies and tool errors.
- Include explicitly unverified partial output when a pinned execution fails.
- Retain native stderr diagnostics alongside terminal error status.

### Documentation and packaging

- Reframed Herald around its three public parts: Router, CLI, and Package.
- Added focused CLI and Package guides with outcome-oriented examples.
- Added Python and TypeScript registry metadata for search and package
  discovery.
- Added a repeatable publishing checklist that verifies clean artifacts before
  any registry or GitHub release.
- Added a first-publication roadmap covering history sanitization, security
  gates, registry ownership, trusted publishing, release automation, and fleet
  rollout.
- Added public security, support, contribution, conduct, and third-party notice
  policies.
- Added release-version validation and guarded OIDC publishing automation.
- Limited voice uploads and added Router browser-security headers.

---

## [0.2.0] - Unreleased (Planned Public Beta)

### ⚠️ Potential Breaking Changes & Migration Warnings
- **Strict Tiered Policy Routing**:
  - `quality` mode now strictly prioritizes CLI subscription backends (`codex`, `claude`, `antigravity`) over all API keys and local models. If your setup relied on local GPU models handling quality requests, use `/model local` or `/model paired-local` instead.
- **Dynamic Fleet Configuration**:
  - Replaced hardcoded static fleet hosts with `~/.herald/fleet.yaml` and dynamic OpenSSH config discovery (`~/.ssh/config`). If you use custom remote machine aliases, copy `fleet.yaml.example` to `~/.herald/fleet.yaml`.
- **Governed Tool Access**:
  - The tool catalog is strictly scoped by active project and MCP group. Unassigned tools will no longer bleed across independent projects.

---

### 🚀 What's New & Highlights
- **Interactive Onboarding Wizard (`herald setup`)**:
  - Step-by-step role configuration: Standalone Local, Client Workstation, or Headless Server Hub.
  - Automatic detection and zero-config connection for local Ollama and LM Studio endpoints.
- **Proactive Self-Improvement Admin Coordinator**:
  - Usage-budget reservation engine with 6-hour burn rate forecasting and a hard 30% reserve floor to protect trading agents and personal use.
- **Safe & Opt-In Update Pipeline**:
  - Added `herald update` and in-session `/update` slash command.
  - Updates are strictly **opt-in only** by default (`HERALD_AUTO_UPDATE=0`) to protect production workflows.
  - Interactive changelog and breaking change previews before applying updates.
- **Cross-Platform One-Line Installers**:
  - Linux/macOS installer script (`install.sh`).
  - Windows PowerShell installer script (`install.ps1`).

---

## [0.1.0] - 2026-08-20 (Initial Harness & Routing Foundation)

### 🚀 Features
- Unified multi-model routing across OpenAI, Anthropic, Gemini, DeepSeek, and local LLMs.
- Embedded Pi coding agent terminal (`herald code`).
- Encrypted stateful memory vault (`Harness` / `Flow`).
