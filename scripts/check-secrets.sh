#!/usr/bin/env bash
set -euo pipefail

# Assemble high-signal markers so this scanner does not match its own source.
baidu_marker='bce-v3'"/"
private_key_marker='BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY'
github_token_marker='gh[pousr]_[A-Za-z0-9_]{20,}'
credential_pattern="${baidu_marker}|${private_key_marker}|${github_token_marker}"

if grep -RInE \
  --exclude-dir=.git \
  --exclude-dir=node_modules \
  --exclude-dir=.huangque \
  --exclude=check-secrets.sh \
  "${credential_pattern}" .; then
  printf '%s\n' 'Credential-like material found in release files.' >&2
  exit 1
fi

printf '%s\n' 'Secret scan passed.'
