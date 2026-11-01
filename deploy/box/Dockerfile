# Work box image for the bot's sh_exec tool (docs/runbooks/sandbox.md). The container runs with a
# read-only root, so everything the bot needs at runtime is installed here; per-user installs
# (pip --user, npm prefix) land under HOME=/work/.home and vanish with the weekly reset.
FROM debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl wget git jq file procps less nano tree unzip zip xz-utils \
      ripgrep fd-find sqlite3 bc \
      python3 python3-pip python3-venv python3-pil python3-numpy python3-requests \
      ffmpeg imagemagick poppler-utils qrencode \
      fonts-noto-cjk fonts-noto-color-emoji \
      nodejs npm \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1000 --create-home --home-dir /home/box --shell /bin/bash box

ENV PIP_BREAK_SYSTEM_PACKAGES=1 \
    NPM_CONFIG_PREFIX=/work/.home/.npm-global \
    PATH=/work/.home/.local/bin:/work/.home/.npm-global/bin:/usr/local/bin:/usr/bin:/bin \
    LANG=C.UTF-8 \
    TZ=Asia/Singapore

USER box
WORKDIR /work
