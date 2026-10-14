#!/usr/bin/env bash
set -euo pipefail
umask 077

stack_dir=/opt/superkalan-traccar
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { echo 'Requires Linux AMD64 VM' >&2; exit 1; }
[[ "$EUID" == 0 ]] || { echo 'Run as root on the target VM' >&2; exit 1; }
[[ "${1:-}" == --install ]] || { echo 'Usage: bash scripts/install-vm.sh --install' >&2; exit 1; }
for dependency in docker python3 openssl gcloud flock systemctl; do
  command -v "$dependency" >/dev/null || { echo "Missing prerequisite: $dependency" >&2; exit 1; }
done
cd "$stack_dir"
[[ -f .env && "$(stat -c %a .env)" == 600 ]] || { echo 'Require root-protected .env (600)' >&2; exit 1; }
[[ -f backup.env ]] || { echo 'Require backup.env with BACKUP_GCS_PREFIX' >&2; exit 1; }
[[ -f certs/traccar-api.crt && -f certs/traccar-api.key && -f certs/ca.crt ]] || {
  echo 'Main bootstrap must install TLS leaf/key/CA under certs/' >&2; exit 1;
}
openssl verify -CAfile certs/ca.crt -verify_ip 10.60.0.10 certs/traccar-api.crt >/dev/null
[[ "$(openssl x509 -in certs/traccar-api.crt -pubkey -noout | openssl sha256)" == \
   "$(openssl pkey -in certs/traccar-api.key -pubout | openssl sha256)" ]] || {
  echo 'TLS certificate/key mismatch' >&2; exit 1;
}
# Main confirms budget alerts before provisioning; do not start after agreed cutoff.
[[ "$(date -u +%s)" -lt "$(date -u -d '2026-12-19 16:00:00 UTC' +%s)" ]] || {
  echo 'Approved 2026-12-20 Asia/Manila cutoff already passed' >&2; exit 1;
}
docker compose --env-file .env -p superkalan-traccar --profile private-api config --quiet
install -d -m 700 backups certs
chmod 600 certs/traccar-api.key backup.env
for unit in systemd/*; do
  [[ -f "$unit" ]] || continue
  install -m 644 "$unit" "/etc/systemd/system/$(basename "$unit")"
done
systemctl daemon-reload
systemctl enable --now superkalan-traccar.service
systemctl enable --now superkalan-traccar-backup.timer superkalan-traccar-cutoff.timer
echo 'Stack and timers installed; run first backup and off-VM restore before release.'
