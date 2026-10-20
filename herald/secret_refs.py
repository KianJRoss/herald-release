"""Secret references (`env:NAME`, `keyring:NAME`, `vault:PATH`): never the secret itself.

Shared by the Router and the programming package, which validates a reference before
sending it to the Router.
"""
from __future__ import annotations

SECRET_REF_SCHEMES = {"env", "keyring", "vault"}


def validate_secret_ref(secret_ref: str | None) -> None:
    if not secret_ref:
        return
    scheme, separator, target = secret_ref.partition(":")
    if not separator or scheme not in SECRET_REF_SCHEMES or not target.strip():
        supported = ", ".join(f"{name}:..." for name in sorted(SECRET_REF_SCHEMES))
        raise ValueError(f"secret_ref must use one of: {supported}")
