# Third-party notices

Herald depends on third-party open-source software. The dependency manifests
and lockfiles are the authoritative inventory for a particular release. The
items below deserve special notice because they provide the managed interactive
shell distributed with the Python package.

## Pi coding agent

- Packages: `@earendil-works/pi-coding-agent` 0.84.2 and
  `@earendil-works/pi-tui` 0.84.2
- Project: https://github.com/earendil-works/pi
- Author: Mario Zechner and contributors
- License: MIT

Herald's `herald code` experience runs on Pi and adds a Herald-specific theme,
Router integration, commands, tools, and agent behavior. Pi is a third-party
project and is not affiliated with or endorsed by Herald.

## Pi Plan Mode

- Package: `@narumitw/pi-plan-mode` 0.52.0
- Project: https://github.com/narumiruna/pi-extensions
- Author: narumiruna and contributors
- License: MIT

## pal-mcp-server (formerly zen-mcp-server)

- Project: https://github.com/BeehiveInnovations/pal-mcp-server
- Copyright 2025 Beehive Innovations
- License: Apache License 2.0, included as [LICENSES/Apache-2.0-pal-mcp-server.txt](LICENSES/Apache-2.0-pal-mcp-server.txt)

Herald's model-provider layer (`herald/providers/`), CLI bridge and its system prompts (`herald/clink/`), shared utilities (`herald/utils/`) and several model catalogs (`herald/conf/conf/`) are derived from pal-mcp-server. Herald's own providers there are DeepSeek, LM Studio, Mistral and G4F. Each derived Python file carries a header naming its upstream file and whether Herald modified it. Pal-mcp-server is a third-party project and is not affiliated with or endorsed by Herald.

Modified for Herald (39 files):

- `herald/clink/clink/agents/__init__.py`
- `herald/clink/clink/agents/base.py`
- `herald/clink/clink/agents/claude.py`
- `herald/clink/clink/agents/codex.py`
- `herald/clink/clink/agents/gemini.py`
- `herald/clink/clink/constants.py`
- `herald/clink/clink/models.py`
- `herald/clink/clink/parsers/__init__.py`
- `herald/clink/clink/registry.py`
- `herald/clink/systemprompts/clink/default.txt`
- `herald/clink/systemprompts/clink/default_codereviewer.txt`
- `herald/clink/systemprompts/clink/default_planner.txt`
- `herald/clink/systemprompts/codereview_prompt.py`
- `herald/clink/systemprompts/debug_prompt.py`
- `herald/clink/systemprompts/generate_code_prompt.py`
- `herald/clink/systemprompts/precommit_prompt.py`
- `herald/clink/systemprompts/refactor_prompt.py`
- `herald/clink/systemprompts/secaudit_prompt.py`
- `herald/clink/systemprompts/testgen_prompt.py`
- `herald/conf/conf/cli_clients/claude.json`
- `herald/conf/conf/cli_clients/codex.json`
- `herald/conf/conf/cli_clients/gemini.json`
- `herald/conf/conf/custom_models.json`
- `herald/providers/providers/__init__.py`
- `herald/providers/providers/azure_openai.py`
- `herald/providers/providers/base.py`
- `herald/providers/providers/custom.py`
- `herald/providers/providers/dial.py`
- `herald/providers/providers/gemini.py`
- `herald/providers/providers/openai_compatible.py`
- `herald/providers/providers/openrouter.py`
- `herald/providers/providers/registries/base.py`
- `herald/providers/providers/registry.py`
- `herald/providers/providers/shared/provider_type.py`
- `herald/utils/utils/file_utils.py`
- `herald/utils/utils/image_utils.py`
- `herald/utils/utils/model_context.py`
- `herald/utils/utils/model_restrictions.py`
- `herald/utils/utils/security_config.py`

Included unmodified (40 files):

- `herald/clink/clink/__init__.py`
- `herald/clink/clink/parsers/base.py`
- `herald/clink/clink/parsers/claude.py`
- `herald/clink/clink/parsers/codex.py`
- `herald/clink/clink/parsers/gemini.py`
- `herald/clink/systemprompts/__init__.py`
- `herald/clink/systemprompts/analyze_prompt.py`
- `herald/clink/systemprompts/chat_prompt.py`
- `herald/clink/systemprompts/clink/codex_codereviewer.txt`
- `herald/clink/systemprompts/consensus_prompt.py`
- `herald/clink/systemprompts/docgen_prompt.py`
- `herald/clink/systemprompts/planner_prompt.py`
- `herald/clink/systemprompts/thinkdeep_prompt.py`
- `herald/clink/systemprompts/tracer_prompt.py`
- `herald/conf/conf/__init__.py`
- `herald/conf/conf/azure_models.json`
- `herald/conf/conf/dial_models.json`
- `herald/conf/conf/gemini_models.json`
- `herald/conf/conf/openai_models.json`
- `herald/conf/conf/openrouter_models.json`
- `herald/conf/conf/xai_models.json`
- `herald/providers/providers/openai.py`
- `herald/providers/providers/registries/__init__.py`
- `herald/providers/providers/registries/azure.py`
- `herald/providers/providers/registries/custom.py`
- `herald/providers/providers/registries/dial.py`
- `herald/providers/providers/registries/gemini.py`
- `herald/providers/providers/registries/openai.py`
- `herald/providers/providers/registries/openrouter.py`
- `herald/providers/providers/registries/xai.py`
- `herald/providers/providers/registry_provider_mixin.py`
- `herald/providers/providers/shared/__init__.py`
- `herald/providers/providers/shared/model_capabilities.py`
- `herald/providers/providers/shared/model_response.py`
- `herald/providers/providers/shared/temperature.py`
- `herald/providers/providers/xai.py`
- `herald/utils/utils/__init__.py`
- `herald/utils/utils/env.py`
- `herald/utils/utils/file_types.py`
- `herald/utils/utils/token_utils.py`

The corresponding upstream license texts and transitive notices are installed
with their npm packages. The MIT license grants use, modification, and
redistribution subject to retaining its copyright and permission notice.

Herald itself is licensed separately under [LICENSE](LICENSE).
