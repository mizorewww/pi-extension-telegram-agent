# Why it is cheap

This project does not promise a fixed saving: prices, group activity, persona length and provider caching all vary. Judge the real effect with `/tg status` and the group's `/status`. These are the ways it avoids waste.

1. **No model call when none is needed.** Local code decides whether to respond: mentions, replies and names always get an answer; an ordinary message goes to at most one bot by probability and is skipped if that bot is busy or cooling down. Opening Pi, scrolling history, checking usage and group admin commands never call a model.

2. **Maximum prompt cache reuse.** Each bot's system prompt, persona, sticker catalog and tool descriptions stay byte-for-byte identical; new messages are only appended, never rewriting what was already sent. When the provider supports prompt caching, the repeated part is billed at a lower rate.

3. **Only what is needed per turn.** The full history stays in the local database; each turn sends a bounded batch of new messages (12,000 tokens by default), with direct mentions first. When the context reaches the threshold, a cheap summary model compacts it instead of letting it grow forever.

4. **Media is processed once.** However many bots see an image or video, it is described (vision mode) or prepared (context mode) once and reused. Videos are reduced to 1–3 frames.

5. **Bounded tool output.** A search returns at most five short results and a page at most about 2,000 tokens; links in the group are never opened automatically.

6. **One send ends the turn.** A successful post ends the turn immediately, without an extra request to "confirm"; a bot that was addressed but stayed silent gets at most one nudge.

When evaluating your deployment, compare periods with the same provider, persona and similar activity. Some providers list a price of zero in the model catalog (for example subscriptions); the cost shown then is not your real bill, so check your provider account.
