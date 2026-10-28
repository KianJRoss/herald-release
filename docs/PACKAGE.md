# Herald Package

Herald Package puts model-backed judgment inside ordinary application code.
It is designed for decisions that are difficult to express as deterministic
rules but still need a fast, validated answer: ticket routing, document
extraction, content review, exception triage, and other contextual work.

Keep deterministic logic in normal code. Use Herald at the boundary where the
input is ambiguous, natural-language-heavy, or needs a consistent judgment
across many similar items.

## Small, validated operations

```python
from pydantic import BaseModel
from herald import classify, extract, summarize

queue = classify(ticket, ["billing", "bug", "question", "needs-review"])
brief = summarize(long_report, max_words=80)

class Contact(BaseModel):
    name: str
    email: str | None = None

contact = extract(message, Contact)
```

`classify` accepts only one of the supplied labels. `extract` validates the
model output with Pydantic. Invalid or unavailable model responses raise typed
exceptions instead of quietly becoming application data. Async forms are
available as `aclassify`, `aextract`, and `asummarize`.

## Durable decisions with a review boundary

Use a stateful agent when several decisions must apply the same instructions
and reuse the visible history of earlier items:

```python
from herald import Harness

app = Harness.open(".", create=True, name="application-review")
reviewer = app.agent(
    "Reviewer",
    memory="applications-2026",
    instructions="Apply the same eligibility policy to every application.",
)

decision = reviewer.decide(
    question="What should happen to this application?",
    options=["approve", "reject", "needs-review"],
    context=application,
    confidence_threshold=0.8,
)

if decision.requires_human_review:
    send_to_review_queue(application, decision.reason)
```

Herald keeps recent visible exchanges and a bounded decision ledger in
encrypted Router storage. It does not store or expose a provider's private
reasoning. A repeated request ID is idempotent, and overlapping calls to one
stateful session are rejected to preserve sequential semantics.

## Project-scoped tools

```python
from herald import Harness

app = Harness.open(".")
backend = app.for_part("backend")
result = backend.ask("Find the cause of the failing health check")
health = backend.tool("project_health")
```

The Router gives the model only the tools bound to that project part and
validates requested calls at the execution boundary. The same scope works
across API, local, browser-session, and coding-CLI backends.

## Parallel and multi-agent work

Use `app.map(...)` for independent items, a stateful agent for dependent
decisions, and `Flow` when several named roles need separate memories and
explicit stages. All three use the same Router modes, provider health,
budgets, and failover policy.

See the [public API reference](PUBLIC_API.md),
[simple helper contracts](SIMPLE_AI_HELPERS.md), and the runnable
[`examples`](../examples) directory for more.
