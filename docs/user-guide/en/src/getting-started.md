# Installation and first setup

## 1. Prepare the machine

You need [Bun](https://bun.sh/) and a local Pi installation (`pi --version` works).

```bash
git clone https://github.com/mizorewww/pi-extension-telegram-agent.git
cd pi-extension-telegram-agent
bun install --frozen-lockfile
bun run pi
```

`bun run pi` starts the Pi on your PATH and loads this project's Telegram extension.

Optional: install `ffmpeg` (which also provides `ffprobe`) so bots can understand videos. Without it, videos show up as a text placeholder and everything else keeps working. Use `brew install ffmpeg` on macOS, `sudo apt install ffmpeg` on Debian/Ubuntu, or `sudo pacman -S ffmpeg` on Arch.

## 2. Prepare Telegram

For each bot:

1. Create the bot with [BotFather](https://t.me/BotFather) and keep the token.
2. Turn off **group privacy** in BotFather; otherwise the bot cannot see ordinary group messages.
3. Add the bot to the target supergroup and make sure it may post.
4. Find the group's numeric ID (`1234567890`, `-1234567890` and `-1001234567890` are all accepted).

A token is the bot's password: never post it in a group, an issue or Git.

## 3. Prepare a model

In Pi:

1. `/login` to your model provider;
2. `/model` to choose the default model.

Model credentials stay in Pi and are never written to this repository. By default the main model does not need image input, because an optional helper vision model describes images. Only if you switch to `media.mode: "context"`, where the main model looks at images directly, must the model support image input.

## 4. Run `/tg config`

The wizard first checks locally that the model is usable (without calling it), then asks for:

1. a Chinese or English persona template;
2. the group ID;
3. the bot's local ID, display name, the name of its token in `.env`, and the BotFather token;
4. a final confirmation.

> Pi's input box does not mask passwords. Make sure you are not recording or sharing your screen when you paste the token.

Pressing Esc at any step leaves no partial configuration. On confirmation it writes three files, all ignored by Git and readable only by you:

| File | Content |
|---|---|
| `.env` | the bot token |
| `telegram.config.ts` | group ID, bot, and the model you just confirmed; everything else uses defaults |
| `personas/<bot-id>.local.md` | the bot's personality, which you can edit any time |

## 5. Wait for ready

The wizard validates the configuration and restarts the daemon. The group view opens only after the daemon reports ready. Mention your bot in the group, or send `/help` to see the group commands.

If it does not become ready (usually a wrong token, no network, or the bot is not in the group), your configuration is kept. Run:

```text
/tg status-daemon
/tg restart
```

If that does not help, check `data/daemon.log` or [Troubleshooting](troubleshooting.md). You do not need to enter the token again.

## Running it again

With an existing configuration, `/tg config` lets you validate it, edit `telegram.config.ts` directly in Pi's editor, back it up and replace it, or cancel. Replacing keeps the old files as `.bak-<random>`.

Next: [Configuration and more bots](configuration.md).
