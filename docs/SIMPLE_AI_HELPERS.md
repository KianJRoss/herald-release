# Simple AI helpers

Herald exposes three small, typed operations at package level. They route through
the same router as `herald.chat`, but add a focused prompt and enforce the output
contract before returning it.

```python
from pydantic import BaseModel
from herald import classify, extract, summarize

summary = summarize(article, max_words=80, model="balanced", timeout=30)
queue = classify(ticket, ["billing", "bug", "question"])

class Contact(BaseModel):
    name: str
    email: str | None = None

contact = extract(message, Contact)
```

Async applications can use `asummarize`, `aclassify`, and `aextract`. These run
the corresponding synchronous router call in a worker thread, matching Herald's
existing async API convention.

`classify` requires at least one non-empty, unique label and accepts only an
exact returned label. `extract` accepts any Pydantic `TypeAdapter`-compatible
type (including `BaseModel` classes, dataclasses, and typed containers), parses
JSON, and validates it. Invalid model output raises `InvalidResponseError` with
a sanitized message that does not include the input or model response. Router
and timeout failures instead raise `RouterUnavailableError`; they are never
returned as summaries or re-labeled as validation errors. `model`, `timeout`,
and `mode` are forwarded unchanged. Pass `client=` to use an injected Router;
otherwise helpers use Herald's configured client.

For project tool isolation, the same operations are available on a `Part`:

```python
triage = herald.project("support").part("triage")
queue = triage.classify(ticket, ["billing", "bug", "question"])
contact = await triage.aextract(message, Contact, timeout=30)
```

The `Part` methods use the identical helper contracts and validation while
invoking the router with that part's project and tool scope.
