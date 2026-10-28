# Herald CLI

Herald CLI is the operator and agent interface for the Herald Router. Use its
terminal commands for quick, scriptable work or launch the full-screen,
Pi-based interface for longer coding and everyday tasks.

## Start with the shortest command

```powershell
herald ask "Explain the failing test"
herald ask --mode local "Summarize these notes"
herald code --print --prompt "Review this repository"
```

`herald ask` sends one task through the Router. `herald code --print` gives the
task the coding-agent environment and exits when it is done, which makes it
useful in scripts and CI jobs.

## Work interactively

Run either command from a workspace:

```powershell
herald
herald code
```

Herald installs its pinned Pi runtime in an isolated user directory and adds
Herald's model selector, account pools, project-scoped MCP tools, commands,
sessions, and multi-model delegation. Use `/help` inside the interface to see
the complete command surface.

Common commands include:

| Command | Purpose |
| --- | --- |
| `/model` | Choose a routing mode (`/model quality`), a group (`/model group codex-cli`), or pin one exact backend (`/model pin codex-primary`) -- see below. |
| `/accounts` and `/login` | Select accounts and maintain provider sessions. |
| `/tools` | Inspect or call tools available in the current project scope. |
| `/usage` | Review API, subscription, browser-session, and local-model usage. |
| `/flow` | Start or resume a persistent multi-agent flow. |
| `/status` | Check Router, authentication, provider, and project health. |

Provider-native approval prompts and sandboxes stay in force. Herald does not
silently add permission- or sandbox-bypass flags to Claude Code, Codex, or
other managed coding CLIs.

## Choose how models are selected

`/model` covers three genuinely different things, and how much fallback
happens depends on which one you pick:

- **Mode** (`/model efficiency`, `/model quality`, ...) -- a routing
  behavior, not a specific model. Fails over across every backend type that
  mode allows.
  - `efficiency` favors healthy free, browser-session, and local backends.
  - `balanced` considers every configured backend.
  - `quality` prefers subscription CLIs and paid APIs.
  - `local` keeps automatic selection on local models.
- **Group** (`/model group codex-cli`, or a capability preset like
  `/model group code`) -- a named set of interchangeable backends (e.g.
  several API keys for the same underlying model, or "code"/"reason"/"fast").
  A request fails over among that group's own members if one fails, but
  never crosses into an unrelated group or backend.
- **Pin** (`/model pin codex-primary`) -- one exact backend. The Router
  refuses to substitute anything else: if that backend is unavailable, the
  request fails instead of silently routing elsewhere. Use this when you
  specifically need to know which backend actually answered.

`/model` alone (no argument) opens the mode picker. `/model info` explains
each mode's automatic order.

## Connect tools once

Herald exposes one controlled MCP library to its own agents and to external
CLIs. Groups let each project or CLI profile see only the tools it needs:

```powershell
herald mcp native add filesystem --root . --group coding
herald mcp native add shell --root . --group coding
herald mcp group bind coding cli codex-primary
herald mcp connect codex --profile codex-primary
```

Use `herald mcp access --profile codex-primary` to inspect the exact catalog
before connecting it.

## Automate larger jobs

```powershell
herald init . --name my-app
herald flow validate .herald/flows/feature.yaml
herald flow run .herald/flows/feature.yaml "Implement the next feature" --persist
herald flow runs
```

Persistent flows checkpoint agent memories and stages so interrupted work can
resume without starting over. For direct application integration, continue
with [Herald Package](PACKAGE.md).
