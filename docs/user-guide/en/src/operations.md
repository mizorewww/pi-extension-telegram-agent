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
| `/fire status` | whether other bots' messages can trigger this bot, and how much budget is left |

Only people in `telegram_admins`:

| Command | Effect |
|---|---|
| `/model` | pick any model Pi is logged into using buttons; it is saved to the configuration and a new session starts at once |
| `/new` | drop the current context and start a new session; the bot only sees later messages. Useful when a bot is stuck on a misunderstanding |
| `/compact` | summarize the context now (calls the summary model, which costs a little) |
| `/set` | open a button menu to pick how often the bot joins in (0–1) and the pause after a spontaneous reply; takes effect at once |
| `/fire on` / `/fire off` | let other bots' messages trigger this bot, or stop it; a bare `/fire` toggles |

- `/model` and `/set` are written back to `telegram.config.ts` and survive restarts.
- While a bot is replying, `/model`, `/new` and `/compact` ask you to retry later instead of interrupting it.
- After a model change or `/new`, the old session file stays on your machine.

## Letting other bots trigger a bot (`/fire`)

By default a bot only reacts to people. `/fire on` lets messages from other bots reach it too:

- **Scope**: only the bot that receives the command (or the one named in `/fire@bot_username on`), only in this group. Other bots are unaffected. Only a human admin can switch it; commands sent by bots are ignored.
- **Same rules as people**: a bot's message goes through the normal order (@mention > reply > `name` > `routing_p`). If the normal winner does not have `/fire` on, nothing happens; the message is never handed to another bot. A bot never triggers itself, and an edited bot message never triggers again. Such a message does not count as an unanswered mention, so the bot may stay silent.
- **Loop budget**: after any human message in the group, each `/fire` bot may be triggered by bots at most 3 times in a row. When the budget is spent, bot messages are ignored until a person says something or an admin sends `/fire on` again. A trigger skipped because the bot was busy or cooling down does not use budget. `/fire status` shows what is left.
- **Not saved**: the setting lives in memory only; after a restart every bot is back to off.
- **Bots in this deployment**: when one of your bots replies, the daemon routes that reply to the other bots itself once it has been saved, so bots configured together can trigger each other. Command replies (`/status`, `/fire` and so on) and messages you send from the Pi TUI never trigger anyone.
- **Bots outside this deployment**: they can only trigger a bot if Telegram actually delivers their messages. According to Telegram's Bot FAQ, bots do not receive other bots' messages in groups, and turning `/fire` on does not change that.

## Backup

1. `bun run stop`, and confirm `bun run status` shows it is not running;
2. copy `telegram.config.ts`, `.env`, `personas/*.local.md` and the whole `data/` directory;
3. keep `.env` and private personas somewhere safe.

SQLite (`data/agent.db`) is the only copy of the chat history; Telegram cannot be used to restore it.

## Another group

One deployment serves one group. A second group needs its own clone with its own `.env`, configuration, personas, bot tokens and `data/`. Do not switch configuration files in one directory and run two copies at once: they would mix chat histories and fight over the same process lock.

Next: [Troubleshooting](troubleshooting.md).
