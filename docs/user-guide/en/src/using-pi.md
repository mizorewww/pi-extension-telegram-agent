# Watch the group in Pi

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
- one `TG …` line in Pi's status bar: cumulative tokens, cache hit rate, cost, the current context share and the model.

The view is for watching only: you cannot speak as a bot from Pi; what a bot says is up to the bot.

## Usage

```text
/tg status             # all bots
/tg status friend      # one bot in detail
```

Shows the state, model and reasoning, current context share, the latest request, tokens kept in the retention window, cache hit rate, cost, routing settings and the latest summary. The numbers match the group's `/status`. "Cumulative" only covers the database retention window (90 days by default); cache numbers marked `≈` are local estimates.

Next: [Daily operations and group commands](operations.md).
