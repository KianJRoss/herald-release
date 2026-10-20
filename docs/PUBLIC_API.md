# Herald package public API

Herald 0.2 establishes these supported Python entry points:

- `herald.ask`, `aask`, `chat`, `quick`, `code`, `acode`, `connect`, and `start`
- `Harness.open`, `ask`, `code`, `reason`, `fast`, `tool`, `tools`, `agent`, `map`, and `run_flow`
- `StatefulAgent.ask`, `review`, `review_each`, `decide`, `structured`, their async forms, `stream`, `inspect`, `export`, `reset`, and `delete`
- `Decision.choice`, `reason`, `confidence`, `raw`, and `requires_human_review`
- `Flow` and `FlowSpec`
- `HeraldError`, `RouterUnavailableError`, `InvalidResponseError`, `DecisionValidationError`, and `SessionBusyError`

Compatible additions may be made in 0.x releases. Removing or changing these
entry points requires a documented migration and a minor-version increment.
Router HTTP endpoints remain versioned separately from this Python contract.
