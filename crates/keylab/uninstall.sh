#!/usr/bin/env bash
set -euo pipefail

if (( EUID != 0 )); then
  printf '%s\n' 'keylab uninstallation must run as root.' >&2
  exit 1
fi

if systemctl is-active --quiet keylab.service; then
  systemctl stop keylab.service
fi
if systemctl is-enabled --quiet keylab.service 2>/dev/null; then
  systemctl disable keylab.service
fi

rm -f -- /usr/local/bin/keylab /usr/local/bin/keylabctl /etc/systemd/system/keylab.service
systemctl daemon-reload

printf '%s\n' 'Removed the keylab and keylabctl binaries and the systemd unit.'
printf '%s\n' 'The database was deliberately left alone at /home/sascha/.local/share/glove80-lab/keylab.db'
printf '%s\n' 'Its -wal and -shm files, configuration, and containing data directory were also left untouched.'
printf '%s\n' 'Delete them deliberately only after deciding that the captured data is no longer needed.'
