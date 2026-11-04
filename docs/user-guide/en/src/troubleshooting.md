# Troubleshooting

Start with the read-only report for archive progress, routing and logs. Use `/status` in the group for live Pi state and usage:

```bash
npm run debug -- --since 30m
```

Do not delete `data/` or pid files "just to try".

## Startup reports configuration errors

Configuration errors identify problem fields and their reasons (values such as tokens are not echoed). Fix `telegram.config.ts` or `.env` and restart; if the model is not ready, fix it with Pi `/login` and `/model`.

## The configuration is valid but the bot is not online

```bash
systemctl --user status telegram-agent
```

Then read the log (`data/daemon.log` under systemd). Typical causes: a wrong token, no network, the bot is not in the group, the model is not in Pi's catalog, or, with `media.mode` set to `"hybrid"`, a model without image input (`image_input_unsupported`).

## The bot ignores a mention

- Check that group privacy is off in BotFather and the bot is in the right group with permission to post.
- Run `npm run debug` and inspect `pending_dispatch`, `claims`, and `pi_runtime_failure` / `response` log events. Use `/status` to check whether Pi is busy, compacting or idle. The report no longer reconstructs separate model-request or pending-reply statistics.
- 401: the token was revoked; fix `.env` and restart.
- 409: another process uses the same token. Make sure only one daemon runs (do not run another `npm run start` next to systemd, and do not start the same token on another machine).

## The bot keeps talking off-topic

Its context may be stuck on a misunderstanding, which summaries then carry forward. An admin can send `/new` in the group to start a new session; it only sees later messages.

## Videos are not understood

`video_transcoder_unavailable` in `npm run debug` means `ffmpeg`/`ffprobe` is missing. Install it and restart; nothing else is affected. Videos above 20 MiB are not processed.

## Search or page reading fails

- Check that the bot has `tools.search: true` and a TinyFish key in `.env`, then restart.
- `invalid_url` means the target is not a public HTTP(S) address (for example localhost, a private IP, or a link with a username and password). This is a deliberate safety limit.

## Work box commands fail

- Startup fails: ensure a top-level `sandbox` section exists. Native read/write/edit/bash do not require codemode.
- Fails while running: on the host, run `DOCKER_HOST=unix:///run/tgbox/docker.sock docker info` to confirm rootless Docker is up and the daemon user is in the `tgbox` group; the image name must match `sandbox.image`. The current image is `tg-box:4` and must include Pi 1.5.0 pi-env. See the [sandbox runbook](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/runbooks/sandbox.md).
- The box is in a mess: an admin sends `/box reset`; it is rebuilt on next use.

## Background tasks never report back

- Startup fails: `tools.tasks` requires `tools.sandbox`, a top-level `tasks` section and `AGENTS.md` in every workflow directory.
- Tasks fail immediately: check the host Pi `/login`, `/model` and work box state. Children share host authentication; they need no separate credential volume or task container.
- No result for a long time: inspect native task state, usage and deadlines with `/task`, then check structured logs. Restarts resume persisted tasks and deadlines; unsafe operations that started but have an unknown outcome are not automatically repeated. An admin can cancel with `/task cancel tN`.

## Compaction fails

Summaries use the current chat model and reasoning effort. Pi does not split oversized summary inputs automatically, and encrypted thinking signatures can make actual usage exceed local estimates. Check the provider and `/status`; if context remains impossible to compact, an admin can use `/new` to cancel old work and start a fresh conversation. Cumulative usage is not cleared.

## Asking for help

Include the output of `systemctl --user status telegram-agent`, `node --version`, `pi --version`, the reviewed end of the log, the failing command and bot id, and your terminal. Never share `.env`, personas, chat content, tokens or API keys.
