#!/usr/bin/env bash
set -euo pipefail
umask 077

# The systemd EnvironmentFile supplies only this nonsensitive bucket URI.
: "${BACKUP_GCS_PREFIX:?Set BACKUP_GCS_PREFIX in /opt/superkalan-traccar/backup.env}"
[[ "$BACKUP_GCS_PREFIX" == gs://* ]] || { echo 'Expected a GCS bucket/prefix' >&2; exit 1; }
stack_dir=/opt/superkalan-traccar
command -v gcloud >/dev/null
command -v flock >/dev/null
exec flock -n /run/lock/superkalan-traccar-backup.lock \
  python3 "$stack_dir/scripts/operations.py" \
  --project superkalan-traccar --env-file "$stack_dir/.env" \
  backup --output "$stack_dir/backups" --gcs-prefix "$BACKUP_GCS_PREFIX" \
  --remove-local-after-upload "$@"
