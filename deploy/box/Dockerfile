# Image for the bot's work box (sh_exec) and its task runs (docs/runbooks/sandbox.md). Both run
# with a read-only root, so runtime tools are installed here; uv environments and user installs
# live under /work (HOME=/work/.home) and vanish with the weekly reset.
# Pi needs Node >= 22.19, hence the Node base rather than plain Debian.
FROM node:24-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446

# uv 0.13.6, pinned to the official multi-platform image digest.
COPY --from=ghcr.io/astral-sh/uv:0.13.6@sha256:af22a52f5eafef3d78e551599d405c02df61919d18028f0cea8eda93bc9986d0 /uv /uvx /usr/local/bin/

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl wget git jq file procps less nano tree unzip zip xz-utils \
      ripgrep fd-find sqlite3 bc \
      python3 python3-pip python3-venv python3-pil python3-numpy python3-requests \
      ffmpeg imagemagick poppler-utils qrencode \
      fontconfig fonts-noto-cjk fonts-noto-color-emoji \
      chromium \
 && rm -rf /var/lib/apt/lists/*

# Task runs: Pi, the packages the search workflow uses, and the CLIs its rules call.
RUN npm install -g --ignore-scripts \
      @earendil-works/pi-coding-agent@1.4.0 \
      @tiny-fish/cli@0.54.0 \
      agent-browser@0.41.0 \
 && chmod +x /usr/local/lib/node_modules/agent-browser/bin/agent-browser-linux-x64 \
 && mkdir -p /opt/pi-packages \
 && cd /opt/pi-packages \
 && npm init -y >/dev/null \
 && npm install --ignore-scripts pi-subagents@0.84.0 pi-ollama-cloud@0.13.1 \
 && npm cache clean --force
COPY task-bridge /opt/tg-task-bridge

RUN userdel --remove node \
 && useradd --uid 1000 --create-home --home-dir /home/box --shell /bin/bash box

ENV PIP_BREAK_SYSTEM_PACKAGES=1 \
    UV_CACHE_DIR=/work/.home/.cache/uv \
    UV_LINK_MODE=copy \
    NPM_CONFIG_PREFIX=/work/.home/.npm-global \
    PATH=/work/.home/.local/bin:/work/.home/.npm-global/bin:/usr/local/bin:/usr/bin:/bin \
    AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium \
    LANG=C.UTF-8 \
    TZ=Asia/Singapore

USER box
WORKDIR /work
