# Pi Telegram Agent

[中文](README.md) · [English](README.en.md)

Let a few AI bots, each with its own personality, live in your Telegram group: they answer when mentioned, sometimes join in on their own, send stickers, and understand images and videos, like real group members. You watch and control everything from the Pi terminal on your machine.

- **Fast**: a daemon runs on your machine and routes incoming messages immediately, with no cold start.
- **Cheap**: deterministic code decides whether to respond, so no model call is wasted; prompt prefixes stay unchanged to reuse provider caching (the actual discount depends on the provider).
- **Simple**: one configuration file; adding a bot means adding one entry.

## Quick start

You need:

- [Bun](https://bun.sh/) and a local [Pi](https://github.com/earendil-works/pi) installation (`pi` on your PATH);
- a Telegram supergroup and at least one [BotFather](https://t.me/BotFather) bot with **group privacy turned off**, added to the group;
- optionally `ffmpeg`, so bots can understand videos.

```bash
git clone https://github.com/mizorewww/pi-extension-telegram-agent.git
cd pi-extension-telegram-agent
bun install --frozen-lockfile
bun run pi
```

In Pi:

1. `/login` to a model provider and `/model` to pick the default model (credentials stay in Pi);
2. `/tg config` to run the setup wizard: group ID, token, persona. The daemon becomes ready when it finishes.

Mention your bot in the group to try it.

> Pi's input box does not mask passwords. Do not record or share your screen while pasting the token.

## Everyday use

```bash
bun run start      # start in the background (use systemd for long-running setups; see the runbook)
bun run pi         # open the watch / control UI (/tg attach)
bun run status     # check status
bun run restart    # apply configuration changes
bun run stop       # stop
bun run debug      # read-only diagnostic report
```

Group commands: anyone can use `/help` and `/status`; admins listed in `telegram_admins` also get `/model` (switch models with buttons), `/new` (start a new session), `/compact` (summarize the context) and `/set` (tune how often a bot joins in and its cooldown).

## Documentation

- User guide: [English](docs/user-guide/en/src/README.md) · [中文](docs/user-guide/zh/src/README.md)
- [Configuration](docs/user-guide/en/src/configuration.md) · [Troubleshooting](docs/user-guide/en/src/troubleshooting.md) · [Daemon operations](docs/runbooks/daemon.md)
- Contributing: start with [AGENTS.md](AGENTS.md) and [docs/index.md](docs/index.md)

Licensed under BSD 2-Clause; see [LICENSE](LICENSE).
