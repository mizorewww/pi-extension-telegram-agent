#!/usr/bin/env bash
set -euo pipefail
umask 022

version=latest
interactive=1
for argument in "$@"; do
  case "$argument" in
    --non-interactive) interactive=0 ;;
    v*) version=$argument ;;
    *) echo 'Usage: sudo bash install.sh [v1.0.0] [--non-interactive]' >&2; exit 2 ;;
  esac
done
if [[ $version == latest ]]; then
  echo '[0/7] 正在确定最新版本 · ETA 约 5 秒'
  location=$(curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error --output /dev/null --write-out '%{url_effective}' https://github.com/mizorewww/pi-extension-telegram-agent/releases/latest)
  version=${location##*/}
fi
[[ $version =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Release tag must have the form v1.0.0.' >&2; exit 2; }
[[ $(id -u) == 0 && $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'Requires root on Linux x86_64.' >&2; exit 1; }
for command in curl tar xz sha256sum systemctl runuser flock; do
  command -v "$command" >/dev/null || { echo "Missing host prerequisite: $command" >&2; exit 1; }
done
exec 9>/run/pi-telegram-agent-install.lock
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 1; }

app=/opt/pi-telegram-agent
config=/etc/pi-telegram-agent
state=/var/lib/pi-telegram-agent
service_user=pi-telegram-agent
socket=unix:///run/tgbox/docker.sock
release_url="https://github.com/mizorewww/pi-extension-telegram-agent/releases/download/$version"
archive="pi-telegram-agent-$version-linux-x64.tar.gz"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fetch() { curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error --retry 3 "$1" --output "$2"; }

payload=$work/pi-telegram-agent
node_version=24.22.2
node_archive="node-v$node_version-linux-x64.tar.xz"
node_sha=48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75
node=$app/node/bin/node
release=$app/releases/$version
step() {
  local number=$1 title=$2 estimate=$3 started=$SECONDS elapsed remaining pid result=0
  shift 3
  local output=$work/step-$number.log
  "$@" >"$output" 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    elapsed=$((SECONDS - started)); remaining=$((estimate - elapsed))
    if ((remaining > 0)); then
      printf '\r[%s/7] %s · 已用 %ds · ETA 约 %ds    ' "$number" "$title" "$elapsed" "$remaining"
    else
      printf '\r[%s/7] %s · 已用 %ds · 已超过预计，仍在运行    ' "$number" "$title" "$elapsed"
    fi
    sleep 2
  done
  wait "$pid" || result=$?
  printf '\r[%s/7] %s · 用时 %ds · %s\n' "$number" "$title" "$((SECONDS - started))" "$([[ $result == 0 ]] && echo 完成 || echo 需要处理)"
  if ((result)); then tail -n 30 "$output" >&2; return "$result"; fi
}
as_service() {
  runuser -u "$service_user" -- env HOME="$state" TG_CONFIG_DIR="$config" TG_STATE_DIR="$state" \
    PI_CODING_AGENT_DIR="$state/pi-agent" PATH="$app/node/bin:/usr/local/bin:/usr/bin:/bin" "$@"
}
download_release() {
fetch "$release_url/$archive" "$work/$archive"
fetch "$release_url/SHA256SUMS" "$work/SHA256SUMS"
(cd "$work" && sha256sum --check --ignore-missing SHA256SUMS)
tar -xzf "$work/$archive" -C "$work" --no-same-owner
[[ -f $payload/dist/src/daemon/index.js && -f $payload/deploy/telegram-agent.service ]] || { echo 'Invalid release payload.' >&2; exit 1; }

# A private LTS runtime leaves the host's Node installation untouched.
install -d -m 0755 "$app/releases"
if [[ ! -x $app/node-$node_version/bin/node ]]; then
  fetch "https://nodejs.org/dist/v$node_version/$node_archive" "$work/$node_archive"
  (cd "$work" && echo "$node_sha  $node_archive" | sha256sum --check --strict)
  tar -xJf "$work/$node_archive" -C "$work" --no-same-owner
  mv "$work/node-v$node_version-linux-x64" "$app/node-$node_version"
fi
ln -sfn "node-$node_version" "$app/node"

}
step 1 "下载并校验程序与 Node 24" 60 download_release

prepare_host() {
getent group tgbox >/dev/null || groupadd --system tgbox
if ! id "$service_user" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$state" --shell /usr/bin/nologin --user-group "$service_user"
fi
usermod -aG tgbox "$service_user"
install -d -o "$service_user" -g "$service_user" -m 0700 "$config" "$state"
as_service mkdir -p "$config/personas" "$state/pi-agent"
as_service touch "$state/daemon.log"
}
step 2 "配置独立账户与目录" 20 prepare_host

install_release() {
artifact_sha=$(sha256sum "$work/$archive" | cut -d' ' -f1)
if [[ -e $release ]]; then
  [[ $(cat "$release/.artifact-sha256") == "$artifact_sha" ]] || { echo 'A different release already uses this version.' >&2; exit 1; }
else
  mv "$payload" "$release"
  printf '%s\n' "$artifact_sha" > "$release/.artifact-sha256"
  chown -R root:root "$release"
  chmod -R go-w "$release"
fi
}
step 3 "安装版本文件" 5 install_release
if ((interactive)); then
  echo '[4/7] 正在配置应用 · ETA 由输入进度决定'
  as_service "$node" "$release/deploy/configure.mjs" </dev/tty >/dev/tty
else
  echo '[4/7] 使用已保存的应用配置 · 完成'
fi
step 5 "验证配置与 Pi 认证" 15 as_service "$node" "$release/dist/scripts/check-config.js" --models

build_workspace() {
workspace=$(as_service "$node" --input-type=module - "$release/dist/src/config.js" <<'JS'
import { pathToFileURL } from 'node:url';
const { loadConfig } = await import(pathToFileURL(process.argv[2]));
const config = loadConfig();
console.log([config.bot.tools.sandbox, config.sandbox?.dockerHost ?? '', config.sandbox?.image ?? ''].join('\n'));
JS
)
mapfile -t workspace_options <<< "$workspace"
[[ ${workspace_options[0]} == true ]] || { echo 'Using the configured chat tools.'; return 0; }
socket=${workspace_options[1]}
workspace_image=${workspace_options[2]}
command -v docker >/dev/null || { echo 'Install Docker CLI and rootless components to enable workspaces.' >&2; return 1; }
# The Docker owner never owns model credentials or the daemon's files.
if ! id tgbox >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/tgbox --shell /usr/bin/nologin --gid tgbox tgbox
fi
chmod 0700 /var/lib/tgbox
if ! runuser -u tgbox -- docker --host "$socket" info --format '{{json .SecurityOptions}}' 2>/dev/null | grep -q 'name=rootless'; then
  [[ $socket == unix:///run/tgbox/docker.sock ]] || { echo 'The selected Docker endpoint must already provide a rootless daemon accessible to tgbox.' >&2; return 1; }
  for command in dockerd-rootless.sh rootlesskit slirp4netns newuidmap newgidmap; do
    command -v "$command" >/dev/null || { echo "Rootless Docker prerequisite missing: $command" >&2; exit 1; }
  done
  if ! grep -q '^tgbox:' /etc/subuid; then
    start=$(awk -F: 'BEGIN{n=100000} {if($2+$3>n)n=$2+$3} END{print n}' /etc/subuid /etc/subgid)
    usermod --add-subuids "$start-$((start + 65535))" --add-subgids "$start-$((start + 65535))" tgbox
  fi
  install -d -m 0755 /etc/systemd/system/user@.service.d
  printf '[Service]\nDelegate=cpu cpuset io memory pids\n' > /etc/systemd/system/user@.service.d/pi-telegram-agent.conf
  printf 'd /run/tgbox 0750 tgbox tgbox -\n' > /etc/tmpfiles.d/pi-telegram-agent.conf
  systemd-tmpfiles --create /etc/tmpfiles.d/pi-telegram-agent.conf
  install -d -o tgbox -g tgbox -m 0700 /var/lib/tgbox/.config/systemd/user
  cat > /var/lib/tgbox/.config/systemd/user/docker.service <<UNIT
[Unit]
Description=Telegram sandbox rootless Docker
[Service]
Type=simple
ExecStart=$(command -v dockerd-rootless.sh) --host $socket --group 0
Restart=always
RestartSec=3
Delegate=yes
KillMode=mixed
[Install]
WantedBy=default.target
UNIT
  chown tgbox:tgbox /var/lib/tgbox/.config/systemd/user/docker.service
  systemctl daemon-reload
  loginctl enable-linger tgbox
  systemctl start "user@$(id -u tgbox).service"
  systemctl --user -M tgbox@ daemon-reload
  systemctl --user -M tgbox@ enable --now docker
  for ((i=0;i<30;i++)); do
    if runuser -u tgbox -- docker --host "$socket" info --format '{{json .SecurityOptions}}' 2>/dev/null | grep -q 'name=rootless'; then break; fi
    sleep 1
  done
fi
runuser -u tgbox -- docker --host "$socket" info --format '{{json .SecurityOptions}}' | grep -q 'name=rootless'
# Build the release image; custom images are supplied by the operator.
if [[ $workspace_image == tg-box:4 ]]; then
  runuser -u tgbox -- docker --host "$socket" build -t "$workspace_image" "$release/deploy/box"
fi
as_service docker --host "$socket" info --format '{{json .SecurityOptions}}' | grep -q 'name=rootless'
as_service docker --host "$socket" image inspect "$workspace_image" >/dev/null
}
step 6 "准备工作区环境" 120 build_workspace
activate() {
install -o root -g root -m 0644 "$release/deploy/telegram-agent.service" /etc/systemd/system/telegram-agent.service
install -o root -g root -m 0755 "$release/deploy/telegram-agent" /usr/local/bin/telegram-agent
systemctl daemon-reload
systemctl stop telegram-agent.service
if systemctl is-failed --quiet telegram-agent.service; then
  systemctl reset-failed telegram-agent.service
fi
ln -sfn "releases/$version" "$app/current.next"
mv -Tf "$app/current.next" "$app/current"
systemctl daemon-reload
activated_at=$(date +%s)
systemctl enable --now telegram-agent.service
for ((i=0;i<120;i++)); do
  pid=$(systemctl show telegram-agent.service --property MainPID --value)
  if [[ $pid != 0 ]] && "$node" --input-type=module - "$state/daemon.log" "$pid" "$activated_at" <<'JS'
import { readFileSync } from 'node:fs';
try {
 const records=readFileSync(process.argv[2], 'utf8').trim().split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}})
   .filter(r=>r.fields?.pid===Number(process.argv[3])&&Date.parse(r.ts)>=Number(process.argv[4])*1000);
 const ready=records.find(r=>r.component==='daemon'&&r.event==='ready');
 const connected=records.some(r=>r.component==='telegram_poller'&&r.event==='connected');
 process.exit(ready&&connected?0:1);
} catch { process.exit(1); }
JS
  then
    echo "Installed $version; telegram-agent.service is ready (pid $pid)."
    return 0
  fi
  sleep 1
done
echo 'Service did not become ready. Inspect: telegram-agent status; telegram-agent logs' >&2
return 1
}
step 7 "启动服务并确认 Telegram 连接" 60 activate
echo "安装完成：$version。运行 sudo telegram-agent status 查看服务。"
