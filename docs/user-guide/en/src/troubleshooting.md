# Troubleshooting

Start with the read-only report; compare recent requests, pending replies and logs:

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
- Run `npm run debug`: `context.pending_reply_obligations > 0` means replies are still owed (retried on the next trigger or restart). Compare `claims` and `runs`, then look for `flush_failed` / `provider_attempt_failed` in the log.
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

- Startup fails: `tools.sandbox` also needs `tools.codemode` and a top-level `sandbox` section.
- Fails while running: on the host, run `DOCKER_HOST=unix:///run/tgbox/docker.sock docker info` to confirm rootless Docker is up and the daemon user is in the `tgbox` group; the image name must match `sandbox.image`. See the [sandbox runbook](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/runbooks/sandbox.md).
- The box is in a mess: an admin sends `/box reset`; it is rebuilt on next use.

## Background tasks never report back

- Startup fails: `tools.tasks` needs `tools.sandbox` and a top-level `tasks` section, and every directory in `tasks.workflows` must contain `.pi`.
- Tasks fail right away: usually Pi inside the task container has no model credentials; prepare the credentials volume as described in the [sandbox runbook](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/runbooks/sandbox.md#任务凭证卷).
- No result for a long time: a task past `tasks.timeout_minutes` fails and the requester is told; on the host, `docker ps --filter label=tg-task` (with the `DOCKER_HOST` above) lists running tasks. A daemon restart interrupts running tasks.

## Asking for help

Include the output of `systemctl --user status telegram-agent`, `pi --version`, the reviewed end of the log, the failing command and bot id, and your terminal. Never share `.env`, personas, chat content, tokens or API keys.
