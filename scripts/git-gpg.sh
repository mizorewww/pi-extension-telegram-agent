#!/bin/bash
# git GPG wrapper: signs commits non-interactively using the passphrase from .env
# Configured repo-locally via: git config gpg.program <this file>
# The passphrase travels on fd 3, never argv, so it is not visible in `ps`.
set -euo pipefail
ENV_FILE="$(git rev-parse --show-toplevel)/.env"
PASS="$(grep -E '^gpg_key_passphrase:' "$ENV_FILE" | head -1 | cut -d: -f2- | sed 's/^ *//;s/ *$//')"
if [ -z "$PASS" ]; then
  echo "error: gpg_key_passphrase missing in $ENV_FILE (needed for signed commits)" >&2
  exit 1
fi
exec gpg --batch --yes --pinentry-mode loopback --passphrase-fd 3 3<<<"$PASS" "$@"
