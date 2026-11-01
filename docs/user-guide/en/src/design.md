# Design and philosophy

This chapter explains why the bot is built the way it is. It is not a help desk or "an API that chats"; it is a member of the group: it has a personality, it can stay quiet, it always answers when addressed, and it can roll up its sleeves when needed. Each principle below matches a real trade-off in the code.

## 1. Code decides when to speak; the model decides what to say

Whether a model is called at all is decided by local, deterministic code: mentions, replies and names always trigger; an ordinary message goes to at most one bot by probability, and is skipped — not handed to another bot — if that bot is busy or cooling down. Bots see each other but do not trigger each other by default.

Being addressed creates a durable **reply obligation** that is only settled once the bot actually posts in the group. Provider errors, daemon restarts and compaction never drop it; a bot that stays silent gets at most one nudge. Conversely, when the outcome of a Telegram send is unknown it is **never retried**: an occasional missed line is better than spam.

## 2. Three worlds, kept apart

1. **The Telegram group** is only the transport; it is not used to restore history.
2. **SQLite** is the source of truth: every message, edit, media description and background result seen since start is recorded as append-only events.
3. **Pi / the LLM** sees a bounded, condensed context only when it needs to think.

The model's context is projected from the database, not pulled live from Telegram. That is why a restart picks up the conversation, and why old messages are looked up with `tg_messages` instead of stuffing the whole group into the prompt.

## 3. Minimal: one design, no compatibility layers

- Configuration has one source: `telegram.config.ts`, plus Pi's own settings and the secrets in `.env`.
- Design changes land in one step, without keeping old fields, old modes or migration ladders. There is one production deployment; an old database simply fails to open, which is less error-prone than maintaining migrations.
- Deleting code beats adding abstractions; defensive code only guards branches that can really happen.

## 4. Pi-native first

Everything Pi can do is left to Pi: sessions and persistence, retries, compaction hooks, the steering queue, the model catalog and auth, image resizing, the codemode sandbox (background jobs reuse Pi's `CodemodeSandbox` directly) and the TUI components.

What is hand-written is only what Pi lacks, or where Pi's version does not fit a cache-sensitive, multi-bot, sandboxed daemon:

| Hand-written | Why not Pi's |
|---|---|
| Summarizer | Pi's uses a fixed English template, cannot take images and keeps thinking; kept speculation once turned a misreading into a "fact" inherited summary after summary |
| Provider watchdog | Pi's `timeoutMs` only works for SDKs that support it; it is not a deadline for the whole stream |
| Session trimming | Pi has no public trimming API |
| RPC framing for tasks | Pi's `RpcClient` hardcodes a `node` child process and cannot run `docker run` |
| Daemon ↔ TUI IPC | Pi RPC is one session per process; this daemon serves several bots at once |

Some Pi features are deliberately unused: switching tool sets mid-session, `context_edit` and in-session model changes all rewrite a prefix that was already sent and break the cache; skills and prompt templates add bytes to the system prompt, so they are off.

## 5. Don't pay for nothing

Never spend tokens on what deterministic code can do; estimate cache hit rate and new tokens per turn before adding a feature.

1. **No model call when none is needed.** Routing, history browsing, usage and group admin commands never reach a model.
2. **Strict prefixes.** The system prompt, persona, sticker catalog and tool descriptions stay byte-for-byte identical; new content is only appended, so every request is a strict prefix of the next. Measured: follow-up requests within a turn miss only about 780 tokens on average, while rewriting the prefix costs over ten thousand extra tokens even less than 30 seconds later.
3. **Only what each turn needs.** Full history lives in the local database; each turn sends a bounded batch of new messages (12,000 tokens by default), direct mentions first; near the threshold a cheap summary model compacts it.
4. **Media is processed once.** However many bots see an image, it is described once and reused; videos are reduced to 1–3 frames. The model normally reads text descriptions and opens the original with `view_image` only when it wants a closer look.
5. **Bounded tool output.** A search returns at most five short results, a web page is read one page at a time, and a script hands the model only its filtered result.
6. **Posting ends the turn.** A successful direct `send` ends the turn at once, without an extra request to "confirm".

Some providers list a price of zero (subscriptions); the cost shown then is not your bill, so check your provider account.

## 6. Give abilities and examples, not rules

- A bot is only told about the tools it really has, and says plainly when it cannot do something.
- The persona describes personality and style only; how to use each tool is written under that tool, with plenty of copyable examples, all of which have been run against the real tools.
- Limits exist only where there is real risk. Caps and windows added to make the bot "hold back" only made it refuse reasonable requests in practice, and have all been removed; the remaining caps only stop runaway loops and are not mentioned in the prompt.
- Exploration is encouraged: the bot knows its own source repository and reads the code when asked how it works.

## 7. Safety comes from mechanisms, not prompts

Prompts can be talked around, so the boundaries are mechanical:

- **codemode scripts** run in Pi's QuickJS VM with no network, file system or host APIs, and can only call the tools opened to scripts.
- **The work box** is a per-bot rootless Docker container under its own system user: no host mounts, all capabilities dropped, a read-only root file system and a single `/work` volume, wiped every Monday and on demand with `/box reset`. It holds no credentials.
- **search** only reaches public HTTP(S); private, loopback and cloud-metadata addresses are refused.
- **Group commands that change state** are for human admins only, and command messages never enter the model's context.

The few tests left in `test/` guard exactly these boundaries and the cache invariant.

## 8. Think first, then write

No TDD. First think the design through — which layer owns it, whether it rewrites a cached prefix, whether Pi already has it — then write the code. Correctness comes from type checking, real runs on the server, and an e2e run of the prompt's examples against the real tools, not from piles of unit tests that pin implementation details.

## Things it deliberately does not do

- It does not post Telegram Rich Messages: outdated clients cannot see them, and the Bot API reports no error.
- It does not open links in the group automatically; it reads one only when it decides to use `search`.
- One deployment serves one group; more groups use separate clones, with no second namespace.
- It never resends when the outcome of a send is unknown.
