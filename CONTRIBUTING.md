# Contributing to Herald

Thanks for helping improve Herald. Contributions should preserve the shared
Router, CLI, and Package story rather than treating them as unrelated tools.
All changes must follow [AGENTS.md](AGENTS.md) and the
[development guidelines](docs/DEVELOPMENT_GUIDELINES.md).

## Start here

1. Open an issue for a substantial feature or behavior change so its public
   API and product fit can be agreed first.
2. Create a focused branch from `main`.
3. Install the development environment with `python -m pip install -e ".[dev]"`.
4. Make the smallest coherent change and add tests for observable behavior.
5. Run `python tools/check_release.py` and `python -m pytest -q`.
6. If the TypeScript SDK changed, run `npm ci`, `npm run build`, and
   `npm pack --dry-run` from `sdk/typescript`.

Before submitting, remove credentials, machine-specific paths, generated
databases, logs, browser captures, and private prompts. Do not add a dependency
without documenting its purpose and license. User-facing changes belong under
`Unreleased` in `CHANGELOG.md`.

Pull requests should explain the outcome, test evidence, compatibility impact,
and any security or privacy tradeoff. By contributing, you agree that your
work is licensed under the repository's MIT License.

You may fork or modify Herald, but a modified runtime is your custom build
until the change is accepted upstream. Maintainers support published Herald
releases and accepted upstream code; they are not responsible for debugging
unreviewed downstream modifications. Reproduce reported bugs on an unmodified
release, or submit the relevant change as a focused pull request for review.

Building applications, integrations, and tool packages through Herald's
documented Router, CLI, Package, SDK, and MCP interfaces does not make Herald a
custom build.

Report security issues through [SECURITY.md](SECURITY.md), not a public issue.
Release eligibility is governed by the
[publishing policy](docs/PUBLISHING_POLICY.md); passing ordinary pull-request
checks does not authorize publication.
