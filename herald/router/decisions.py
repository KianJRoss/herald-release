"""Decision models: quick typed answers for repeated, checkable choices, cheaper than an LLM call.

A decision request is a `state` (text or JSON) plus named questions, each one of:
- choice: pick one of `criteria` {option: description} -> {"choice", "probabilities", "confidence"};
- score:  rate on ordered levels, `criteria` [lowest, ..., highest] -> {"score", "legend", ...};
- noul:   probability that `instructions` is true (optional `criteria` {"true", "false"}) -> {"noul"}.
Answers carry probabilities and a confidence, so callers act when confident and fall back to an
LLM when not. The default backend is TypeSafe's Jev (System One API); its key stays a secret
reference resolved here, so callers (the assistant, scripts) never hold it.

Configure with HERALD_DECISION_URL (default the Jev endpoint), HERALD_DECISION_MODEL (default
jev-latest) and HERALD_DECISION_SECRET_REF (default vault:typesafe/primary).
"""
from __future__ import annotations

import os
from typing import Any

import httpx

from herald.router.account_registry import resolve_secret_ref
from herald.router.sanitization import sanitize_error

DEFAULT_URL = "https://api.typesafe.ai/v1/systemone"
QUESTION_TYPES = {"choice", "score", "noul"}
MAX_QUESTIONS = 32


class DecisionUnavailable(RuntimeError):
    """No decision backend is configured or it could not answer; fall back to an LLM."""


def validate(questions: dict[str, Any]) -> None:
    if not isinstance(questions, dict) or not questions or len(questions) > MAX_QUESTIONS:
        raise ValueError(f"questions must be an object with 1..{MAX_QUESTIONS} named questions")
    for name, question in questions.items():
        if not isinstance(question, dict) or question.get("type") not in QUESTION_TYPES:
            raise ValueError(f"question {name!r}: type must be one of {sorted(QUESTION_TYPES)}")
        kind, criteria = question["type"], question.get("criteria")
        if kind == "choice" and not (isinstance(criteria, dict) and 2 <= len(criteria) <= 255):
            raise ValueError(f"question {name!r}: choice needs criteria {{option: description}} with 2..255 options")
        if kind == "score" and not (isinstance(criteria, list) and len(criteria) >= 2):
            raise ValueError(f"question {name!r}: score needs criteria as an ordered list of 2+ levels")
        if kind == "noul" and criteria is not None and not isinstance(criteria, dict):
            raise ValueError(f"question {name!r}: noul criteria, when given, is {{\"true\": ..., \"false\": ...}}")


def decide(state: Any, questions: dict[str, Any], *, timeout: float = 20.0) -> dict[str, Any]:
    """Ask the configured decision model; returns its answers keyed by question name."""
    validate(questions)
    reference = os.environ.get("HERALD_DECISION_SECRET_REF", "vault:typesafe/primary")
    try:
        key = resolve_secret_ref(reference)
    except Exception as exc:  # noqa: BLE001 - not configured on this router
        raise DecisionUnavailable(f"decision model key unavailable ({reference})") from exc
    body = {"model": os.environ.get("HERALD_DECISION_MODEL", "jev-latest"), "state": state, "questions": questions}
    try:
        response = httpx.post(os.environ.get("HERALD_DECISION_URL", DEFAULT_URL), json=body, timeout=timeout,
                              headers={"Authorization": f"Bearer {key}"})
        response.raise_for_status()
        data = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise DecisionUnavailable("decision model request failed: " + sanitize_error(exc)) from None
    answers = data.get("answers")
    if not isinstance(answers, dict):
        raise DecisionUnavailable("decision model returned no answers")
    return {"answers": answers, "model": data.get("model", body["model"]), "usage": data.get("usage")}
