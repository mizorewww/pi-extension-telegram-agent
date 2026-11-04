# What it can do

A bot's abilities come in two layers: the basics every bot has, and tools you switch on per bot in the configuration. A bot only knows about the tools it really has, and says so honestly when asked for something it cannot do.

## The basics (enabled by default)

- **Chatting**: a bot always answers when someone mentions it, replies to it or calls it by name; on ordinary messages it joins in now and then by chance, and may also choose to stay quiet in character.
- **Stickers and reactions**: it picks stickers from the sticker sets you configure, or reacts to a message.
- **Following the conversation**: it knows who replied to whom, which line someone quoted, and which messages were edited.
- **Images and videos**: once you set `media.mode` (see [Images and videos](configuration.md#images-and-videos)); by default it only sees placeholders like `[photo]`.

## Optional tools

| Tool | What it adds | Try asking |
|---|---|---|
| `search` | web search and reading one public page, paging through long ones | "@Mochi when does tonight's match start?" · "what does this link say?" |
| `codemode` | JavaScript scripts for exact calculations, calling other tools in bulk and filtering the results, and searching the group's whole message history | "who mentioned hotpot last week?" · "what's the monthly payment on a 12-month loan at 3.2% a year?" |
| `hybrid` media mode | normally reads text descriptions of images, and opens the actual image when that is not enough, including images in older messages | "what's the error in the screenshot in #1234?" |
| `sandbox` | its own Linux work box with native Pi read/write/edit/bash and preinstalled python, node, ffmpeg and imagemagick, for working on files people send; the images and files it makes go straight to the group | "turn page 2 of this PDF into an image" · "chart how many messages we sent each day this week" |
| `tasks` | hands searches and research that take minutes to a background task, and replies to whoever asked when it is done | "compare three entry-level cameras and write it up" |

A few notes:

- Links in the group are never opened automatically; a bot reads one only when it decides to use `search`.
- codemode scripts run in a sandbox with no network or file system; a script can call `send` to post a quick reply and keep working, and running real commands is what the `sandbox` work box is for.
- `image()` shows images to the model; send is still required to post images or files publicly. Background tasks are native Pi child conversations and resume after restarts under tool replay rules.
- The work box is wiped every Monday at 05:00, and an admin can `/box reset` it at any time.
- When a background task starts, the bot first tells you it is on it. Progress, questions for you and the final result are relayed by the bot; the task itself never sees the group.

## About itself

A bot knows it is this open-source project, with its source at <https://github.com/mizorewww/pi-extension-telegram-agent>. Ask "how do you decide when to join in?" and a bot with `sandbox` clones the repository into its box and reads the code before answering; one with `search` reads it on GitHub; with neither, it just gives you the link.

## Group commands

Anyone can use `/help` and `/status`. Switching models, resetting context, tuning how often a bot joins in, wiping the work box and managing background tasks are admin-only; the full list is under [Group commands](operations.md#group-commands).

Next: [Installation and first setup](getting-started.md).
