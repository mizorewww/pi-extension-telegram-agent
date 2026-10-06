# Chat and observe in Pi

## Open the group view

The daemon keeps running in the background; open and close Pi whenever you like:

```bash
bun run pi
```

```text
/tg attach             # group messages + local events of every bot
/tg attach friend      # group messages + only friend's local events and usage
/tg more               # load one older page of history
/tg detach             # stop live updates; what is shown stays
```

Press Tab after `/tg ` to complete subcommands and bots. The group view is local only and never enters the model context of your own Pi session.

In the view you see:

- group messages (images and stickers render inline on terminals that support images);
- each bot's thinking, tool calls and send results (marked as local events; the group cannot see them);
- text a bot wrote without calling send, which stays on your machine and is never posted;
- a footer with Telegram's cumulative usage, the current context share and the model.

## Speak as a bot

After attaching, Pi's input box sends to Telegram by default:

```text
/tg attach friend       # speak as friend
/tg attach              # with several bots, choose who speaks on each send
/tg compose friend      # keep speaking as friend
/tg compose off         # give the input box back to Pi for now
/tg compose             # choose by the current view again
```

The line above the input box shows `send as ...` or `choose bot on send`. Only plain text is supported; attachments are refused and your text is kept.

If the connection drops or no confirmation arrives while sending, the outcome is **unknown**: your text is restored, compose closes, and nothing is retried automatically. Check the group first and resend only if the message is not there, to avoid duplicates.

## Usage

```text
/tg status             # all bots
/tg status friend      # one bot in detail
```

Shows the state, model and reasoning, current context share, the latest request, tokens kept in the retention window, cache hit rate, cost, routing settings and the latest summary. The numbers match the group's `/status`. "Cumulative" only covers the database retention window (90 days by default); cache numbers marked `≈` are local estimates.

## Manage the daemon from Pi

```text
/tg start
/tg restart             # restart every bot, then reconnect the current view
/tg stop
/tg status-daemon
/tg config              # setup wizard
```

Next: [Daily operations and group commands](operations.md).
