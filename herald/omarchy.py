"""Herald in Omarchy's AI usage panel.

Omarchy's agents panel draws whatever usage records appear in
``~/.local/state/omarchy/agents/usage/`` (one JSON file per agent, schemaVersion 1). Herald
already tracks the native subscription limits of every CLI account it routes through
(``/usage/cli``), so its record shows each account's windows in one Herald tab.

Without a ``title`` the panel reduces every bar to "Session" or "Weekly", so each limit is
titled with its account, model group (Antigravity reports one per group) and window, e.g.
"Antigravity 2 · Gemini · Weekly". The user can name accounts themselves in
``<Herald data>/omarchy.json`` ({"names": {"codex-backup": "Codex (school)"}}).
"""
from __future__ import annotations

import json
import os
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

RECORD_ID = "herald"
_GROUP = re.compile(r"^(.*?)\s*\((.*)\)\s*$")


def names_file() -> Path:
    from herald.router.storage_paths import data_dir
    return data_dir() / "omarchy.json"


def custom_names() -> dict[str, str]:
    try:
        names = json.loads(names_file().read_text(encoding="utf-8")).get("names") or {}
    except (OSError, ValueError):
        return {}
    return {str(k): str(v) for k, v in names.items() if str(v).strip()}


def set_name(account: str, label: str | None) -> dict[str, str]:
    """Name an account in the panel (label None or empty: back to the default name)."""
    path = names_file()
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        config = {}
    names = dict(config.get("names") or {})
    if label and label.strip():
        names[account] = label.strip()
    else:
        names.pop(account, None)
    config["names"] = names
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    return names


def _account_name(account: str, names: dict[str, str]) -> str:
    if account in names:
        return names[account]
    words = account.replace("_", "-").split("-")
    return " ".join([words[0].capitalize(), *words[1:]]).strip()


def _group_name(group: str) -> str:
    group = re.sub(r"\s+models?$", "", group.strip(), flags=re.I)
    return re.sub(r"\s+and\s+", " & ", group)


def _window_name(window: str) -> str:
    text = window.lower()
    if "month" in text or "30-day" in text:
        return "Monthly"
    if "week" in text or "7-day" in text:
        return "Weekly"
    if "five hour" in text or "5-hour" in text or "5h" in text or "session" in text:
        return "5h"
    return re.sub(r"\s*limit( remaining)?\s*$", "", window, flags=re.I).strip() or "Limit"


def title(cli: str, window: str, names: dict[str, str] | None = None) -> str:
    """"antigravity-2 (Gemini Models)" + "Weekly Limit Remaining" -> "Antigravity 2 · Gemini · Weekly"."""
    names = custom_names() if names is None else names
    match = _GROUP.match(cli)
    account, group = (match.group(1), match.group(2)) if match else (cli, "")
    parts = [names.get(cli) or _account_name(account, names)]
    if group and cli not in names:
        parts.append(_group_name(group))
    parts.append(_window_name(window))
    return " · ".join(parts)


def usage_dir() -> Path:
    state = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local" / "state")
    return Path(state) / "omarchy" / "agents" / "usage"


def _iso(value: Any) -> str | None:
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, UTC).isoformat()
    return str(value) if value else None


def record(cli_usage: dict[str, Any], *, now: datetime | None = None,
           names: dict[str, str] | None = None) -> dict[str, Any]:
    """An Omarchy usage record from Herald's /usage/cli answer."""
    now = now or datetime.now(UTC)
    names = custom_names() if names is None else names
    limits, accounts = [], []
    for account in cli_usage.get("clis", []):
        name = str(account.get("cli", "")).strip()
        if not name or account.get("status") != "ok":
            continue
        accounts.append(_GROUP.sub(r"\1", name))
        for window in account.get("limits", []):
            used = window.get("used_percent")
            if used is None:
                continue
            limits.append({"label": str(window.get("name", "limit")), "title": title(name, str(window.get("name", "")), names),
                           "percent": round(float(used) / 100, 4), "resetsAt": _iso(window.get("resets_at"))})
    days = [(now - timedelta(days=offset)).date().isoformat() for offset in range(6, -1, -1)]
    return {
        "schemaVersion": 1, "id": RECORD_ID, "name": "Herald", "updatedAt": now.isoformat(), "ready": bool(limits),
        "hasLocalStats": False, "todayPrompts": 0, "todaySessions": 0, "todayTotalTokens": 0,
        "todayTokensByModel": {}, "recentDays": [{"date": day, "messageCount": 0} for day in days],
        "totalPrompts": 0, "totalSessions": 0, "activeDays": 0, "activeDates": [], "modelUsage": {},
        "limits": limits, "tierLabel": f"{len(set(accounts))} accounts" if accounts else "",
        "usageStatusText": "" if limits else "No subscription limits reported by the router",
        "authHelpText": "",
    }


def write(value: dict[str, Any]) -> Path:
    folder = usage_dir()
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{RECORD_ID}.json"
    temporary = folder / f".{RECORD_ID}.tmp"
    temporary.write_text(json.dumps(value) + "\n", encoding="utf-8")
    temporary.replace(target)
    return target
