# Pi Telegram Agent user guide

[中文指南](https://mizorewww.github.io/pi-extension-telegram-agent/zh/) · [Back to the project README](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/README.en.md)

Put one or more AI bots, each with its own personality, into your Telegram group. They run on your machine: they answer when mentioned, sometimes join in on their own, send stickers and reactions, and understand images and videos. Switch on the extras and they can also look things up on the web, write scripts to crunch numbers or dig through the chat history, work on files in their own Linux work box and post the results, or hand long research to a background task. You check status and steer everything right in the Telegram group.

## Shortest path

1. Create a bot with BotFather, turn off group privacy, and add it to your supergroup.
2. Run `pi` and pick a model with Pi's `/login` and `/model`.
3. Copy `telegram.config.example.ts` to `telegram.config.ts`, fill in the group ID and the bot, and put the token in `.env`; start with `npm start`, then mention the bot in the group or send `/status`.

## Chapters

- [What it can do](features.md)
- [Installation and first setup](getting-started.md)
- [Configuration and more bots](configuration.md)
- [Daily operations and group commands](operations.md)
- [Troubleshooting](troubleshooting.md)
- [Design and philosophy](design.md)

## Boundaries worth knowing

- Conversation and control happen in Telegram; Pi provides the model credentials and SDK runtime.
- One deployment serves one group. For a second group, use a separate clone.
- `telegram.config.ts` is code that gets executed on your machine; only put your own content in it.
