"""Persistent decision-provider routing, validation, and privacy-safe accounting."""
from __future__ import annotations

import json
import os
import sqlite3
import time
from contextlib import closing
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx

from herald.router.account_registry import resolve_secret_ref
from herald.router.sanitization import sanitize_error
from herald.router.storage_paths import database_path
from herald.router import decision_protocols

DEFAULT_URL = "https://api.typesafe.ai/v1/systemone"
DEFAULT_DB_PATH = database_path("decisions.db", env_var="HERALD_DECISIONS_DB")
QUESTION_TYPES = {"choice", "score", "noul"}
PROVIDER_TYPES = {"typesafe", "systemone", "ollama", "llama_cpp", "openai", "perplexity", "cloudflare", "liquid", "openai_compatible"}
MAX_QUESTIONS = 32


class DecisionUnavailable(RuntimeError):
    """The selected backend could not produce safe typed answers; use LLM fallback."""


@dataclass(frozen=True)
class DecisionProvider:
    name: str
    provider_type: str
    url: str
    model: str
    secret_ref: str | None
    enabled: bool
    is_default: bool
    config: dict[str, Any]


def _finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value == value and abs(value) != float("inf")


def validate(questions: dict[str, Any]) -> None:
    if not isinstance(questions, dict) or not questions or len(questions) > MAX_QUESTIONS:
        raise ValueError(f"questions must be an object with 1..{MAX_QUESTIONS} named questions")
    for name, question in questions.items():
        if not isinstance(name, str) or not name.strip() or len(name) > 128:
            raise ValueError("question names must be non-empty strings up to 128 characters")
        if not isinstance(question, dict) or question.get("type") not in QUESTION_TYPES:
            raise ValueError(f"question {name!r}: type must be one of {sorted(QUESTION_TYPES)}")
        kind, criteria = question["type"], question.get("criteria")
        if kind == "choice" and not (isinstance(criteria, dict) and 2 <= len(criteria) <= 255 and all(isinstance(k, str) and k for k in criteria)):
            raise ValueError(f"question {name!r}: choice needs criteria {{option: description}} with 2..255 options")
        if kind == "score" and not (isinstance(criteria, list) and 2 <= len(criteria) <= 255 and all(isinstance(v, (str, int, float)) for v in criteria)):
            raise ValueError(f"question {name!r}: score needs criteria as an ordered list of 2..255 levels")
        if kind == "noul" and criteria is not None and not (isinstance(criteria, dict) and set(criteria) <= {"true", "false"}):
            raise ValueError(f"question {name!r}: noul criteria, when given, contains only true/false descriptions")


def validate_answers(questions: dict[str, Any], answers: Any) -> dict[str, Any]:
    if not isinstance(answers, dict) or set(answers) != set(questions):
        raise DecisionUnavailable("decision model returned missing or unexpected answers")
    for name, question in questions.items():
        answer = answers[name]
        if not isinstance(answer, dict):
            raise DecisionUnavailable("decision model returned a malformed answer")
        kind = question["type"]
        if answer.get("type", kind) != kind:
            raise DecisionUnavailable("decision answer type does not match its question")
        confidence = answer.get("confidence")
        if (kind != "noul" or confidence is not None) and (not _finite_number(confidence) or not 0 <= confidence <= 1):
            raise DecisionUnavailable("decision model returned invalid confidence")
        probabilities = answer.get("probabilities")
        if probabilities is not None:
            if not isinstance(probabilities, dict) or not probabilities or any(not _finite_number(v) or not 0 <= v <= 1 for v in probabilities.values()):
                raise DecisionUnavailable("decision model returned invalid probabilities")
            if abs(sum(probabilities.values()) - 1.0) > 0.02:
                raise DecisionUnavailable("decision model probabilities do not sum to one")
        if kind == "choice":
            choice = answer.get("choice", answer.get("value"))
            if not isinstance(choice, str) or choice not in question["criteria"]:
                raise DecisionUnavailable("decision model returned a choice outside the criteria")
            if probabilities is not None and set(probabilities) != set(question["criteria"]):
                raise DecisionUnavailable("decision probabilities do not match the choices")
            if probabilities is not None and probabilities[choice] + 0.000001 < max(probabilities.values()):
                raise DecisionUnavailable("decision choice contradicts its probabilities")
            answer["choice"] = choice
        elif kind == "score":
            score = answer.get("score", answer.get("value"))
            criteria = question["criteria"]
            if not _finite_number(score) or not 0 <= score <= len(criteria) - 1:
                raise DecisionUnavailable("decision model returned a score outside the criteria")
            if probabilities is not None and set(probabilities) != {str(i) for i in range(len(criteria))}:
                raise DecisionUnavailable("decision probabilities do not match the score levels")
            if probabilities is not None and abs(score - sum(i * probabilities[str(i)] for i in range(len(criteria)))) > 0.02:
                raise DecisionUnavailable("decision score contradicts its probabilities")
            answer["score"] = score
        else:
            value = answer.get("noul", answer.get("value"))
            if not _finite_number(value) or not 0 <= value <= 1:
                raise DecisionUnavailable("decision model returned an invalid noul probability")
            answer["noul"] = value
    return answers


class DecisionRegistry:
    def __init__(self, db_path: str | Path = DEFAULT_DB_PATH):
        self.db_path = str(db_path)
        self._init()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init(self) -> None:
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as conn, conn:
            conn.execute("""CREATE TABLE IF NOT EXISTS decision_providers (
                name TEXT PRIMARY KEY, provider_type TEXT NOT NULL, url TEXT NOT NULL,
                model TEXT NOT NULL, secret_ref TEXT, enabled INTEGER NOT NULL DEFAULT 1,
                is_default INTEGER NOT NULL DEFAULT 0, config_json TEXT NOT NULL DEFAULT '{}')""")
            conn.execute("""CREATE TABLE IF NOT EXISTS decision_usage (
                id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                decision_name TEXT NOT NULL, route TEXT NOT NULL, provider TEXT, model TEXT,
                latency_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL,
                status TEXT NOT NULL, fallback_reason TEXT)""")
            conn.execute("CREATE TABLE IF NOT EXISTS decision_registry_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")

    def configured(self) -> bool:
        with closing(self._connect()) as conn:
            return bool(conn.execute("SELECT 1 FROM decision_providers LIMIT 1").fetchone() or
                        conn.execute("SELECT 1 FROM decision_registry_meta WHERE key='configured'").fetchone())

    def list(self) -> list[dict[str, Any]]:
        with closing(self._connect()) as conn:
            rows = conn.execute("SELECT * FROM decision_providers ORDER BY is_default DESC, name").fetchall()
        return [asdict(self._row(r)) for r in rows]

    @staticmethod
    def _row(row: sqlite3.Row) -> DecisionProvider:
        return DecisionProvider(row["name"], row["provider_type"], row["url"], row["model"], row["secret_ref"], bool(row["enabled"]), bool(row["is_default"]), json.loads(row["config_json"]))

    def get(self, name: str | None = None) -> DecisionProvider | None:
        with closing(self._connect()) as conn:
            if name:
                row = conn.execute("SELECT * FROM decision_providers WHERE name = ?", (name,)).fetchone()
            else:
                default = conn.execute("SELECT value FROM decision_registry_meta WHERE key='default_provider'").fetchone()
                if default is not None:
                    row = conn.execute("SELECT * FROM decision_providers WHERE name = ?", (default["value"],)).fetchone()
                else:
                    row = conn.execute("SELECT * FROM decision_providers WHERE enabled = 1 OR is_default = 1 ORDER BY is_default DESC, name LIMIT 1").fetchone()
        return self._row(row) if row else None

    def put(self, provider: DecisionProvider) -> dict[str, Any]:
        if not provider.name.strip() or len(provider.name) > 128 or provider.provider_type not in PROVIDER_TYPES:
            raise ValueError("invalid decision provider name or type")
        url = urlsplit(provider.url)
        if url.scheme not in {"http", "https"} or not url.hostname:
            raise ValueError("decision provider url must use http or https")
        if url.username is not None or url.password is not None or url.query or url.fragment:
            raise ValueError("provider URL cannot contain credentials, query parameters or a fragment")
        if not provider.model.strip() or len(provider.model) > 500:
            raise ValueError("provider model must be a non-empty name up to 500 characters")
        if not isinstance(provider.config, dict) or set(provider.config) - {"request_options", "pricing"}:
            raise ValueError("provider config supports only request_options and pricing")
        options = provider.config.get("request_options", {})
        forbidden = {"api_key", "access_token", "password", "secret", "token", "authorization"}
        if isinstance(options, dict) and any(str(key).lower() in forbidden for key in options):
            raise ValueError("inline credentials are forbidden; use secret_ref")
        if not isinstance(options, dict) or set(options) - {"temperature", "top_p", "max_tokens", "max_completion_tokens", "response_format", "seed"}:
            raise ValueError("unsupported request option")
        pricing = provider.config.get("pricing", {})
        if not isinstance(pricing, dict) or set(pricing) - {"input_per_million", "output_per_million", "per_request"}:
            raise ValueError("unsupported pricing field")
        if any(not _finite_number(v) or v < 0 for v in pricing.values()):
            raise ValueError("prices must be finite non-negative numbers")
        if ("input_per_million" in pricing) != ("output_per_million" in pricing):
            raise ValueError("token pricing needs both input and output rates")
        if provider.secret_ref:
            from herald.secret_refs import validate_secret_ref
            validate_secret_ref(provider.secret_ref)
        with closing(self._connect()) as conn, conn:
            conn.execute("INSERT OR REPLACE INTO decision_registry_meta VALUES ('configured', '1')")
            if provider.is_default:
                conn.execute("UPDATE decision_providers SET is_default = 0")
                conn.execute("INSERT OR REPLACE INTO decision_registry_meta VALUES ('default_provider', ?)", (provider.name,))
            else:
                conn.execute("UPDATE decision_registry_meta SET value='' WHERE key='default_provider' AND value=?", (provider.name,))
            conn.execute("""INSERT INTO decision_providers VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET provider_type=excluded.provider_type, url=excluded.url,
                model=excluded.model, secret_ref=excluded.secret_ref, enabled=excluded.enabled,
                is_default=excluded.is_default, config_json=excluded.config_json""",
                (provider.name, provider.provider_type, provider.url.rstrip("/"), provider.model, provider.secret_ref, int(provider.enabled), int(provider.is_default), json.dumps(provider.config)))
        return asdict(provider)

    def delete(self, name: str) -> bool:
        with closing(self._connect()) as conn, conn:
            return conn.execute("DELETE FROM decision_providers WHERE name = ?", (name,)).rowcount > 0

    def record(self, record: dict[str, Any]) -> None:
        validate_usage(record)
        with closing(self._connect()) as conn, conn:
            conn.execute("""INSERT INTO decision_usage
                (decision_name, route, provider, model, latency_ms, input_tokens, output_tokens, cost_usd, status, fallback_reason)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", tuple(record.get(k) for k in
                ("decision_name", "route", "provider", "model", "latency_ms", "input_tokens", "output_tokens", "cost_usd", "status", "fallback_reason")))

    def usage_summary(self) -> dict[str, Any]:
        with closing(self._connect()) as conn:
            rows = conn.execute("""SELECT route, provider, model, COUNT(*) attempts,
                SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) successes,
                SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens,
                SUM(cost_usd) cost_usd, COUNT(cost_usd) cost_known,
                COUNT(input_tokens) input_tokens_known, AVG(latency_ms) avg_latency_ms
                FROM decision_usage GROUP BY route, provider, model ORDER BY attempts DESC""").fetchall()
        return {"by_route": [dict(r) for r in rows]}


def validate_usage(record: dict[str, Any]) -> None:
    allowed = {"decision_name", "route", "provider", "model", "latency_ms", "input_tokens", "output_tokens", "cost_usd", "status", "fallback_reason"}
    if not isinstance(record, dict) or set(record) - allowed:
        raise ValueError("usage record contains unsupported fields")
    if not isinstance(record.get("decision_name"), str) or not record["decision_name"].strip() or len(record["decision_name"]) > 128:
        raise ValueError("decision_name must be a non-empty string up to 128 characters")
    if record.get("route") not in {"decision_model", "llm", "rules"} or record.get("status") not in {"success", "failure", "fallback"}:
        raise ValueError("invalid decision route or status")
    for key in ("latency_ms", "input_tokens", "output_tokens"):
        if record.get(key) is not None and (not isinstance(record[key], int) or isinstance(record[key], bool) or record[key] < 0):
            raise ValueError(f"{key} must be a non-negative integer or null")
    if record.get("cost_usd") is not None and (not _finite_number(record["cost_usd"]) or record["cost_usd"] < 0):
        raise ValueError("cost_usd must be a non-negative number or null")
    for key in ("provider", "model", "fallback_reason"):
        if record.get(key) is not None and (not isinstance(record[key], str) or len(record[key]) > 500):
            raise ValueError(f"{key} must be a bounded string or null")


def _request(provider: DecisionProvider, state: Any, questions: dict[str, Any], timeout: float) -> tuple[dict[str, Any], dict[str, Any]]:
    headers = {"Content-Type": "application/json"}
    if provider.secret_ref:
        try:
            headers["Authorization"] = "Bearer " + resolve_secret_ref(provider.secret_ref)
        except Exception as exc:
            raise DecisionUnavailable("decision provider credential is unavailable") from exc
    body = decision_protocols.request_body(provider.provider_type, provider.model, state, questions, provider.config)
    url = decision_protocols.endpoint(provider.provider_type, provider.url)
    response = httpx.post(url, json=body, headers=headers, timeout=timeout)
    response.raise_for_status()
    data = decision_protocols.response_body(provider.provider_type, response.json(), questions)
    return data, body


registry = DecisionRegistry()


def decide(state: Any, questions: dict[str, Any], *, provider: str | None = None, model: str | None = None,
           decision_name: str | None = None, timeout: float = 20.0) -> dict[str, Any]:
    validate(questions)
    if decision_name is not None and (not isinstance(decision_name, str) or not decision_name.strip() or len(decision_name) > 128):
        raise ValueError("decision_name must contain 1..128 characters")
    selected = registry.get(provider)
    if not registry.configured() and provider is None:
        url = os.environ.get("HERALD_DECISION_URL", DEFAULT_URL)
        config = {"pricing": {"input_per_million": 0.042, "output_per_million": 0}} if url == DEFAULT_URL else {}
        selected = DecisionProvider("legacy", "typesafe", url, model or os.environ.get("HERALD_DECISION_MODEL", "jev-latest"), os.environ.get("HERALD_DECISION_SECRET_REF", "vault:typesafe/primary"), True, True, config)
    started = time.monotonic()
    record = {"decision_name": decision_name or ",".join(questions)[:128], "route": "decision_model", "provider": selected.name if selected else provider,
              "model": model or (selected.model if selected else None), "latency_ms": None, "input_tokens": None, "output_tokens": None, "cost_usd": None, "status": "failure", "fallback_reason": None}
    try:
        if selected is None:
            raise DecisionUnavailable("requested decision provider is unavailable")
        if not selected.enabled:
            raise DecisionUnavailable("requested decision provider is disabled")
        if model:
            selected = DecisionProvider(**{**asdict(selected), "model": model})
        data, _body = _request(selected, state, questions, timeout)
        usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
        input_tokens = usage.get("input_tokens") if usage.get("input_tokens") is not None else usage.get("prompt_tokens")
        output_tokens = usage.get("output_tokens") if usage.get("output_tokens") is not None else usage.get("completion_tokens")
        reported = {"decision_name": "provider response", "route": "decision_model", "status": "success", "input_tokens": input_tokens, "output_tokens": output_tokens, "cost_usd": usage.get("cost_usd")}
        try:
            validate_usage(reported)
        except ValueError:
            raise DecisionUnavailable("decision provider returned invalid usage metadata") from None
        cost = usage.get("cost_usd")
        if cost is None:
            pricing = selected.config.get("pricing", {})
            if pricing:
                parts = [pricing.get("per_request", 0)]
                for field, count in (("input_per_million", input_tokens), ("output_per_million", output_tokens)):
                    if field not in pricing and "per_request" in pricing:
                        continue
                    price = pricing.get(field)
                    if price is None or (count is None and price != 0):
                        parts = []
                        break
                    parts.append((count or 0) * price / 1_000_000)
                cost = sum(parts) if parts else None
        record.update(model=str(data.get("model") or selected.model)[:500], input_tokens=input_tokens, output_tokens=output_tokens, cost_usd=cost)
        answers = validate_answers(questions, data.get("answers"))
        record["status"] = "success"
        return {"answers": answers, "provider": selected.name, "model": record["model"], "latency_ms": int((time.monotonic() - started) * 1000), "usage": {"input_tokens": record["input_tokens"], "output_tokens": record["output_tokens"], "cost_usd": record["cost_usd"]}}
    except DecisionUnavailable as exc:
        record["fallback_reason"] = sanitize_error(exc)
        raise
    except (httpx.HTTPError, ValueError, KeyError, TypeError, IndexError, AttributeError) as exc:
        record["fallback_reason"] = "request_failed:" + type(exc).__name__
        raise DecisionUnavailable("decision provider request failed") from None
    finally:
        record["latency_ms"] = int((time.monotonic() - started) * 1000)
        registry.record(record)
