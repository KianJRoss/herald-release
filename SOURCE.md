# Source for Herald 0.4.4

This repository is the curated source for the Router, Python SDK and Pi release
packages. It excludes the maintainer's internal Admin application and operational
configuration.

The product source is development commit
`79a8c48212655fe1940cfa0aa091e57185748622`. The matching source packages and
wheels are attached to [Herald 0.4.4](https://github.com/KianJRoss/herald-release/releases/tag/v0.4.4).
`release-manifest.json` in that release records the exact file sizes and SHA-256
checksums. Rebuild an individual source package by extracting its `.tar.gz`,
installing Python's `build` package, and running `python -m build` in the extracted
directory. Python 3.10 or newer is required.

The root checkout combines those components for inspection and development;
`pip install -e .` installs that combined source layout. Use the separate release
wheels for the supported component installations. The TypeScript development
package is not part of this release's public downloads.

The product files are unchanged in development CI revision
`570bb1cf8b9faec28ff2fdd4ade58b010038d353`, which adds test/CI verification without
changing these product files. CI covers Linux Python 3.10–3.13, Windows and macOS,
and split-package and Node dependency checks. Third-party attribution and license
texts are in `THIRD_PARTY_NOTICES.md`, `LICENSES/` and the release packages.
