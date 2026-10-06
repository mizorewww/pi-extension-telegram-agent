# Daily operations and group commands

## Start and stop

```bash
bun run start      # start in the background
bun run status     # is it running?
bun run restart    # apply configuration changes
bun run stop       # stop
```

Logs are in `data/daemon.log` (structured JSON without chat content). For long-running use, manage the daemon with systemd as described in the [daemon runbook](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/runbooks/daemon.md).

## Group commands

Send these in the group. A command applies to the bot that receives it; with several bots, use `/command@bot_username`. They are handled by code, never enter a bot's conversation, and do not call a model (except `/compact`).

Anyone:

| Command | Effect |
|---|---|
| `/help` | command help |
| `/status` | this bot's state, context share, usage and cost |

Only people in `telegram_admins`:

| Command | Effect |
|---|---|
| `/model` | pick any model Pi is logged into using buttons; it is saved to the configuration and a new session starts at once |
| `/new` | drop the current context and start a new session; the bot only sees later messages. Useful when a bot is stuck on a misunderstanding |
| `/compact` | summarize the context now (calls the summary model, which costs a little) |
| `/set routing_p <0–1>` | change how often the bot joins in on its own |
| `/set cooldown_ms <ms>` | change the pause between spontaneous replies |

- `/model` and `/set` are written back to `telegram.config.ts` and survive restarts.
- While a bot is replying, `/model`, `/new` and `/compact` ask you to retry later instead of interrupting it.
- After a model change or `/new`, the old session file stays on your machine.

## Backup

1. `bun run stop`, and confirm `bun run status` shows it is not running;
2. copy `telegram.config.ts`, `.env`, `personas/*.local.md` and the whole `data/` directory;
3. keep `.env` and private personas somewhere safe.

SQLite (`data/agent.db`) is the only copy of the chat history; Telegram cannot be used to restore it.

## Another group

One deployment serves one group. A second group needs its own clone with its own `.env`, configuration, personas, bot tokens and `data/`. Do not switch configuration files in one directory and run two copies at once: they would mix chat histories and fight over the same process lock.

Next: [Troubleshooting](troubleshooting.md).
