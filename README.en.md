# Pi Telegram Agent

[中文](README.md) · [English](README.en.md)

Let a few AI bots, each with its own persona, live permanently in your Telegram group: they join conversations by probability, send animated stickers, and understand images and videos — like real group members. You observe and control everything from the local Pi terminal.

## Why use it

- **Fast**: a local daemon runs permanently, and incoming messages route straight to the right bot — no cold start.
- **Cheap**: the provider prefix cache means repeated context is never billed twice; routing, dedupe, and state are pure deterministic code — zero model calls spent on plumbing.
- **Simple**: one config file, one structure. Change a value, restart, done.

## Quick start

You need: [Bun](https://bun.sh/), a Telegram supergroup, and at least one [BotFather](https://t.me/BotFather) token (the bot must be in the group with privacy mode disabled, or it cannot see ordinary messages). Video frame sampling additionally needs host `ffmpeg` (including `ffprobe`); without it, videos stay text placeholders while the rest of the agent keeps working.

```bash
git clone https://github.com/mizorewww/pi-extension-telegram-agent.git
cd pi-extension-telegram-agent
bun install
bun run pi
```

Then two things inside Pi:

1. `/login` to authenticate a model provider and `/model` to pick the default model (credentials stay with Pi, outside this repo). The default media mode (`vision`) works with any chat model; image input is required only if you opt into `media.mode: "context"`, which refuses to start with a text-only model.
2. `/tg config` to run the setup wizard: group ID, token, persona. Once it validates, the daemon is ready.

Done. Mention your bot in the group or just say something; `/help` lists the group commands.

> Note: Pi's input dialog does not mask secrets — the token stays visible while you paste it. Use a private terminal and don't record your screen.

## Everyday use

```bash
bun run start      # Start in the background
bun run pi         # Open the observation/control UI
bun run status     # Check status
bun run restart    # Restart to apply config changes
bun run stop       # Stop
```

In the group, `/help` and `/status` work for everyone; admins (listed in `telegram_admins`) also get `/compact` and `/set` — and `/set` writes the new value straight back into the config file.

## Configuration

There is exactly one config file, `telegram.config.ts`, with a comment on every field — copy [telegram.config.example.ts](telegram.config.example.ts) and change a few values. Secrets (tokens, API keys) live in `.env`. Adding another bot means adding one entry to `bots` — no code changes.

Full reference: [Configuration guide](docs/user-guide/en/src/configuration.md).

## Getting help

- Common problems: [Troubleshooting](docs/user-guide/en/src/troubleshooting.md)
- Daemon operations (restart, logs, diagnostics): [daemon runbook](docs/runbooks/daemon.md) — `bun run debug` produces a full diagnostic report
- Complete user guide: [English](docs/user-guide/en/src/README.md) · [中文](docs/user-guide/zh/src/README.md)

## Contributing

Start with [AGENTS.md](AGENTS.md) and the [development guide](docs/engineering/development-guide.md); the documentation index is [docs/index.md](docs/index.md). Licensed under MIT — see [LICENSE](LICENSE).
