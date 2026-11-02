# Runbook：bot 工作区（沙箱）

bot 的 `sh_exec` / `tg_download` / `sh_reset` 跑在每个 bot 一个的常驻容器 `tg-box-<bot>` 里，由**独立 Linux 用户 `tgbox` 的 rootless Docker** 托管。设计与威胁模型见 [architecture.md](../architecture.md#沙箱威胁模型)。

## 一次性主机准备（Arch Linux）

```bash
sudo pacman -S --needed rootlesskit slirp4netns fuse-overlayfs
paru -S docker-rootless-extras                 # dockerd-rootless.sh + user units
sudo useradd -m -d /var/lib/tgbox -s /usr/bin/nologin -U tgbox   # useradd 自动分配 subuid/subgid
sudo chmod 700 /var/lib/tgbox
# rootless 的 --memory/--cpus/--pids-limit 需要把 cgroup 控制器委派给用户会话
sudo mkdir -p /etc/systemd/system/user@.service.d
printf "[Service]\nDelegate=cpu cpuset io memory pids\n" | sudo tee /etc/systemd/system/user@.service.d/delegate.conf
echo "d /run/tgbox 0750 tgbox tgbox -" | sudo tee /etc/tmpfiles.d/tgbox.conf
sudo systemd-tmpfiles --create /etc/tmpfiles.d/tgbox.conf
sudo systemctl daemon-reload
sudo loginctl enable-linger tgbox
```

socket 放在 `/run/tgbox/docker.sock`，属组 `tgbox`。namespace 里的 gid 0 才对应宿主机的 `tgbox`，所以用 `--group 0`：

```bash
D=/var/lib/tgbox/.config/systemd/user/docker.service.d
sudo -u tgbox mkdir -p $D
printf "[Service]\nExecStart=\nExecStart=/usr/bin/dockerd-rootless.sh -H unix:///run/tgbox/docker.sock --group 0\n" \
  | sudo -u tgbox tee $D/override.conf
sudo systemctl --user -M tgbox@ daemon-reload
sudo systemctl --user -M tgbox@ enable --now docker.service
sudo usermod -aG tgbox <daemon 用户>            # 然后重启该用户的 user manager 或重新登录
```

- slirp4netns 需要 `tun` 模块。内核升级后没重启时旧内核模块目录已被删除，`modprobe tun` 会失败，日志是 `open: No such device`：重启主机。
- 不要把 daemon 用户加进 `docker` 组：那等于 root，一次 prompt injection 就能拿下主机。

验证：

```bash
DOCKER_HOST=unix:///run/tgbox/docker.sock docker info | grep -i rootless
DOCKER_HOST=unix:///run/tgbox/docker.sock docker run --rm --memory 256m alpine cat /sys/fs/cgroup/memory.max
```

## 镜像

```bash
rsync -a deploy/box/ <host>:/tmp/tgbox-build/
DOCKER_HOST=unix:///run/tgbox/docker.sock docker build -t tg-box:3 /tmp/tgbox-build
```

改了 Dockerfile 就换新 tag（例如 `tg-box:4`），改 `telegram.config.ts` 的 `sandbox.image` 后 `/box reset` 或等每周清空，旧容器才会用新镜像重建。

镜像包含固定版本 uv/uvx、fontconfig、Noto Sans CJK 和彩色 emoji。Python 依赖优先用 uv：

```bash
uv venv --system-site-packages /work/.venv
uv pip install --python /work/.venv/bin/python matplotlib
/work/.venv/bin/python script.py
# 项目在自己的目录下用 uv add / uv run；独立 Python CLI 用 uvx。
fc-match "Noto Sans CJK SC"
```

`--system-site-packages` 复用镜像里的 Pillow/numpy/requests；每次 shell 独立，使用虚拟环境 Python 的绝对路径。uv cache 在 `/work/.home/.cache/uv`，与环境一起随每周清空删除；`UV_LINK_MODE=copy` 允许任务目录与 cache 跨挂载点。大型下载、解压和媒体中间文件放 `/work`，工作容器的 `/tmp` 只有 256 MiB。

升级镜像但保留工作文件：先停止 daemon，确认没有运行中的后台任务，再删除 **容器本身**（不删 `tg-work-*` 卷），更新配置并重启；下次工具调用按新配置重建。`/box reset` 会删工作卷，不适合保留数据的升级。

### 所有 bot 容器的总资源上限

`sandbox.memory/cpus` 只限制单个工作容器，后台任务各有独立配额。要让专用 `tgbox` 用户下的全部容器合计最多 4 核 / 8 GiB，使用持久化 systemd slice 上限（包含 rootless Docker 自身的小额开销）：

```bash
sudo systemctl set-property user-$(id -u tgbox).slice CPUQuota=400% MemoryMax=8G MemorySwapMax=0
systemctl show user-$(id -u tgbox).slice -p CPUQuotaPerSecUSec -p MemoryMax -p MemorySwapMax
```

这是主机运维限制，不是第二份 bot 业务配置。`400%` 是最多四核的累计 CPU 时间，不绑核、不预留；8 GiB 是硬上限，触顶可能 OOM，不是每个容器都能同时拿到 8 GiB。后台任务可保留每个 2 核 / 3 GiB、最多两个并发，共享同一总预算。daemon 在另一个用户下，不受此 slice 限制。

### 任务凭证卷

任务容器把 `tg-pihome-<bot>` 挂成 Pi 的 agent 目录。脚本把任务用的 OpenAI 兼容模型（provider 名为 `devin`，工作流里写 `devin/<model>`）和主机 `~/.pi/agent/auth.json` 里的 ollama-cloud key 直接流进卷里，不落盘、不打印：

```bash
TASK_LLM_BASE_URL=https://<你的代理>/v1 TASK_LLM_KEY_FILE=<key 文件> [TASK_LLM_MODEL=swe-2] [TASK_LLM_THINKING=medium] \
  deploy/box/init-task-home.sh <bot_id> tg-box:3
```

任务主会话默认用模型支持的最低思考强度（swe-2 是 medium）；工作流里的 subagent 可以自己指定更强的模型。key 文件里放裸 key，或一行名字以 KEY 结尾的 `NAME=value`（例如 `AUTH_KEY=…`）。不要把 Devin CLI 的 OAuth 凭证复制进任务卷：两份 refresh token 各自刷新可能互相作废，把主 bot 的认证一起弄掉；用一个 OpenAI 兼容代理（例如自建的 devin-openai-proxy）提供模型。

换 key 或改模型设置后重跑即可。工作流目录要在主机上（例如 `rsync -a ~/pi-tasks/ <host>:pi-tasks/`）。

## 配置

```ts
sandbox: { image: "tg-box:3", docker_host: "unix:///run/tgbox/docker.sock", memory: "8g", cpus: 4, pids: 256, network: true },
bots: [{ ..., tools: { codemode: true, sandbox: true } }],
```

`tools.sandbox` 需要 `tools.codemode`（这些工具只能从脚本调用）和顶层 `sandbox` 段。

后台任务：

```ts
tasks: { workflows: { search: "~/pi-tasks/search" }, max_running: 2, timeout_minutes: 45, memory: "3g", cpus: 2 },
bots: [{ ..., tools: { codemode: true, sandbox: true, tasks: true } }],
```

## 日常

| 操作 | 方式 |
|---|---|
| 清空某个 bot 的工作区 | 群里管理员 `/box reset`（多 bot 时 `/box reset@bot_username`），或 bot 自己调 `sh_reset` |
| 每周清空 | 每周一 05:00（进程本地时间）后的第一次检查（10 分钟一次）；上次清空时间存在 `daemon_state` 的 `box_reset_at:<bot>`，重启不重复清 |
| 查看容器 | `DOCKER_HOST=unix:///run/tgbox/docker.sock docker ps --filter label=tg-box` |
| 查看任务 | `docker ps --filter label=tg-task`；数据库 `SELECT * FROM tasks ORDER BY created_at DESC` |
| 手动删除 | `docker rm -f tg-box-<bot> && docker volume rm tg-work-<bot>`（下次调用自动重建） |
