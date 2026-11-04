# Installation and first setup

## 1. Prepare the machine

You need [Node.js 24+](https://nodejs.org/) and a local Pi installation (`pi --version` works).

```bash
git clone https://github.com/mizorewww/pi-extension-telegram-agent.git
cd pi-extension-telegram-agent
npm ci
npm run build
```

Optional: install `ffmpeg` (which also provides `ffprobe`) so bots that look at media can understand videos. Without it, videos show up as a text placeholder and everything else keeps working. Use `brew install ffmpeg` on macOS, `sudo apt install ffmpeg` on Debian/Ubuntu, or `sudo pacman -S ffmpeg` on Arch.

The daemon and tests use Node only. Repository Pi dependencies are pinned exactly to 1.5.0; install them with `npm ci`.

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

Model credentials stay in Pi and are never written to this repository. Choose an authenticated chat model with a sufficient context window. The default configuration does not look at images; if you later set `media.mode` to `"hybrid"`, the main model must accept image input.

## 4. Write the configuration

```bash
cp telegram.config.example.ts telegram.config.ts
cp personas/template.en.md personas/friend.local.md
```

1. Create `.env` with the bot token (`key: value` with a colon, not `KEY=value`):

   ```text
   telegram_bot_token: 123456789:AA...
   ```

2. Edit `telegram.config.ts`: fill in `group_peer_id`; delete the `provider` and `model` lines to use your Pi `/model` choice; set the bot's `name` to what the group calls it and `persona_path` to `personas/friend.local.md`. Every field is commented, and misspelled or unknown fields are rejected at startup.
3. Write the bot's personality in `personas/friend.local.md`.

All three files are ignored by Git and stay on your machine.

## 5. Start

```bash
npm start
```

The daemon runs in the foreground; Ctrl-C stops it. For long-running use, hand it to systemd as described in [Daily operations](operations.md#start-and-stop). Once the output shows `"ready"`, mention your bot in the group or send `/help` and `/status` to see the group commands and usage.

If it does not start, the terminal says why; typical causes are a wrong token, no network, the bot not being in the group, or a model missing from Pi's catalog. See [Troubleshooting](troubleshooting.md).

Manual edits to `telegram.config.ts` require a daemon restart. Group commands `/set` and `/model` apply immediately and write back to the same file. After updating the repository, run `npm ci && npm run build` before restarting.

Next: [Configuration and more bots](configuration.md).
