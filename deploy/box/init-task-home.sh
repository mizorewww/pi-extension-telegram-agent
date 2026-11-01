#!/bin/sh
# Create or refresh the task Pi home volume tg-pihome-<bot> (docs/runbooks/sandbox.md).
# Secrets are read from the host's existing config and streamed straight into the volume;
# nothing is written to disk outside it and nothing is printed.
#   usage: deploy/box/init-task-home.sh <bot_id> [image]
set -eu
BOT="$1"
IMAGE="${2:-tg-box:2}"
: "${DOCKER_HOST:=unix:///run/tgbox/docker.sock}"
export DOCKER_HOST
PROXY_ENV="$HOME/.config/devin-openai-proxy/env"
PI_AUTH="$HOME/.pi/agent/auth.json"

python3 - "$PROXY_ENV" "$PI_AUTH" <<'PY' | docker run --rm -i --user 0 -v "tg-pihome-$BOT:/pi-agent" "$IMAGE" \
  sh -c 'tar -x -C /pi-agent && chown -R 1000:1000 /pi-agent && chmod 700 /pi-agent && chmod 600 /pi-agent/*.json'
import io, json, sys, tarfile
proxy_env, pi_auth = sys.argv[1], sys.argv[2]
key = next(l.split("=", 1)[1].strip() for l in open(proxy_env) if l.startswith("AUTH_KEY="))
ollama = json.load(open(pi_auth)).get("ollama-cloud")
files = {
    "settings.json": {
        "defaultProvider": "devin",
        "defaultModel": "swe-2",
        "defaultThinkingLevel": "high",
        "defaultTools": ["+codemode"],
        "packages": ["/opt/pi-packages/node_modules/pi-subagents", "/opt/pi-packages/node_modules/pi-ollama-cloud"],
    },
    "models.json": {
        "providers": {
            "devin": {
                "baseUrl": "https://devin.mizore.blog/v1",
                "api": "openai-completions",
                "apiKey": key,
                "models": [{
                    "id": "swe-2", "name": "SWE-2", "reasoning": True, "input": ["text", "image"],
                    "contextWindow": 262144, "maxTokens": 32768,
                    "thinkingLevelMap": {"off": None, "minimal": None, "low": None, "medium": "medium",
                                          "high": "high", "xhigh": "max", "max": "max"},
                    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                }],
            }
        }
    },
    "auth.json": {"ollama-cloud": ollama} if ollama else {},
}
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w") as tar:
    for name, value in files.items():
        data = json.dumps(value, indent=2).encode()
        info = tarfile.TarInfo(name); info.size = len(data); info.mode = 0o600
        tar.addfile(info, io.BytesIO(data))
sys.stdout.buffer.write(buf.getvalue())
PY
echo "tg-pihome-$BOT ready"
