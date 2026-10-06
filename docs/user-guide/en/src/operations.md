# Daily operations

## Canonical commands

```bash
bun run start
bun run status
bun run restart
bun run stop
```

- `start`: starts in the background and waits for PID/socket readiness; invalid config fails before any bot polls.
- `restart`: serially stops the deployment's PID owner and orphan processes, waits for every PID/file/socket to disappear, then starts one replacement.
- `status`: verifies that the PID belongs to this repository's daemon instead of trusting the file alone.
- `stop`: gracefully stops bots, agents, and IPC with SIGTERM.

Logs are in `data/daemon.log`. The controller shows only a bounded credential-redacted tail. Never post a full `.env` or unreviewed logs.

## Configuration changes

Configuration is not hot-reloaded. After changing `telegram.config.ts`, `.env`, or a persona, run:

```bash
bun run restart
```

You can also use `/tg config` in Pi to validate or safely edit an existing source. Replacement retains local `.bak-<nonce>` files. Confirm the new deployment is ready before applying your backup-retention policy; do not delete backups as incidental cleanup.

## Data and backups

Persistent resources default to `data/` and local project session directories. SQLite is canonical history; Telegram is not the restore source.

Before backup:

1. run `bun run stop`;
2. confirm `bun run status` no longer reports running;
3. copy configuration, personas, data, and session resources to an access-controlled destination;
4. keep `.env` and private personas out of public artifacts.

Never start two daemons against one copied database in the same directory.

## Telegram group controls

Public read commands are `/help` and `/status`.

`/status` shows only the bot that actually received the command; use `/status@bot_username` to target one explicitly. Its rich message shows runtime state, provider/model/effective reasoning, current context/window/percentage, system/tool/summary/message/free segments as one red/purple/brown/blue/green square per rounded 1,024 tokens, average tok/s/send/think time, latest conversation request, retained SQLite totals, cache hit rate, latency/cost, routing, and latest compaction. The square bar occupies its own line and the legend follows line by line. Current context comes directly from the Pi session; after compaction it remains unknown until the next main request instead of showing a previous epoch. It shares the [unified telemetry semantics](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/telemetry.md) with Pi `/tg status`. If Telegram definitively rejects the rich-message method or format before creating a message, the daemon sends one independently generated plain-text projection instead. It does not resend after uncertain outcomes.

Only `telegram_admins` may run:

```text
/model
/compact
/new
/set <routing_p|cooldown_ms> <value>
```

Choose `/model` in Telegram's bot command menu (or `/model@bot_username` in a group with several bots). Provider and pagination buttons cover every currently authenticated model in Pi, including installed provider extensions. Selecting a model saves this bot's choice in `telegram.config.ts` and starts a fresh session immediately, retaining the old session file. Selecting the current model does not reset its session. Retry later if the bot is busy. Reasoning keeps the current level where supported; otherwise Pi adjusts it to the model's capabilities and the result shows the effective level. Image context mode rejects models without image input. The menu makes no LLM calls; the first conversation after a model change builds a new cache.

A command acts on the bot that received it; append `@bot_username` to target a specific bot. The deterministic control plane consumes these commands outside persona/provider context. `compact` uses the existing auxiliary summarization model and may incur cost. Busy bots are not aborted. `new` drops the current context and starts a fresh session on the current model (the old session file stays on disk); the bot only sees messages sent afterwards. Use it when the context has gone off the rails; retry if the bot is busy. `set` writes through to `telegram.config.ts`, so the new value survives restarts.

## Real verification

Default `bun test` avoids Telegram/provider calls; the test preload mechanically rejects every non-loopback network access. Networked scripts require a bot selection:

```bash
bun run scripts/smoke-pi.ts --bot friend
bun run scripts/e2e-agent.ts --bot friend
bun run scripts/e2e-compaction.ts --bot friend
```

These commands may incur cost or post group messages. Read the [daemon runbook](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/runbooks/daemon.md) first and record the selected bot, expected side effects, and rollback.

## Why working directories must be isolated

One working directory currently hosts one group deployment. This is not merely a UI limitation: the following resources belong to the working directory and have no deployment namespace:

- the single `group_peer_id` and canonical SQLite history, including each bot's consumed cursor, visible references, and reply obligations;
- agent sessions and context epochs;
- each poller's Telegram update offset and the shared router secret;
- the daemon PID, control lock, and Unix socket.

Running a second group in one checkout by only switching configuration files therefore does not create two deployments. It can feed one group's history into another group's model context, skip updates through the wrong offset, or make daemons compete for one PID/socket.

Use a separate clone or worktree for a second group. Give it independent `.env`, config, personas, and Telegram bot tokens, plus a separate `data`/database, sessions, PID/lock/socket, and daemon working directory. Do not merely copy the database or point both directories back to shared data.

This boundary follows the project's minimal-design principle: reuse an existing, inspectable filesystem isolation boundary instead of adding namespaces, hot reload, and another control plane for an unrequested multi-tenant product. Read the [cost design overview](design-cost.md) for the philosophy and the [project description](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/project.md) for the authoritative boundary.

Next: [Troubleshooting](troubleshooting.md).
