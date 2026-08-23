# Cost design overview

The project promises no fixed savings percentage. Provider pricing, group activity, persona length, and model cache behavior all vary. Measure your deployment through `/tg status` and retained SQLite telemetry.

“Minimal” means fewer mechanisms, not fewer safeguards: minimize state, interfaces, network requests, and provider-visible bytes while preserving transactions, timeouts, redaction, tests, and observability. The seven mechanisms below are the current expression of that philosophy, not a roadmap for a general platform.

## 1. Deterministic routing decides whether to call a model

Local code handles mentions, replies, configured names, and HMAC probability buckets. An unmatched ordinary message creates no provider run. A probability target that is busy or cooling down is not reassigned or sampled again.

This avoids an entire unnecessary call instead of shaving a few tokens after starting one. See [Routing architecture](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/architecture.md).

## 2. A stable provider prefix reuses cache

The shared protocol comes first, followed by the persona, then a bounded identity + format sticker catalog, then fixed-order tool schemas. This maximizes the byte-identical prefix shared by bots. The catalog holds only capped set + `static|animated|video` + emoji + short_id lines and remains pinned. A separate list of at most eight recent user stickers that are visible in the current context and sendable by this bot is stored independently. The provider sees it once, after the latest Telegram batch, rather than repeated after every historical batch. It is omitted when the suffix budget cannot fit it. All three formats are sent with Telegram's original file id.

A fingerprint covers the Pi/provider/model/cache policy, protocol, persona, serializer, compaction, extensions, and tools. A cache-visible change increments the schema and creates a new session/epoch before restoration; an old session file is retained but never resumed under a different identity. UI, telemetry, and operator commands may not alter provider bytes. See [Cache engineering](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/cache.md).

## 3. Bounded context carries only necessary facts

SQLite retains canonical Telegram history and an immutable event stream. Each bot consumes that stream with a monotonic cursor, while separate visible references describe only full messages still present in the current context. The model receives a token-bounded event batch with direct addresses (@mention / reply / configured-name keyword) first; logs, raw rich JSON, UI state, and unbounded tool output never enter provider context.

The default new-suffix cap is 12,000 tokens and the per-event cap is 4,096. This separates the complete local source of truth from the context necessary for one run. See [Architecture](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/architecture.md) and the [data model](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/data-model.md).

## 4. Compaction changes epochs at an explicit boundary

The main model uses an effective 64K context window. When context reaches the configurable trigger threshold (default 32K, maximum 49,152), it produces a summary, retains the configured amount of recent verbatim text (default: only the latest complete turn), and starts a new epoch. Failed or empty summaries do not fabricate an epoch. Structured details replace visible references, while the business-consumption cursor never moves backward or replays compacted history.

Compaction uses a configured cheap task model with provider cache retention disabled, so it is not an every-turn online optimizer. Configuration controls the threshold and retained amount; telemetry validates the result. See [Cache engineering](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/cache.md) and [test status](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/testing.md).

## 5. Media vision runs lazily and reuses results

Static photos and stickers from users and bots enter canonical SQLite first and share one bounded display cache; video sources are prepared lazily only for a real vision turn. SQLite stores only a cache-relative filename, so moving a deployment does not pin TUI rendering to the previous absolute path. Vision is disabled by default. When explicitly enabled, each turn has a media cap and all bots share one FIFO concurrency gate; there are no process-local hourly or daily quotas. Video download, extraction, and the single provider request hold one global slot; each video contributes at most three frames but only one provider call. If FFmpeg is missing, video skips before download and consumes no provider tokens, while chat, image vision, and sticker sending continue. Results are persisted by media identity, reused across bots, and appended as immutable media-update events instead of rewriting old context. UI updates consume cached results without adding a model call.

After a successful compaction, the daemon deletes a bounded batch of local media files no longer referenced by any configured bot; unconsumed messages and pending replies remain protected. Messages, vision descriptions, sticker short IDs, and Telegram file mappings remain durable, so a future turn can reacquire the source while reusing an existing vision result. Restart does not automatically download that unreferenced history again.

See the [Vision architecture](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/architecture.md).

## 6. Pages are retrieved only on demand and stay bounded

Search and page reading share one tool instead of adding a fourth stable schema entry. A query returns at most five compact results. A URL creates one request only when the model explicitly needs it; page text has an 8,000-character local guard and a 2,048-token provider-output cap. Turns that do not use the feature add no retrieval request or dynamic page tokens.

Deterministic code handles the untrusted-content boundary, URL safety, and log redaction without another model call. A fetch still consumes one TinyFish request and adds bounded text to the current dynamic context, so actual cost depends on call frequency and page length.

## 7. UI and telemetry use side channels

The Pi-native feed, assistant partials, feed-status widget, `/tg status`, and Telegram controls use local IPC, SQLite, and the deterministic control plane. They remain outside personas and main provider context.

Opening Pi, scrolling history, or viewing usage therefore does not create a chat-model call. See the [Pi-native transcript architecture](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/architecture.md) and [Cache engineering](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/cache.md).

## Evaluate your deployment

1. Use `/tg status [bot]` or Telegram `/status` under the [unified telemetry semantics](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/telemetry.md) to record runs, current context/window, prompt miss/read/write, output, reasoning, latency, and cost; “lifetime” means the configured SQLite retention window. `≈` marks a local strict-prefix estimate used when the provider omits cache token details; it is not proof of an actual provider hit. Each run freezes cost under its original provider usage and actual provider/model rate at response time, so local estimates never recalculate cost, while totals after a model switch retain old-model cost and add new-model cost; subscription providers may expose only an equivalent pay-as-you-go estimate.
2. Compare similar activity periods; do not mix providers, personas, or group sizes in one conclusion.
3. Base compaction-threshold changes on `bun run debug` and `llm_runs` telemetry context data; do not tune by intuition.
4. Before changing prompts, tools, or serialization, follow the cache process in the [development guide](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/engineering/development-guide.md).
5. Compare cost per useful public reply as well as cost per run; a silent or failed run is still a provider cost.
6. Before adding a capability, try to remove one layer, tool, model call, or dynamic field. Do not expand a one-group deployment into a multi-tenant system without an explicit requirement.
