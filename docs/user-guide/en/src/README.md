# Pi Telegram Agent user guide

[中文指南](https://mizorewww.github.io/pi-extension-telegram-agent/zh/) · [Back to the project README](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/README.en.md)

Put one or more AI bots, each with its own personality, into your Telegram group. They run on your machine, answer when mentioned, sometimes join the conversation on their own, send stickers, and understand images and videos. You watch the group, speak as a bot and check usage from the Pi terminal on your machine.

## Shortest path

1. Create a bot with BotFather, turn off group privacy, and add it to your supergroup.
2. Run `bun run pi` in the repository and pick a model with Pi's `/login` and `/model`.
3. Run `/tg config` in Pi and follow the prompts; the group view opens when it finishes.

## Chapters

- [Installation and first setup](getting-started.md)
- [Configuration and more bots](configuration.md)
- [Chat and observe in Pi](using-pi.md)
- [Daily operations and group commands](operations.md)
- [Troubleshooting](troubleshooting.md)
- [Why it is cheap](design-cost.md)

## Boundaries worth knowing

- Closing Pi does not stop the bots. The conversation happens in Telegram; Pi is only a local window onto it.
- One deployment serves one group. For a second group, use a separate clone.
- `telegram.config.ts` is code that gets executed on your machine; only put your own content in it.
