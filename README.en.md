# Pi Telegram Agent

[中文](README.md) · [English](README.en.md)

Give your Telegram group a few AI bots, each with its own personality, that hang out and chat like real members. They run on your own machine on top of the [Pi](https://github.com/earendil-works/pi) agent, and you watch and steer everything from the Pi terminal.

- **They chat**: always answer when mentioned, sometimes join in on their own, send stickers and reactions, and understand images and videos.
- **They get things done** (switched on per bot): search the web and read pages; write scripts for exact calculations or to dig through the chat history; work on files in their own Linux work box and post the images and files they make; hand long research to a background task and reply when it is done.
- **They are cheap to run**: deterministic code decides whether to respond, so no model call is wasted, and prompt prefixes stay unchanged to reuse provider caching.
- **They are simple to set up**: one configuration file; adding a bot means adding one entry.

Things to ask: "@Mochi who mentioned hotpot last week?", "turn page 2 of this PDF into an image", "compare three entry-level cameras and write it up". More in [What it can do](docs/user-guide/en/src/features.md).

## Quick start

You need [Bun](https://bun.sh/), a local [Pi](https://github.com/earendil-works/pi) installation (`pi` on your PATH), a Telegram supergroup, and at least one [BotFather](https://t.me/BotFather) bot with **group privacy turned off**, added to the group.

```bash
git clone https://github.com/mizorewww/pi-extension-telegram-agent.git
cd pi-extension-telegram-agent
bun install --frozen-lockfile
bun run pi
```

In Pi, `/login` to a model provider and `/model` to pick the default model (credentials stay in Pi). Then write the configuration and start:

```bash
cp telegram.config.example.ts telegram.config.ts   # fill in the group ID and bot; every field is commented
cp personas/template.en.md personas/friend.local.md
echo 'telegram_bot_token: <BotFather token>' > .env
bun run start
```

Run `/tg attach` in Pi to watch the group, mention your bot there, or send `/help` to see the group commands. Details: [Installation and first setup](docs/user-guide/en/src/getting-started.md).

## Documentation

- [User guide](docs/user-guide/en/src/README.md) ([online](https://mizorewww.github.io/pi-extension-telegram-agent/en/)): [configuration and features](docs/user-guide/en/src/configuration.md) · [operations and group commands](docs/user-guide/en/src/operations.md) · [troubleshooting](docs/user-guide/en/src/troubleshooting.md)
- Host operations: [daemon and systemd](docs/runbooks/daemon.md) · [bot work boxes (rootless Docker)](docs/runbooks/sandbox.md) (both in Chinese)
- Contributing: start with [AGENTS.md](AGENTS.md) and [docs/index.md](docs/index.md)

Licensed under BSD 2-Clause; see [LICENSE](LICENSE).
