# Chat and observe in Pi

## Open the feed

The daemon stays online independently. Open or close Pi whenever needed:

```bash
bun run pi
```

Successful first setup attaches the global feed automatically. Later, choose the scope explicitly:

```text
/tg attach             # Group messages + every bot's LOCAL events
/tg attach friend      # Group messages + friend LOCAL/usage only
/tg more               # Load one older history page
/tg detach             # Disconnect live IPC but retain the transcript
```

The Telegram feed is one TUI-only Pi custom entry. Pi owns scrolling, resizing, selection, themes, and image layout. One line above the editor groups the feed scope, connection state, and compose guidance. While attached, the extension uses Pi's official footer API for the path and Telegram usage/model rows, while hiding the unrelated operator-usage row. Displaying messages does not put them into the current Pi agent's provider context.

Use Tab or Pi's selection menu after `/tg `. Bot arguments come from the currently validated config.

## Send directly

After attach, the Pi editor sends to Telegram by default. A filtered feed uses that bot directly. A global feed opens Pi's native selector for every submission when several bots exist, and bypasses it when only one exists.

```text
/tg attach friend       # Send directly as friend
/tg attach              # Choose an identity for each message when needed
/tg compose friend      # Optional: pin friend for consecutive messages
/tg compose off         # Temporarily return the editor to Pi
/tg compose             # Restore the current feed scope
```

The attached-feed header shows either `send as ...` or `choose bot on send` immediately after `attached`; choosing and sending update there in place. Canceling the selector restores the exact editor text and sends nothing. Compose intercepts only interactive editor input; RPC and extension sources continue to Pi. Attachments are blocked instead of silently sending only their caption.

An explicit failure restores the editor text. If the acknowledgement is lost or the connection drops during send, the outcome is unknown:

1. compose closes automatically;
2. the extension does not retry;
3. inspect the Telegram group;
4. send again only when the message is absent.

This boundary prevents a remote success plus local acknowledgement failure from creating duplicate messages.

## Status

```text
/tg status             # Global Telegram telemetry
/tg status friend      # Lifetime + latest details
```

Pi `/tg status` and Telegram `/status` share the [unified telemetry semantics](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/telemetry.md): lifetime covers retained SQLite `llm_runs`, including compaction calls, while detailed status takes live `used/window/percent` from the corresponding Pi session rather than the latest run or a historical prompt sum. The attached footer keeps its previous latest-run semantics and Pi-native path and usage/model rows, while compose guidance stays in the feed header; `/tg detach` restores Pi's default footer.

## Local events, streams, and media

- Assistant thinking/text/tool partials update one Pi-native card in place. Persistent LOCAL/Telegram events replace them at completion; partials are not stored in SQLite.
- Local assistant text when a bot does not call `send` remains feed-only and never reaches the group.
- `media.mode` selects the media pipeline. In the default `"vision"` mode, photo, sticker, and video vision runs lazily only when a real bot turn needs media context and `vision.enabled` is true; a video contributes at most three fixed representative frames, all interpreted in one vision call. In the opt-in `"context"` mode the main model sees context images directly with no vision model and no description text — descriptions persisted earlier never enter the context either: photos and static stickers are attached as images, and videos (including video stickers, GIF animations, and video notes) are sampled into 1-3 representative frames. Media beyond `media.max_images_per_turn` or the context budget degrades to text placeholders. Opening the UI never adds a provider call.
- In vision mode, a vision description belongs to the shared group message, so global and every one-bot feed render it directly below the media as a `Vision` line. A one-bot filter limits only LOCAL events and usage.
- Voice, audio, non-video documents, and TGS animated stickers are always text placeholders — a limit of the current model API, which accepts image content blocks only. User- and bot-sent static photos/stickers share the local inline display path. Videos, animations, video notes, video documents, and video stickers retain a media placeholder in the feed even when the model receives sampled frames or a vision description. Inline visibility still follows Pi terminal capabilities; text, media labels, and vision descriptions remain readable fallbacks.

## Web search and link reading

After enabling `tools.search` for a bot and configuring a TinyFish key, the agent can use one tool on demand: a query returns at most five compact results, while a URL reads one public HTTP(S) page. Group links are never fetched eagerly; retrieval happens only when the answer needs page contents.

Page text has an 8,000-character local guard and a 2,048-token provider-output cap, then is enclosed in a fixed untrusted-content boundary. Instructions in a page do not become agent instructions. Authenticated URLs, localhost, and private or link-local targets are rejected before the request. Events and logs retain only hostname, character count, and fixed outcome categories—not the URL path/query/fragment or page body.

## Daemon commands in Pi

```text
/tg start
/tg restart
/tg stop
/tg status-daemon
```

`/tg restart` closes compose and old IPC, then replaces the whole deployment through controlled process management. A ready result restores the feed; failure retains the transcript and gives a diagnostic.

Next: [Daily operations](operations.md).
