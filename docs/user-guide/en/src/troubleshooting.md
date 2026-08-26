# Troubleshooting

Choose a safe next action from the observable symptom. Do not delete data, PID files, or sockets just to experiment. The [daemon runbook](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/runbooks/daemon.md) owns full recovery procedures.

## `bun run pi` does not start

Run:

```bash
bun install --frozen-lockfile
bun run pi --version
```

The expected version is the project-locked Pi 0.84.1. If installation fails, retain the error and fix registry/network access. Do not hide the problem by switching to an unlocked global Pi.

## `/tg config` is missing

Confirm you started `bun run pi` from the repository root and package discovery loaded `.pi/extensions/tg-extension.ts`. `config` is static and does not depend on an existing deployment. If it is completely absent, inspect Pi/package loading instead of creating an empty config file.

## The wizard refuses configuration

- Field error: correct the fields named in the notification; values are never echoed.
- Existing files: choose validate/editor or explicitly confirm backup-replace. Cancellation preserves bytes.
- Pi model preflight: leave the wizard, use Pi `/login` and `/model`, then retry. No deployment file was written.

## Config is valid but the daemon is not ready

```text
/tg status-daemon
/tg restart
```

Then inspect `data/daemon.log`. Typical causes include an invalid Telegram token, unreachable network, changed Pi login/default-model settings, a model absent from Pi's catalog, a context-mode main model without image input (`image_input_unsupported` — only when `media.mode: "context"`; check capabilities with Pi `/model`), or a bot missing from the target group. Valid files remain, so you do not need to paste the token again.

## `daemon starting` persists

Configured sticker sets may make the first Telegram catalog fetch slower. Vision work occurs only when explicitly enabled, and context-mode media preparation (downloads and frame sampling) runs lazily for real turns; neither is part of the startup path. Run `bun run status` and inspect redacted logs. A live child after the 60-second wait is reported only as starting; readiness requires a real socket connection.

After changing a model, persona, cache policy, tools, or another cache-visible field, a `session ready (new)` line is expected. The context fingerprint deliberately prevents restoring the old session under the new identity; the old file is retained for recovery/audit.

## Telegram 401 or no group messages

- 401: rotate or correct that bot's token, ensure `token_env` selects the right key, then restart.
- Ordinary messages are absent: disable group privacy for that bot in BotFather and confirm it joined the intended supergroup.
- The bot cannot send: inspect group permissions. Do not grant unrelated administrator rights for ordinary reading.

## Telegram 409 / duplicate poller

Another process is long-polling with the same token. Run `bun run restart`; the controller verifies and recovers this deployment's real daemon and orphans. Do not blindly signal the PID-file number or start concurrently.

## Pi feed or compose disconnects

- `no connected Telegram feed`: run `/tg attach [bot]` and wait for the snapshot connection.
- `unknown bot id`: use `/tg ` completion or inspect configured IDs.
- Unknown compose outcome: inspect the group and retry only when absent.
- `/tg detach` and closing Pi do not stop the daemon; attach again later.

## Images do not render inline

A new user- or bot-sent static photo/sticker first shows its media label, then the daemon downloads it in the background and updates the same Pi card. This does not depend on routing or the media pipeline; animated/video media retains a text placeholder in the feed. On startup, legacy absolute cache paths are rebased by filename when the file exists in the current `data/media`; missing entries are cleared before at most 100 recent static display gaps still referenced by current context, an unconsumed event, or a pending reply are backfilled.

After successful compaction, a bounded batch of local media files no longer referenced by any configured bot is removed automatically. An old Pi card falling back to its label is therefore expected and does not mean that the message, vision description, or Telegram file mapping was lost; a future turn can reacquire the source — reusing a persisted vision result or preparing context images again. Restart does not unconditionally download those files again just for historical display.

If new media remains label-only, inspect only the fixed `media_cache_ready/skip/error` category and queue number in redacted logs, then check the 1 MiB limit, static-image format, terminal image capability, and project Pi version. Pi still selects Kitty, iTerm2, or native text fallback. Do not add terminal escapes or bypass Pi components. Record terminal type, tmux state, media kind, fixed outcome, and whether a local path exists—never a token, absolute path, or private image contents.

## A video has no description or stays a text placeholder

Videos (including video stickers, GIF animations, and video notes) reach a model only through sampled frames: 1-3 frames attached to the main model in context mode, or one vision call over at most three frames in vision mode. A persistent placeholder — or, in vision mode, a missing description — therefore means frame sampling or the vision call is unavailable or failed. Run `bun run debug` first. `video_transcoder_unavailable` means the host lacks `ffmpeg` or `ffprobe`; `start`, `restart`, and `status` also explain that the package is used only for frame sampling and suggest installation. The warning never blocks daemon readiness or posts into the group: the video skips before Telegram download or a provider call, so it consumes no provider tokens while chat, static images, and all sticker formats continue. Install the FFmpeg distribution package and restart; this failure is not cached permanently. `video_probe_failed` or `video_frame_extraction_failed` means the local tools could not read the file; check the 20 MiB bound and format support. Logs never contain its path, stderr, or video contents.

## Search or page retrieval fails

- Confirm that the bot has `tools.search: true`, that `.env` contains the key selected by `tinyfish_key_env`, and then perform a controlled restart.
- `invalid_url` means the target is not an allowed public HTTP(S) URL or contains userinfo or a local/private/link-local address. Never disable the guard to access an internal service.
- `*_timeout`, `*_http_*`, `*_response_too_large`, and `fetch_*` are fixed categories. They affect only the current turn; there is no background retry or URL substitution.
- Retain only the fixed category and hostname when diagnosing. Never paste the API key, a signed URL's path/query/fragment, or page contents.

## Still unable to recover

Collect only non-sensitive evidence:

- `bun run status` output;
- `bun run pi --version`;
- a manually reviewed, redacted tail of `data/daemon.log`;
- the failed command, bot ID, and whether the config was newly written or replaced an existing file;
- terminal and tmux details when UI is involved.

Never submit `.env`, real personas, full group messages, tokens, API keys, or unredacted absolute paths.
