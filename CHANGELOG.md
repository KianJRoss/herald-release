# Herald Changelog & Release Notes

All notable changes, architectural updates, and breaking risk warnings for Herald are documented in this file.

---

## [0.4.0] - 2026-10-28

- **License:** Herald is now licensed under the GNU Affero General Public License v3.0 or later
  (AGPL-3.0-or-later). Releases up to and including 0.3.0 remain available under MIT.
- A capability preset (`fast`, `code`, `reason`) with no enabled backend tagged for it now falls back to
  every backend in priority order, so a Router whose only account is a single API key serves every preset
  and the tool harness instead of returning 404.

### Decision providers

- Aligned the TypeScript, managed-shell and MCP/native discovery version metadata with the Python package; release checking now verifies this agreement in tests. No published artifacts were replaced.
- Added persistent, named decision-provider instances with default/disabled inventory, request-time vault references, native TypeSafe, OpenAI Decisions, Perplexity, Cloudflare, Liquid and local System One adapters, SDK selection, typed-answer validation, decision accounting, and LLM/rules usage ingestion. Legacy `HERALD_DECISION_*` configuration remains available until a registry has been configured. Removing or disabling a selected provider does not silently select another.
- Added `herald decisions providers|configure|remove` and decision-route latency, tokens and known-cost coverage in `herald usage`. Ordinary chat responses now retain provider-reported usage, backend and resolved model metadata for SDK consumers.

### MCP bridge resource protection

- The stdio gateway avoids MCP v1's warning capture/replay loop, which can grow without bound when a logging handler emits warnings.
- Windows gateway processes have a default 512 MiB memory allowance, a process-local Job Object cap and a watchdog that exits only the bridge. Router/tool subprocesses are exempt from that bridge cap. Set `HERALD_MCP_MEMORY_LIMIT_MB` (or the module's `--memory-limit-mb`) to adjust it; `0` disables the safeguard for controlled diagnosis.
- This does not establish the cause of every historical memory-exhaustion incident. Existing client enable/disable choices are preserved.

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

### Omarchy agent entry points

- Optional user-level adapters route normal launches, prompted tasks, crash
  diagnosis and default-agent selection through `herald code` when Herald is
  selected. Other agents and commands retain Omarchy's implementation.
- Installation and rollback are documented in `integrations/omarchy/README.md`.

### Staging conflict diagnostics

- Pass both Git output streams to the conflict reviewer so stderr messages do not
  hide conflict details reported on stdout.

### Omarchy usage labels

- Usage bars identify their account, model group, and quota window.
- Set a local panel alias with `herald omarchy name ACCOUNT "Display name"`, then
  refresh with `herald omarchy usage --write`. Omit the display name to reset it.

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
  - Automated meta-orchestrator (`herald.router.admin_loop`) that coordinates research and dev loops.
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
