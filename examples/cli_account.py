"""Call a configured Herald CLI account.

Run: python examples/cli_account.py codex-primary "Reply with hello"
"""
from __future__ import annotations

import argparse
import herald


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("account")
    parser.add_argument("prompt")
    parser.add_argument("--timeout", type=float, default=None)
    parser.add_argument("--agentic", action="store_true")
    parser.add_argument("--mode", default="efficiency")
    args = parser.parse_args()
    account = herald.cli_account(args.account)
    print(account(
        args.prompt, timeout=args.timeout, agentic=args.agentic, mode=args.mode,
    ))


if __name__ == "__main__":
    main()
