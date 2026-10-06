# Troubleshooting

Start with the read-only diagnosis; it shows where things got stuck:

```bash
bun run debug -- --since 30m
```

Do not delete `data/`, pid or socket files "just to try".

## `bun run pi` does not start

```bash
bun install --frozen-lockfile
pi --version
```

If `pi` is not found, install Pi and put it on your PATH first; this project does not install it for you.

## `/tg config` is missing from the menu

Make sure you ran `bun run pi` from the repository root. `/tg config` works without an existing configuration, so its absence usually means the extension was not loaded.

## The wizard rejects the configuration

- Field errors: fix the field named in the message (values such as tokens are not echoed).
- Model not ready: leave the wizard, fix it with Pi `/login` and `/model`, and try again. Nothing has been written yet.

## The configuration is valid but the bot is not online

```text
/tg status-daemon
/tg restart
```

Then read `data/daemon.log`. Typical causes: a wrong token, no network, the bot is not in the group, the model is not in Pi's catalog, or, with `media.mode: "context"`, a model without image input (`image_input_unsupported`).

## The bot ignores a mention

- Check that group privacy is off in BotFather and the bot is in the right group with permission to post.
- Run `bun run debug`: `pending_reply_obligation` means the reply is still owed (it is sent on the next trigger or restart); `route_without_run` means the message was routed but no request ran, so look for `flush_failed` / `provider_attempt_failed` in the log.
- 401: the token was revoked; fix `.env` and restart.
- 409: another process uses the same token. Make sure only one daemon runs (do not combine systemd with `bun run start`, and do not start the same token on another machine).

## The bot keeps talking off-topic

Its context may be stuck on a misunderstanding, which summaries then carry forward. An admin can send `/new` in the group to start a new session; it only sees later messages.

## Images do not show

- Inline images depend on your terminal (Kitty, Ghostty, iTerm2, WezTerm and others); otherwise you see a label such as `[photo]`.
- New images first show a label and appear in place once downloaded. Images above 1 MiB are not shown in the terminal.
- After a context summary, local images no bot needs anymore are cleaned up, so old cards showing only a label is expected; the messages and image descriptions remain.

## Videos are not understood

`video_transcoder_unavailable` in `bun run debug` means `ffmpeg`/`ffprobe` is missing. Install it and restart; nothing else is affected. Videos above 20 MiB are not processed.

## Search or page reading fails

- Check that the bot has `tools.search: true` and a TinyFish key in `.env`, then restart.
- `invalid_url` means the target is not a public HTTP(S) address (for example localhost, a private IP, or a link with a username and password). This is a deliberate safety limit.

## A send outcome is unknown

When a manual send from Pi reports an unknown outcome, the message may already have been posted. Check the group and resend only if it is not there.

## Asking for help

Include the output of `bun run status`, `pi --version`, the reviewed end of the log, the failing command and bot id, and your terminal. Never share `.env`, personas, chat content, tokens or API keys.
