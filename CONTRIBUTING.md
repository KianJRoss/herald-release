# Contributing to Herald

Thanks for helping improve Herald. Bug reports, feature requests and pull requests are welcome.

## Issues

- **Bugs:** open an issue with the Herald version (for example 0.4.0), your operating system, Python and Node
  versions, the command or API route involved, what you expected, what happened, and the smallest steps that
  reproduce it.
- **Features:** describe the problem you want solved before the solution, so the public API and product fit can
  be agreed first. Please open an issue before starting a substantial change.
- **Security problems:** never in a public issue. Follow [SECURITY.md](SECURITY.md).

Redact API keys, bearer tokens, account identifiers, private prompts, local paths and provider session data from
anything you post.

## Pull requests

This repository holds the source of each published release. Development happens in a separate repository, so
an accepted pull request is merged there and arrives here with the next release, credited to you in the
changelog.

1. Keep the change focused, with tests for observable behaviour.
2. Install from source with `python -m pip install -e .`, check your change against a running Router, and say
   in the pull request what you ran.
3. Describe the outcome, compatibility impact, and any security or privacy trade-off.
4. Don't add a dependency without explaining its purpose and license.

Remove credentials, machine-specific paths, generated databases, logs, browser captures and private prompts
before submitting.

## License

Herald is licensed under the GNU Affero General Public License v3.0 or later. By contributing, you agree that
your contribution is licensed under the same terms ([LICENSE](LICENSE)).

You may fork or modify Herald. A modified runtime is your own build until the change is accepted upstream;
maintainers support published releases. Building applications and integrations on Herald's documented Router,
CLI, Package, SDK and MCP interfaces is ordinary supported use.

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
