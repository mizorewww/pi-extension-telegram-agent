# Design and philosophy

This project makes group chat another entry point for Pi: deterministic code handles Telegram transport and routing, while Pi handles conversations, models and tools. The goal is a thin wrapper that stays small to maintain.

## 1. Code decides when to speak

Mentions, replies and configured names explicitly trigger a bot. An ordinary message reaches at most one bot by probability; busy or cooling-down bots are skipped without rerouting. Bots do not trigger one another unless an admin enables `/fire`.

Pending direct replies live in a Pi document across restarts and compaction. If a healthy generation finishes without posting, it gets at most one repair prompt; continued silence waits for another input. An unknown Telegram send outcome is never retried and settles the pending material seen by that run, avoiding duplicates.

## 2. Telegram, the archive and Pi conversations have separate jobs

1. Telegram transports messages; it is not a source for recovering history.
2. `data/agent.db` stores immutable group-message, edit, quote and media-description events for routing and `tg_messages` search.
3. Pi Durable owns conversations, queues, background tasks and cumulative usage in `data/pi/<bot>.sqlite`.

Each batch is admitted to Pi once. The archive can be much larger than the current model context. Recovery relies on local persisted state, so back up the whole `data/` directory.

## 3. Pi-native first

Pi 1.5.0 supplies persistence, steering, retries, compaction, child conversations, background tool tasks, usage accounting, coding tools, image processing and codemode. Research tasks read a workflow's `AGENTS.md` and share the main bot's isolated work box; they no longer start another Pi CLI or use custom task RPC.

The wrapper keeps Telegram-specific routing, decisions about retrying a public send, admin commands, hybrid description caching, search and rootless Docker deployment. A whole-stream provider deadline and proxy HTTP 413 normalization remain small adapters because Pi 1.5.0 does not cover those real failure boundaries.

Pi Durable remains an experimental API. All Pi packages are pinned exactly to 1.5.0; upgrades must move together and verify recovery and sending behavior.

## 4. Avoid unnecessary model spending

- Routing, status and administration use code; `/compact` is the command that calls a model.
- Within a context segment, system instructions, persona, tools and existing inputs stay fixed while new messages append. Compaction, model changes and `/new` establish a new prefix.
- Group events and pending replies share a bounded character budget. Search returns short results, pages are read incrementally, and scripts filter output before returning it to the model.
- Hybrid describes each media item once and shares the result across bots. The main model opens an original only for details. Pi persists native image bytes, without an external image-reference protocol.
- Compaction uses the current chat model and reasoning effort with a fixed 16,384-token reserve and no early background compaction. Native summaries omit images and thinking; encrypted-signature costs and oversized summaries still have limits.
- A final standalone `send` can end the turn; progress sends inside codemode can continue working. Only send posts to the group.

`/status` reports Pi's cumulative usage, including children and history; `/new` does not clear it. Zero catalog prices do not mean free service: the provider's bill is authoritative.

## 5. Prompts supply group-chat semantics

The persona describes personality and response style. Pi's native schemas explain tool arguments. The prompt adds group-message grammar, public-send policy and the source repository, without repeating a complete tool tutorial. A bot can read its own code to explain its implementation.

Each batch's sticker candidates appear as a separate system note at a fixed position after that batch, only in model requests. They never enter persisted user content, so native compaction cannot mistake them for something a group member said.

## 6. Safety comes from mechanisms

- Codemode runs in a Pi QuickJS worker without host APIs, direct network or file access; it can call only permitted tools.
- Native read/write/edit/bash enter rootless Docker through pi-env: no host directories or credentials, a read-only root, resource limits and a separate `/work` volume. Sending files adds path and size checks.
- Search refuses private, loopback and cloud-metadata addresses.
- State-changing commands verify numeric admin IDs; control messages never enter model context.
- Restart recovery follows Pi's tool replay rules. Unsafe work that started but has an unknown outcome is not blindly repeated. `/new` waits for old work to stop before resetting.

## 7. Think first, then write

Check whether Pi can own a responsibility before adding code. Delete duplicate mechanisms before introducing abstractions; keep no legacy fields or parallel execution paths. Configuration consists of `telegram.config.ts`, Pi settings and `.env`; `/set` and `/model` validate and atomically write back to that same configuration.

No TDD or piles of tests that pin implementation details. Keep cache, zero-network and important security guards; use type checking, offline native execution and explicitly authorized real-service validation to check behavior.

## Deliberate limits

- No Telegram Rich Message output, so older clients can read replies.
- No automatic opening of group links.
- One deployment serves one group; another group uses a separate directory and tokens.
- No retry when a Telegram send's outcome is unknown.
