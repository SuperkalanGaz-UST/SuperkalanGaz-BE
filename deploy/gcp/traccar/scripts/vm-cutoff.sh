#!/usr/bin/env bash
set -euo pipefail
umask 077

# A failed export/upload returns nonzero, preserves local backup and resumes writers.
# The owner must resolve failure and stop/release cloud resources before credit expiry.
: "${BACKUP_GCS_PREFIX:?Set daily backup bucket/prefix}"
daily_prefix="${BACKUP_GCS_PREFIX%/}"
[[ "$daily_prefix" == gs://*/daily ]] || { echo 'Cutoff requires a daily/ backup prefix' >&2; exit 1; }
export BACKUP_GCS_PREFIX="${daily_prefix%/daily}/final"
bash /opt/superkalan-traccar/scripts/vm-backup.sh --stop-after-backup
systemctl disable --now superkalan-traccar.service
systemctl disable --now superkalan-traccar-backup.timer
echo 'Final export uploaded; stack disabled; named volumes preserved.'
echo 'Main operator must stop the GCE VM and review disk/IP/backup costs separately.'
