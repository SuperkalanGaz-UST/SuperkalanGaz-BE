#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
umask 077

# This startup script contains no credentials. Configuration arrives separately
# over IAP into a root-owned directory after package installation is verified.
if ! command -v docker >/dev/null 2>&1; then
apt-get update
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod 0644 /etc/apt/keyrings/docker.asc
source /etc/os-release
test "${VERSION_CODENAME}" = noble

python3 - <<'PY'
from pathlib import Path
Path('/etc/apt/sources.list.d/docker.sources').write_text('Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: noble\nComponents: stable\nArchitectures: amd64\nSigned-By: /etc/apt/keyrings/docker.asc\n')
Path('/etc/docker').mkdir(exist_ok=True)
Path('/etc/docker/daemon.json').write_text('{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"}}\n')
PY
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
install -m 0700 -d /opt/superkalan-traccar

# Docker-published ports bypass UFW. The VPC is the outer boundary; apply the
# same restrictions in DOCKER-USER rather than pretending UFW protects them.
iptables -N SUPERKALAN-DOCKER 2>/dev/null || true
iptables -F SUPERKALAN-DOCKER
iptables -A SUPERKALAN-DOCKER -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -A SUPERKALAN-DOCKER -s 172.16.0.0/12 -j RETURN
iptables -A SUPERKALAN-DOCKER -p tcp -m conntrack --ctorigdstport 5013 -j RETURN
iptables -A SUPERKALAN-DOCKER -p tcp -s 10.60.1.0/26 -m conntrack --ctorigdstport 443 -j RETURN
iptables -A SUPERKALAN-DOCKER -j DROP
iptables -C DOCKER-USER -j SUPERKALAN-DOCKER 2>/dev/null || iptables -I DOCKER-USER 1 -j SUPERKALAN-DOCKER

python3 - <<'PY'
from pathlib import Path
Path('/etc/systemd/system/superkalan-credit-cutoff.service').write_text('[Unit]\nDescription=Stop the Traccar VM at the approved credit cutoff\n[Service]\nType=oneshot\nExecStart=/usr/sbin/shutdown -h now\n')
Path('/etc/systemd/system/superkalan-credit-cutoff.timer').write_text('[Unit]\nDescription=December 20 Manila shutdown after final export window\n[Timer]\nOnCalendar=2026-12-20 01:00:00 Asia/Manila\nPersistent=true\n[Install]\nWantedBy=timers.target\n')
PY
systemctl daemon-reload
systemctl enable --now superkalan-credit-cutoff.timer
touch /opt/superkalan-traccar/bootstrap-ready
echo 'Docker ready; IAP-only administration and VM cutoff timer prepared.'
