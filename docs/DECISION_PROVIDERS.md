# Decision providers

Applications call `herald.Router` (`herald.client.RouterClient`), never a provider
directly. `decide(state, questions, *, provider=None, model=None,
decision_name=None)` preserves the original two positional arguments. It returns
`answers`, `provider`, `model`, `latency_ms`, and `usage`. An error envelope means
the application should use its ordinary LLM/rule alternative.

## Configure your own providers

Provider instances have user-assigned names and persist in `decisions.db` under
Herald's data directory (`HERALD_DECISIONS_DB` can override the database path).
Credentials are `env:`, `keyring:` or `vault:` references resolved for each call.
Local providers need no key. No provider is added by discovery.

Create a JSON specification, then run:

```
herald decisions configure provider.json
herald decisions providers
herald decisions remove 'My local model'
```

Example local specification:

```json
{
  "name": "My local model",
  "provider_type": "ollama",
  "url": "http://127.0.0.1:11434/v1/systemone",
  "model": "my-installed-decision-model",
  "enabled": true,
  "is_default": true,
  "config": {"pricing": {"per_request": 0}}
}
```

For a hosted provider, set its exact endpoint/model and add
`"secret_ref": "vault:provider/my-key"`. This is a reference to an existing
credential, never the credential itself. Use the SDK's
`list_decision_providers`, `configure_decision_provider` and
`delete_decision_provider` methods, or authenticated
`GET /v1/decision-providers`, `PUT /v1/decision-providers/{name}` and
`DELETE /v1/decision-providers/{name}`. Disabled instances remain in inventory.

If no registry has ever been configured, the legacy `HERALD_DECISION_URL`,
`HERALD_DECISION_MODEL`, and `HERALD_DECISION_SECRET_REF` configuration remains
available. Deleting every configured instance does not reactivate legacy Jev.
An unavailable, disabled or removed chosen backend fails explicitly; the
application then uses its LLM route rather than an unrelated decision provider.

## Native protocols

| Type | Batch mode | Protocol / example endpoint |
| --- | --- | --- |
| `typesafe` | `parallel` | System One, `https://api.typesafe.ai/v1/systemone` (`jev-latest`, `jev-1.14.0`; up to 128+ questions in one ~130–175 ms pass) |
| `openrouter` | `parallel` | System One gateway, `https://openrouter.ai/api/v1/systemone` (routes across `jev-latest`, `liquid/d1.1`, `perplexity/pplx-decider-v1.2`, `cloudflare/clef` with one OpenRouter key and reports `usage.cost` directly) |
| `ollama`, `llama_cpp` | `sequential` | Exact configured local System One endpoint (e.g. `http://127.0.0.1:11434/v1/systemone` with `tev1`); no required key; evaluates questions sequentially (~90–110 ms/question) |
| `systemone` | `parallel` (HTTPS remote) / `sequential` (local) | Exact configured System One endpoint |
| `liquid` | `parallel` | System One, `https://api.liquid.ai/decisions/v1/systemone` (`d1`, `d1.1`, `d1-ultra`) |
| `perplexity` | `parallel` | System One, `https://api.perplexity.ai/v1/decisions` (`pplx-decider-v1.2`, `pplx-decider-flash-v1.2`) |
| `cloudflare` | `parallel` | Workers AI System One; exact account/model `/ai/run/@cf/cloudflare/clef` endpoint; REST result envelope is unwrapped |
| `openai` | `parallel` | Native Decisions `/v1/decisions` (`gpt-6-luna`, up to 400 questions per request, $0.10 / 1M uncached input tokens, $0 output tokens); predicates, choices and score levels translate to Herald's named answers |
| `openai_compatible` | `sequential` | Explicit ordinary chat-completions JSON adapter for a custom provider |

### Hosted parallel batching vs. local sequential inference

`decide(...)` and `GET /v1/decision-providers` expose `"batch_mode": "parallel" | "sequential"`:

- **`parallel`** (`typesafe`, `openrouter`, `openai`, `perplexity`, `cloudflare`, `liquid`): Hosted System One / Decisions APIs evaluate 40–128+ questions in a single forward pass (~130–270 ms total). Harnesses can send a **wide semantic surmise** (a multi-facet battery of 35–40+ observable yes/no questions covering specialist routing, tool necessity, commitment extraction, and sub-intent facets) in one request and log only the privacy-safe boolean/probability vector without storing raw prompt text.
- **`sequential`** (`ollama`, `llama_cpp`): Local single-GPU endpoints (such as `tev1` on Ollama) evaluate questions sequentially (~90–110 ms per question). Harnesses should keep local decision calls lean (1–5 questions per point) so single-GPU latency stays under ~500 ms.
- **`llm` / BYOK fallback**: When no decision provider is configured or enabled, applications use their ordinary LLM/rules path without calling `/v1/decide`.

OpenAI predicates become `noul` probabilities. Choice probability arrays become
named distributions. Score questions use ordered levels (at most ten for OpenAI),
and fractional weighted scores remain valid. Refusals, duplicate/missing answers,
invalid distributions, invalid confidences, and out-of-range values fail safely.
System One yes/no answers need no separate confidence field. Applications choose
confidence thresholds and execute their own fallback.

Provider-owned protocol references checked 2026-10-27:

- [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions) and [API schema](https://developers.openai.com/api/reference/resources/decisions/methods/create)
- [Perplexity's model and request schema](https://huggingface.co/perplexity-ai/pplx-decider-v1.2)
- [Cloudflare Clef REST example and schema](https://developers.cloudflare.com/workers-ai/models/clef/)
- [Liquid d1 API example](https://www.liquid.ai/blog/d1-decision-model)
- [Ollama decision-model API](https://registry.ollama.com/library/d1)

URLs and model names remain configuration. A llama.cpp installation must expose
a System One-compatible decision endpoint; ordinary text-generation endpoints
are not interchangeable with it.

## Cost, speed and usage

Each attempt records metadata without state, prompts or answers: decision name,
route, provider, model, latency, tokens, cost, status and fallback reason. Missing
usage stays unknown, rather than zero. Provider-reported cost wins. Optional
`config.pricing` can supply `input_per_million`, `output_per_million` and/or a flat
`per_request` amount in USD; token estimates require the corresponding measured
token counts and both input/output rates. A flat price alone needs no token count.

The legacy default Jev endpoint uses the published 2026-10-27 input rate of
$0.042 per million, output free ([TypeSafe pricing](https://typesafe.ai/)); custom
URLs and configured instances require reported or configured pricing. There is
no generic inference of prices from model names. Check provider-specific cached,
regional and other billing rules when configuring estimates.

`herald usage`, `/usage/summary`, and `/usage/all` expose decision totals by route,
provider and model, including average latency and cost coverage. The SDK's
`record_decision(record)` posts ordinary LLM/rule decision metrics to
`/v1/decisions/usage`. These records use `decision_name`, `route` (`llm`, `rules`,
`decision_model`), `status` (`success`, `failure`, `fallback`), optional provider/model,
integer `latency_ms`, integer input/output tokens, cost and fallback reason.
Unsupported fields are rejected. Applications must not report provider attempts
again: Herald has already recorded those. Chat responses also retain actual
provider usage, backend and resolved model so decision clients can account for
the ordinary route without another lookup.
