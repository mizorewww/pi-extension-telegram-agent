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
scp deploy/box/Dockerfile <host>:/tmp/tgbox-build/
DOCKER_HOST=unix:///run/tgbox/docker.sock docker build -t tg-box:1 /tmp/tgbox-build
```

改了 Dockerfile 就换新 tag（`tg-box:2`），改 `telegram.config.ts` 的 `sandbox.image` 后 `/box reset` 或等每周清空，旧容器才会用新镜像重建。

## 配置

```ts
sandbox: { image: "tg-box:1", docker_host: "unix:///run/tgbox/docker.sock", memory: "1g", cpus: 2, pids: 256, network: true },
bots: [{ ..., tools: { codemode: true, sandbox: true } }],
```

`tools.sandbox` 需要 `tools.codemode`（这些工具只能从脚本调用）和顶层 `sandbox` 段。

## 日常

| 操作 | 方式 |
|---|---|
| 清空某个 bot 的工作区 | 群里管理员 `/box reset`（多 bot 时 `/box reset@bot_username`），或 bot 自己调 `sh_reset` |
| 每周清空 | 每周一 05:00（进程本地时间）后的第一次检查（10 分钟一次）；上次清空时间存在 `daemon_state` 的 `box_reset_at:<bot>`，重启不重复清 |
| 查看容器 | `DOCKER_HOST=unix:///run/tgbox/docker.sock docker ps --filter label=tg-box` |
| 手动删除 | `docker rm -f tg-box-<bot> && docker volume rm tg-work-<bot>`（下次调用自动重建） |
