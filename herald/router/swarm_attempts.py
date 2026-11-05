"""Durable receipts for opt-in swarm workers; uncertain attempts are never replayed."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from contextlib import closing
from datetime import datetime, timezone


class AttemptStore:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("CREATE TABLE IF NOT EXISTS swarm_attempts (id TEXT PRIMARY KEY, identity TEXT NOT NULL, state TEXT NOT NULL, worktree TEXT, result TEXT, updated_at TEXT NOT NULL)")

    def claim(self, attempt_id: str, identity: dict) -> dict | None:
        """Return existing receipt, or atomically claim a new attempt."""
        encoded = json.dumps(identity, sort_keys=True)
        with closing(sqlite3.connect(self.path)) as db, db:
            inserted = db.execute(
                "INSERT OR IGNORE INTO swarm_attempts VALUES (?, ?, 'running', NULL, NULL, ?)",
                (attempt_id, encoded, datetime.now(timezone.utc).isoformat()),
            ).rowcount
            if inserted:
                return None
            row = db.execute("SELECT identity,state,worktree,result FROM swarm_attempts WHERE id=?", (attempt_id,)).fetchone()
            if row[0] != encoded:
                raise ValueError("attempt ID already belongs to a different task or configuration")
            return {"state": row[1], "worktree": row[2], "result": json.loads(row[3]) if row[3] else None}

    def worktree(self, attempt_id: str, path: Path) -> None:
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("UPDATE swarm_attempts SET worktree=?, updated_at=? WHERE id=?", (str(path), datetime.now(timezone.utc).isoformat(), attempt_id))

    def finish(self, attempt_id: str, result: dict) -> None:
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("UPDATE swarm_attempts SET state=?,result=?,updated_at=? WHERE id=?",
                       ("completed" if result["success"] else "needs_reconciliation", json.dumps(result), datetime.now(timezone.utc).isoformat(), attempt_id))

    @staticmethod
    def inspect(path: str | Path, attempt_id: str) -> dict | None:
        """Inspect without creating a database, claiming work or modifying a receipt."""
        path = Path(path).resolve()
        if not path.exists():
            return None
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
            row = db.execute("SELECT state,worktree,result,updated_at,identity FROM swarm_attempts WHERE id=?", (attempt_id,)).fetchone()
            return ({"state": row[0], "worktree": row[1], "result": json.loads(row[2]) if row[2] else None, "updated_at": row[3], "identity": json.loads(row[4])} if row else None)

    def record_reconciliation(self, attempt_id: str, *, expected_updated_at: str, result: dict, reason: str) -> None:
        """Record a decision and outcome atomically, retaining the original receipt."""
        if not reason.strip():
            raise ValueError("Reconciliation requires a reason")
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("CREATE TABLE IF NOT EXISTS swarm_reconciliations (attempt_id TEXT, previous_receipt TEXT NOT NULL, reason TEXT NOT NULL, recorded_at TEXT NOT NULL)")
            row = db.execute("SELECT state,worktree,result,updated_at FROM swarm_attempts WHERE id=?", (attempt_id,)).fetchone()
            if row is None or row[3] != expected_updated_at or row[2] is not None:
                raise ValueError("Receipt changed or already has a final result; inspect again")
            now = datetime.now(timezone.utc).isoformat()
            db.execute("INSERT INTO swarm_reconciliations VALUES (?,?,?,?)", (attempt_id,json.dumps(row),reason,now))
            db.execute("UPDATE swarm_attempts SET state='reconciled',result=?,updated_at=? WHERE id=?", (json.dumps(result),now,attempt_id))
