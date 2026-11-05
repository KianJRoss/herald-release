"""Herald Swarm & Fast-Track Multi-Agent Engine.

Decomposes a project or checklist into N granular micro-tasks, dispatches
independent worker agents in parallel against separate candidate branches/diffs,
buffers all outputs in the Staging Zone, and performs automated N-way 3-way
merge and pytest verification into a single atomic commit.
"""
from __future__ import annotations

import concurrent.futures
import logging
import json
import hashlib
import os
import re
import subprocess
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from herald.router.staging_zone import DEFAULT_DB_PATH, StagingStore

logger = logging.getLogger("herald.fast_track")


def _backend_parallelism(backend_model: str) -> int:
    """Return a conservative CLI-specific concurrency ceiling."""
    env_key = "HERALD_SWARM_PARALLEL_" + re.sub(r"[^A-Z0-9]", "_", backend_model.upper())
    if env_key in os.environ:
        try:
            return max(1, int(os.environ[env_key]))
        except ValueError:
            pass
    if backend_model.startswith("antigravity") or backend_model == "claude-cli":
        return 1
    return 4


def _find_repo_root(start: Path | None = None) -> Path:
    """Walk upward from `start` (default: the caller's current directory) to find
    the nearest enclosing Git repository or Python project.

    Deliberately starts from the caller's cwd, not this file's install location --
    a swarm task must operate on whatever project the user is actually in, never
    silently fall back to wherever Herald itself happens to be installed.
    """
    current = (start or Path.cwd()).resolve()
    while current.parent != current:
        if (current / "pyproject.toml").exists() or (current / ".git").exists():
            return current
        current = current.parent
    return Path.home() / ".herald"


REPO_ROOT = _find_repo_root()


@dataclass
class SwarmTask:
    id: str
    title: str
    description: str
    target_files: list[str]
    status: str = "pending"


@dataclass
class SwarmResult:
    task_id: str
    agent_name: str
    success: bool
    diff: str | None = None
    files_touched: list[str] | None = None
    error: str | None = None
    output: str | None = None
    patch_id: str | None = None
    native_session_id: str | None = None
    attempts: int = 1
    attempt_id: str | None = None
    worktree: str | None = None


def parse_tasks_from_markdown(markdown_path: Path) -> list[SwarmTask]:
    """Parse unchecked checklist tasks from a markdown file into discrete SwarmTasks."""
    if not markdown_path.exists():
        return []
    text = markdown_path.read_text(encoding="utf-8")
    lines = text.splitlines()
    tasks: list[SwarmTask] = []
    
    current_task: SwarmTask | None = None
    
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("- [ ]"):
            content = stripped[5:].strip()
            task_id = f"task-{uuid.uuid4().hex[:6]}"
            
            # Extract bold title if present
            bold_match = re.match(r"^\*\*([^\*]+)\*\*\s*(.*)", content)
            if bold_match:
                task_tag = bold_match.group(1).strip()
                task_desc = bold_match.group(2).strip()
            else:
                task_tag = content[:40].strip()
                task_desc = content
            
            found_files = re.findall(r"([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+)", f"{task_tag} {task_desc}")
            cleaned_files = [f for f in found_files if not f.startswith("http") and not f.startswith(".")]
            
            current_task = SwarmTask(
                id=task_id,
                title=task_tag,
                description=task_desc,
                target_files=cleaned_files or ["herald/"],
            )
            tasks.append(current_task)
        elif current_task and (stripped.startswith("- ") or stripped.startswith("* ") or stripped.startswith("  ")):
            current_task.description += f"\n{stripped}"
            sub_files = re.findall(r"([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+)", stripped)
            for sf in sub_files:
                if sf not in current_task.target_files and not sf.startswith("http"):
                    current_task.target_files.append(sf)
                    
    return tasks


def execute_swarm_task_worker(
    task: SwarmTask,
    *,
    worker_index: int,
    backend_model: str = "codex-backup",
    repo_root: Path = REPO_ROOT,
    staging_db_path: str | Path = DEFAULT_DB_PATH,
    continue_on_failure: bool = False,
    attempt_id: str | None = None,
) -> SwarmResult:
    """Run one worker in a detached Git worktree and stage only its diff."""
    agent_name = f"swarm-dev-{worker_index}"
    journal = None
    if attempt_id is not None:
        from herald.router.swarm_attempts import AttemptStore
        journal = AttemptStore(Path(staging_db_path).with_suffix(".attempts.db"))
        receipt = journal.claim(attempt_id, {
            "repo": str(repo_root.resolve()), "task": task.__dict__,
            "backend_model": backend_model, "continue_on_failure": continue_on_failure,
        })
        if receipt is not None:
            if receipt["result"] is not None:
                return SwarmResult(**receipt["result"])
            return SwarmResult(task_id=task.id, agent_name=agent_name, success=False,
                               attempt_id=attempt_id, worktree=receipt["worktree"],
                               error="Attempt is running or interrupted; reconcile existing work before retrying")
    logger.info("Executing swarm task %s (%s) via %s", task.id, task.title, agent_name)

    prompt = f"""Execute the complete repository task below now (worker identifier: {agent_name}).
This message is the task itself, not a role-initialization or setup message. Do not ask for a task, say you are
ready, or merely describe what you would do. Use your tools to inspect and modify this isolated worktree now.

Your single mission is to complete this specific task cleanly without side-effects:

Task: [{task.title}]
Details:
{task.description}

Target Files:
{', '.join(task.target_files)}

Instructions:
1. Inspect the relevant files and implement the requested changes.
2. Ensure no unrelated files or tests are broken.
3. Research and verification tasks must also leave durable repository evidence (for example a proposal, report,
   test, or checklist update). A prose-only response is not completion.
4. Run relevant verification. Do not commit; Herald captures your worktree diff for review and merging.
5. You own execution of this mission. If an approach fails, inspect the evidence and try another. Return without
   a durable change only when an external resource is objectively unavailable, and state that exact dependency.
"""

    temp_root = Path(tempfile.mkdtemp(prefix=f"herald-worker-{worker_index}-"))
    worktree = temp_root / "worktree"
    added = False
    attempts = 1
    response: dict[str, Any] = {}
    completed = False
    try:
        if journal:
            journal.worktree(attempt_id, worktree)
        base_result = subprocess.run(
            ("git", "rev-parse", "HEAD"), cwd=repo_root,
            text=True, capture_output=True, check=False,
        )
        if base_result.returncode:
            raise RuntimeError(base_result.stderr.strip() or "could not resolve swarm base commit")
        base_commit = base_result.stdout.strip()
        created = subprocess.run(
            ("git", "-c", "core.autocrlf=false", "worktree", "add", "--detach", str(worktree), base_commit),
            cwd=repo_root, text=True, capture_output=True, check=False,
        )
        if created.returncode:
            raise RuntimeError(created.stderr.strip() or "could not create isolated worker worktree")
        added = True

        response = _run_worker_agent(prompt, backend_model=backend_model, working_dir=worktree)
        # Opt-in correction stays in this worker's worktree and native session.
        # Never infer that a failed/uncertain provider call is safe to replay.
        if continue_on_failure and response.get("ok") and response.get("native_session_id"):
            changes = subprocess.run(
                ("git", "status", "--porcelain", "--untracked-files=all"),
                cwd=worktree, text=True, capture_output=True, check=True,
            )
            committed = subprocess.run(
                ("git", "diff", "--quiet", base_commit, "HEAD"),
                cwd=worktree, capture_output=True, check=False,
            )
            if committed.returncode not in {0, 1}:
                raise RuntimeError("could not inspect committed worker changes")
            if not changes.stdout.strip() and committed.returncode == 0:
                attempts = 2
                session_id = response["native_session_id"]
                response = _run_worker_agent(
                    "Your previous turn left no repository changes. Continue the original task "
                    "in this same workspace and leave a reviewable change. Do not commit.\n\n" + prompt,
                    backend_model=backend_model, working_dir=worktree,
                    native_resume_id=session_id,
                    **({"native_backend": response["_swarm_backend"]} if response.get("_swarm_backend") else {}),
                    **({"native_backend_fingerprint": response["_swarm_backend_fingerprint"]}
                       if response.get("_swarm_backend_fingerprint") else {}),
                )
                response.setdefault("native_session_id", session_id)
        if not response.get("ok"):
            raise RuntimeError(str(response.get("error") or "worker agent failed"))

        # Include committed, uncommitted, and newly-created files from this
        # worker only. Staging untracked files inside the disposable worktree
        # makes `git diff <base>` complete without touching the primary tree.
        staged = subprocess.run(
            ("git", "add", "-A"), cwd=worktree,
            text=True, capture_output=True, check=False,
        )
        if staged.returncode:
            raise RuntimeError(staged.stderr.strip() or "could not stage worker changes")
        names = subprocess.run(
            ("git", "diff", "--name-only", base_commit), cwd=worktree,
            text=True, capture_output=True, check=False,
        )
        raw_diff = subprocess.run(
            ("git", "-c", "core.autocrlf=false", "diff", "--binary", base_commit),
            cwd=worktree, capture_output=True, check=False,
        )
        if names.returncode or raw_diff.returncode:
            raise RuntimeError((names.stderr or raw_diff.stderr).strip() or "could not capture worker diff")
        files_touched = [line.strip().replace("\\", "/") for line in names.stdout.splitlines() if line.strip()]
        diff_str = raw_diff.stdout.decode("utf-8", errors="replace")

        # A successful CLI exit is not evidence that a worker did work.  In
        # production we have seen coding CLIs answer only "send the task" and
        # exit zero.  Every Admin mission must leave a reviewable artifact;
        # otherwise the next cycle needs an honest failure to recover from.
        if not diff_str.strip() or not files_touched:
            content = str(response.get("content") or "").strip()
            detail = content[-1000:] if content else "worker returned no completion evidence"
            raise RuntimeError(f"worker produced no durable repository change: {detail}")

        staging = StagingStore(staging_db_path, repo_path=repo_root)
        patch_id = staging.submit_patch(
            agent_name=agent_name,
            diff_content=diff_str,
            files_touched=files_touched,
            task_id=task.id,
        )
        logger.info("Staged patch from %s for task %s (%d bytes)", agent_name, task.id, len(diff_str))

        result = SwarmResult(
            task_id=task.id,
            agent_name=agent_name,
            success=True,
            diff=diff_str if diff_str.strip() else None,
            files_touched=files_touched,
            output=str(response.get("content") or ""),
            patch_id=patch_id,
            native_session_id=response.get("native_session_id"),
            attempts=attempts,
            attempt_id=attempt_id,
        )
        if journal:
            from dataclasses import asdict
            journal.finish(attempt_id, asdict(result))
        completed = True
        return result
    except Exception as exc:
        logger.error("Swarm task %s failed: %s", task.id, exc)
        result = SwarmResult(
            task_id=task.id,
            agent_name=agent_name,
            success=False,
            error=str(exc),
            native_session_id=response.get("native_session_id"),
            attempts=attempts,
            attempt_id=attempt_id,
            worktree=str(worktree) if journal and added else None,
        )
        if journal:
            from dataclasses import asdict
            journal.finish(attempt_id, asdict(result))
        return result
    finally:
        if added and (not journal or completed):
            subprocess.run(
                ("git", "worktree", "remove", "--force", str(worktree)),
                cwd=repo_root, text=True, capture_output=True, check=False,
            )
        try:
            temp_root.rmdir()
        except OSError:
            pass


def _run_worker_agent(prompt: str, *, backend_model: str, working_dir: Path, native_resume_id: str | None = None, native_backend: str | None = None, native_backend_fingerprint: str | None = None) -> dict[str, Any]:
    """Execute a CLI-backed Herald worker with an invocation-local cwd."""
    from herald.router.adapters import call_cli
    from herald.router.registry import Registry

    registry = Registry()
    if native_backend is not None:
        if native_resume_id is None:
            return {"ok": False, "error": "Pinned backend requires a native session"}
        selected = registry.get(native_backend)
        candidates = [selected] if selected is not None else []
    else:
        candidates = registry.list_pool(backend_model)
    backend = next((candidate for candidate in candidates if candidate.backend_type == "cli" and candidate.enabled and not candidate.circuit_open), None)
    if backend is None:
        return {"ok": False, "error": f"swarm backend '{backend_model}' is not a CLI backend"}
    fingerprint = hashlib.sha256(json.dumps(backend.config, sort_keys=True).encode()).hexdigest()
    if native_backend_fingerprint is not None and fingerprint != native_backend_fingerprint:
        return {"ok": False, "error": "Original backend configuration changed; native continuation refused"}
    config = dict(backend.config)
    if native_resume_id is not None:
        config["native_resume_id"] = native_resume_id
    config["env"] = {**(config.get("env") or {}), "HERALD_ADMIN_CALL": "1"}
    result = call_cli(config, prompt, working_dir=working_dir)
    # Internal identity is assigned by the dispatcher, never trusted from provider text.
    result["_swarm_backend"] = backend.name
    result["_swarm_backend_fingerprint"] = fingerprint
    return result


def run_isolated_agent(
    prompt: str, *, backend_model: str = "codex-backup", repo_root: Path = REPO_ROOT,
) -> dict[str, Any]:
    """Run a non-patch-producing agent in a disposable detached worktree."""
    temp_root = Path(tempfile.mkdtemp(prefix="herald-admin-think-"))
    worktree = temp_root / "worktree"
    added = False
    try:
        created = subprocess.run(
            ("git", "-c", "core.autocrlf=false", "worktree", "add", "--detach", str(worktree), "HEAD"),
            cwd=repo_root, text=True, capture_output=True, check=False,
        )
        if created.returncode:
            return {"ok": False, "error": created.stderr.strip() or "could not create Admin worktree"}
        added = True
        result = _run_worker_agent(prompt, backend_model=backend_model, working_dir=worktree)
        # The worktree is discarded below, so edits made here never land. Report
        # them so a caller can refuse a decision that rests on its own edits.
        status = subprocess.run(
            ("git", "status", "--porcelain=v1", "--untracked-files=all"),
            cwd=worktree, text=True, capture_output=True, check=False,
        )
        if isinstance(result, dict):
            result["worktree_changes"] = [line[3:] for line in status.stdout.splitlines() if line.strip()]
        return result
    finally:
        if added:
            subprocess.run(
                ("git", "worktree", "remove", "--force", str(worktree)),
                cwd=repo_root, text=True, capture_output=True, check=False,
            )
        try:
            temp_root.rmdir()
        except OSError:
            pass


def inspect_run_recovery(repo_path: Path, run_id: str, *, staging_db_path=DEFAULT_DB_PATH) -> dict[str, Any] | None:
    """Read recovery evidence without dispatching, merging or changing ownership."""
    from herald.router.swarm_attempts import AttemptStore
    path = Path(staging_db_path).with_suffix(".attempts.db")
    repo = str(repo_path.resolve())
    receipt = AttemptStore.inspect(path, json.dumps(["run", repo, run_id]))
    if receipt is None:
        return None
    workers = []
    for task in receipt["identity"].get("tasks", []):
        attempt_id = json.dumps(["worker", repo, run_id, task["id"]])
        worker = AttemptStore.inspect(path, attempt_id)
        result = (worker or {}).get("result") or {}
        workers.append({"task_id": task["id"], "attempt_id": attempt_id,
                        "state": worker["state"] if worker else "not_claimed",
                        "patch_id": result.get("patch_id"),
                        "worktree": (worker or {}).get("worktree"),
                        "worktree_exists": bool(worker and worker.get("worktree") and Path(worker["worktree"]).exists())})
    return {"run_id": run_id, "state": receipt["state"], "workers": workers,
            "automatic_replay_allowed": False,
            "next_action": "retrieve_recorded_result" if receipt.get("result") else "verify_workers_stopped_and_reconcile_staging"}


class SwarmOrchestrator:
    """Manages high-throughput parallel task execution and atomic multi-patch synthesis."""

    def __init__(
        self, repo_path: Path = REPO_ROOT, max_parallel: int = 6,
        staging_db_path: str | Path = DEFAULT_DB_PATH,
    ):
        self.repo_path = repo_path
        self.max_parallel = max_parallel
        self.staging = StagingStore(staging_db_path, repo_path=repo_path)

    def run_checklist_swarm(
        self,
        checklist_path: Path,
        max_tasks: int = 10,
        backend_model: str = "codex-backup",
        on_progress: Callable[[str, Any], None] | None = None,
        run_id: str | None = None,
    ) -> dict[str, Any]:
        """Runs up to `max_tasks` checklist items in parallel, stages all patches, and merges them atomically."""
        tasks = parse_tasks_from_markdown(checklist_path)[:max_tasks]
        if not tasks:
            return {"status": "idle", "message": "No unchecked tasks found in checklist", "merged": 0}

        return self.run_task_swarm(
            tasks,
            backend_model=backend_model,
            on_progress=on_progress,
            run_id=run_id,
        )

    def inspect_run(self, run_id: str) -> dict[str, Any] | None:
        from herald.router.swarm_attempts import AttemptStore
        return AttemptStore.inspect(Path(self.staging.db_path).with_suffix(".attempts.db"),
                                    json.dumps(["run", str(self.repo_path.resolve()), run_id]))

    def run_task_swarm(
        self, tasks: list[SwarmTask], *, backend_model: str = "codex-backup",
        on_progress: Callable[[str, Any], None] | None = None,
        run_id: str | None = None,
    ) -> dict[str, Any]:
        if run_id is None:
            return self._run_task_swarm(tasks, backend_model=backend_model, on_progress=on_progress)
        if not run_id.strip() or len({task.id for task in tasks}) != len(tasks):
            raise ValueError("Durable runs require a nonempty run ID and unique task IDs")
        from herald.router.swarm_attempts import AttemptStore
        journal = AttemptStore(Path(self.staging.db_path).with_suffix(".attempts.db"))
        key = json.dumps(["run", str(self.repo_path.resolve()), run_id])
        from herald.router.swarm_ownership import run_ownership
        with run_ownership(journal.path, key) as owned:
            if not owned:
                return {"status": "active", "run_id": run_id, "tasks_dispatched": 0, "results": []}
            receipt = journal.claim(key, {"tasks": [task.__dict__ for task in tasks], "backend": backend_model})
            if receipt is not None:
                if receipt["result"] is not None:
                    return receipt["result"]["run_result"]
                return {"status": "needs_reconciliation", "run_id": run_id,
                        "message": "Run is active or interrupted; inspect receipts and staging before reconciliation",
                        "tasks_dispatched": 0, "results": []}
            result = self._run_task_swarm(tasks, backend_model=backend_model,
                                          on_progress=on_progress, run_id=run_id)
            result["run_id"] = run_id
            journal.finish(key, {"success": result["status"] in {"completed", "deferred", "idle"}, "run_result": result})
            return result

    def reconcile_run(self, run_id: str, *, reason: str) -> dict[str, Any]:
        """Close interrupted coordination for review; never dispatch or replay merges."""
        from herald.router.swarm_attempts import AttemptStore
        from herald.router.swarm_ownership import run_ownership
        path = Path(self.staging.db_path).with_suffix(".attempts.db")
        key = json.dumps(["run", str(self.repo_path.resolve()), run_id])
        with run_ownership(path, key) as owned:
            if not owned:
                raise ValueError("Run coordinator is active")
            receipt = AttemptStore.inspect(path, key)
            if receipt is None:
                raise ValueError("Run not found")
            report = inspect_run_recovery(self.repo_path, run_id, staging_db_path=self.staging.db_path)
            if any(worker["state"] == "running" for worker in report["workers"]):
                raise ValueError("Worker outcomes are uncertain; reconcile workers before closing the run")
            result = {"status": "needs_revision", "run_id": run_id, "tasks_dispatched": 0,
                      "results": [], "recovery": report, "reason": reason,
                      "message": "Interrupted coordination closed for review; no workers or merges replayed"}
            AttemptStore(path).record_reconciliation(key, expected_updated_at=receipt["updated_at"],
                                                     result={"success": False, "run_result": result}, reason=reason)
            return result


    def _run_task_swarm(
        self,
        tasks: list[SwarmTask],
        *,
        backend_model: str = "codex-backup",
        on_progress: Callable[[str, Any], None] | None = None,
        run_id: str | None = None,
    ) -> dict[str, Any]:
        """Run Admin-authored missions through isolated workers and review."""
        if not tasks:
            return {"status": "idle", "message": "No tasks supplied", "merged": 0}

        self.staging.conflict_resolver = lambda worktree, patches, conflict: _run_reviewer_agent(
            worktree, patches, backend_model=backend_model, conflict=conflict,
        )
        self.staging.reviewer = lambda worktree, patches, verification_failure="": _run_reviewer_agent(
            worktree, patches, backend_model=backend_model,
            verification_failure=verification_failure,
        )

        if on_progress:
            on_progress("started", f"Launching Fast-Track Swarm with {len(tasks)} parallel workers...")

        results: list[SwarmResult] = []
        worker_limit = min(self.max_parallel, _backend_parallelism(backend_model))
        with concurrent.futures.ThreadPoolExecutor(max_workers=worker_limit) as executor:
            futures = {
                executor.submit(
                    execute_swarm_task_worker,
                    task,
                    worker_index=idx + 1,
                    backend_model=backend_model,
                    repo_root=self.repo_path,
                    staging_db_path=self.staging.db_path,
                    **({"attempt_id": json.dumps(["worker", str(self.repo_path.resolve()), run_id, task.id]),
                        "continue_on_failure": True} if run_id is not None else {}),
                ): task
                for idx, task in enumerate(tasks)
            }

            for future in concurrent.futures.as_completed(futures):
                task = futures[future]
                try:
                    res = future.result()
                    results.append(res)
                    if on_progress:
                        on_progress("worker_done", f"Worker for [{task.title}] finished (success={res.success})")
                except Exception as exc:
                    results.append(SwarmResult(task_id=task.id, agent_name="worker", success=False, error=str(exc)))

        # One corrective pass for no-op/transport/tool failures. A transient
        # first response must not consume an entire cycle and discard the
        # objective; the replacement result is what proceeds to review.
        by_id = {task.id: task for task in tasks}
        repaired_results: list[SwarmResult] = []
        for index, result in enumerate(results, start=1):
            if result.success or run_id is not None:
                repaired_results.append(result)
                continue
            try:
                from herald.router.admin_control import stop_requested
                stopped = stop_requested()
            except ImportError:
                stopped = False
            if stopped:
                repaired_results.append(result)
                continue
            task = by_id[result.task_id]
            retry_task = SwarmTask(
                id=task.id,
                title=task.title,
                description=(
                    f"{task.description}\n\nA prior attempt produced no reviewable work. "
                    f"Correct that attempt now. Prior error: {result.error or 'unknown'}"
                ),
                target_files=task.target_files,
            )
            repaired_results.append(execute_swarm_task_worker(
                retry_task, worker_index=100 + index, backend_model=backend_model,
                repo_root=self.repo_path, staging_db_path=self.staging.db_path,
            ))
        results = repaired_results

        # Merge only patches produced by this swarm run.  Unrelated pending
        # proposals may belong to another concurrent Admin objective.
        patch_ids = [result.patch_id for result in results if result.patch_id]
        merge_result = None
        if patch_ids:
            if on_progress:
                on_progress("merging", f"Reviewer synthesizing N-way merge across {len(patch_ids)} staged patches...")
            merge_result = self.staging.auto_merge_patches(patch_ids)

        all_workers_succeeded = len(results) == len(tasks) and all(result.success for result in results)
        merge_status = merge_result.get("status") if merge_result else "none"
        merge_succeeded = bool(patch_ids) and merge_status in {"merged", "deferred"}
        if all_workers_succeeded and len(patch_ids) == len(tasks) and merge_succeeded:
            status = "deferred" if merge_status == "deferred" else "completed"
        else:
            status = "needs_revision"
        return {
            "status": status,
            "tasks_dispatched": len(tasks),
            "results": [
                {
                    "task_id": r.task_id,
                    "agent": r.agent_name,
                    "success": r.success,
                    "patch_id": r.patch_id,
                    "attempt_id": r.attempt_id,
                    "worktree": r.worktree,
                    "attempts": r.attempts,
                    "files_touched": r.files_touched or [],
                    "error": r.error,
                    "output": (r.output or "")[-4000:],
                }
                for r in results
            ],
            "merge_result": merge_result or {"status": "none"},
        }


def _run_reviewer_agent(
    working_dir: Path,
    patches: Any,
    *,
    backend_model: str,
    conflict: str = "",
    verification_failure: str = "",
) -> dict[str, Any]:
    """Let a review worker inspect synthesis and resolve integration issues."""
    patch_summary = "\n".join(
        f"- {patch.agent_name} / {patch.task_id or patch.id}: {', '.join(patch.files_touched)}"
        for patch in patches
    )
    if verification_failure:
        mission = (
            "The synthesized implementation failed verification. Inspect the failing output, fix the underlying "
            "implementation or tests in this worktree, and rerun focused checks as needed. Leave the repair "
            "uncommitted for Herald to stage.\n\nVerification output:\n" + verification_failure[-6000:]
        )
    elif conflict:
        mission = (
            "A Git merge conflict is currently present. Inspect the conflict markers and the contributing "
            "patch intents, resolve every conflict in the working tree, and leave the resolved files uncommitted "
            "for Herald to stage. Preserve both compatible intents."
        )
    else:
        mission = (
            "Inspect the complete synthesized diff for integration errors, duplicated implementations, missing "
            "tests, and violations of the contributing task intents. Make any necessary integration corrections "
            "in this worktree and leave them uncommitted. If it is already coherent, make no changes."
        )
    prompt = f"""You are Herald's staging Reviewer Agent.

{mission}

Contributing patches:
{patch_summary}

Conflict output, if any:
{conflict or '(none)'}
"""
    return _run_worker_agent(prompt, backend_model=backend_model, working_dir=working_dir)
