#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/../.." && pwd)
service_user=sascha
invoking_user=${SUDO_USER:-${USER:?USER is not set}}

note_input_member() {
  local account=$1
  local groups

  groups=$(id -nG "$account")
  if [[ " $groups " == *" input "* ]]; then
    printf "NOTE: account %s is in the input group; every process running as that account can read all input devices. SupplementaryGroups=input on keylab.service keeps keylab's own access scoped.\n" "$account"
  fi
}

note_input_member "$invoking_user"
if [[ "$service_user" != "$invoking_user" ]]; then
  note_input_member "$service_user"
fi

if (( EUID != 0 )); then
  printf '%s\n' 'keylab installation must run as root so files can be installed with root ownership.' >&2
  exit 1
fi

service_home=$(getent passwd "$service_user" | cut -d: -f6)
if [[ "$service_home" != /home/sascha ]]; then
  printf 'Refusing to install: %s has home %s, but keylab.service is confined to /home/sascha.\n' "$service_user" "$service_home" >&2
  exit 1
fi

(cd -- "$repo_root" && cargo build --release --locked)

install -D -m 0755 -o root -g root \
  "$repo_root/target/release/keylab" /usr/local/bin/keylab
install -D -m 0755 -o root -g root \
  "$repo_root/target/release/keylabctl" /usr/local/bin/keylabctl
install -D -m 0644 -o root -g root \
  "$script_dir/keylab.service" /etc/systemd/system/keylab.service

install -d -m 0700 -o "$service_user" -g "$service_user" \
  "$service_home/.local/share/glove80-lab"
install -d -m 0700 -o "$service_user" -g "$service_user" \
  "$service_home/.config/glove80-lab"

config_path="$service_home/.config/glove80-lab/keylab.toml"
if [[ -e "$config_path" || -L "$config_path" ]]; then
  printf 'Preserving existing configuration: %s\n' "$config_path"
else
  install -m 0600 -o "$service_user" -g "$service_user" \
    "$script_dir/keylab.example.toml" "$config_path"
  printf 'Installed example configuration: %s\n' "$config_path"
fi

systemctl daemon-reload

printf '%s\n' 'Installed keylab and keylabctl. Review the configuration, then run these commands deliberately:'
printf '%s\n' '  systemctl enable keylab.service'
printf '%s\n' '  systemctl start keylab.service'
