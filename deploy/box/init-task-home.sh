#!/bin/sh
# Create or refresh the task Pi home volume tg-pihome-<bot> (docs/runbooks/sandbox.md).
# Secrets are read from files on the host and streamed straight into the volume; nothing is
# written to disk outside it and nothing is printed.
#   usage: TASK_LLM_BASE_URL=https://host/v1 TASK_LLM_KEY_FILE=path [TASK_LLM_MODEL=swe-2] [TASK_LLM_THINKING=medium] \
#          deploy/box/init-task-home.sh <bot_id> [image]
# The key file holds the bare key or a *KEY=value line (e.g. AUTH_KEY=...). The provider is named
# "devin" so workflows can say devin/<model>; ollama-cloud is copied from ~/.pi/agent/auth.json.
set -eu
BOT="$1"
IMAGE="${2:-tg-box:2}"
: "${DOCKER_HOST:=unix:///run/tgbox/docker.sock}"
export DOCKER_HOST
: "${TASK_LLM_BASE_URL:?set TASK_LLM_BASE_URL to the OpenAI-compatible base URL}"
: "${TASK_LLM_KEY_FILE:?set TASK_LLM_KEY_FILE to a file holding the API key}"
PI_AUTH="$HOME/.pi/agent/auth.json"

python3 - "$TASK_LLM_BASE_URL" "$TASK_LLM_KEY_FILE" "${TASK_LLM_MODEL:-swe-2}" "$PI_AUTH" "${TASK_LLM_THINKING:-medium}" <<'PY' | docker run --rm -i --user 0 -v "tg-pihome-$BOT:/pi-agent" "$IMAGE" \
  sh -c 'tar -x -C /pi-agent && chown -R 1000:1000 /pi-agent && chmod 700 /pi-agent && chmod 600 /pi-agent/*.json'
import io, json, sys, tarfile
base_url, key_file, model, pi_auth, thinking = sys.argv[1:6]
lines = [l.strip() for l in open(key_file) if l.strip() and not l.startswith("#")]
named = [l.split("=", 1)[1].strip() for l in lines if "=" in l and l.split("=", 1)[0].endswith("KEY")]
key = named[0] if named else lines[0]
try:
    ollama = json.load(open(pi_auth)).get("ollama-cloud")
except FileNotFoundError:
    ollama = None
files = {
    "settings.json": {
        "defaultProvider": "devin",
        "defaultModel": model,
        # The task's main session runs at the lowest level the model supports (swe-2: medium);
        # workflows can still pick a stronger model per subagent.
        "defaultThinkingLevel": thinking,
        "defaultTools": ["+codemode"],
        "packages": ["/opt/pi-packages/node_modules/pi-subagents", "/opt/pi-packages/node_modules/pi-ollama-cloud"],
    },
    "models.json": {
        "providers": {
            "devin": {
                "baseUrl": base_url,
                "api": "openai-completions",
                "apiKey": key,
                "models": [{
                    "id": model, "name": model, "reasoning": True, "input": ["text", "image"],
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
