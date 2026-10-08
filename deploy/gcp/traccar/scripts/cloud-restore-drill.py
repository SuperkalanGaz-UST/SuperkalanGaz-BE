#!/usr/bin/env python3
"""Recover a downloaded cloud archive into disposable local Docker volumes only."""
import datetime as dt
import json
import os
from pathlib import Path
import secrets
import shutil
import sys
import tempfile

import operations
from operations import Stack, unpack, restore
from smoke import Client


def main():
    os.umask(0o077)
    if len(sys.argv) != 3:
        raise ValueError('Usage: cloud-restore-drill.py ARCHIVE OPERATOR_JSON')
    original = operations.BASE
    runtime = original / '.runtime'
    runtime.mkdir(mode=0o700, exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix='cloud-restore-', dir=runtime))
    project = 'traccar-cloud-restore-' + secrets.token_hex(6)
    recovered = directory / 'recovered'
    unpack(sys.argv[1], recovered)
    config = recovered / 'config'
    shutil.copyfile(config / 'compose.yaml', directory / 'compose.yaml')
    (directory / 'nginx').mkdir(mode=0o700)
    (directory / 'certs').mkdir(mode=0o700)
    for name in ('nginx.conf', 'traccar-api.conf'):
        shutil.copyfile(config / name, directory / 'nginx' / name)
    for source, target in (('tls.crt', 'traccar-api.crt'), ('tls.key', 'traccar-api.key'), ('ca.crt', 'ca.crt')):
        shutil.copyfile(config / source, directory / 'certs' / target)
    env = config / 'runtime.env'
    override = directory / 'compose.restore.yaml'
    override.write_text("services:\n  traccar:\n    ports: !override\n"
                        "      - '127.0.0.1::5013/tcp'\n"
                        "  private-api-proxy:\n    ports: !override\n"
                        "      - '127.0.0.1::443/tcp'\n")
    operations.BASE = directory
    stack = Stack(project, env, [directory / 'compose.yaml', override])
    summary = {'checkedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
               'archive': Path(sys.argv[1]).name, 'project': project, 'passed': False}
    try:
        stack.compose('up', '-d', '--wait', '--wait-timeout', '600', 'database')
        restore(stack, recovered)
        stack.compose('up', '-d', '--wait', '--wait-timeout', '600')
        port = int(stack.compose('port', 'private-api-proxy', '443').decode().strip().rsplit(':', 1)[1])
        api = Client(port, directory / 'certs/ca.crt')
        operator = json.loads(Path(sys.argv[2]).read_text())
        status, user = api.request('POST', '/api/session', {'email': operator['email'], 'password': operator['password']}, True)
        if status != 200 or not user.get('administrator'):
            raise RuntimeError('Restored operator authentication failed')
        status, server = api.request('GET', '/api/server')
        if status != 200 or server.get('registration'):
            raise RuntimeError('Restored registration policy failed')
        users = api.request('GET', '/api/users')[1]
        if len(users) != 2 or not any(u['email'] == operator['integration_email'] and not u['administrator'] for u in users):
            raise RuntimeError('Restored integration account failed')
        if api.request('GET', '/api/devices')[1] != []:
            raise RuntimeError('Fresh cloud instance unexpectedly contained devices')
        summary.update(passed=True, checks=['archive and SQL checksums', 'empty-volume SQL recovery', 'verified private TLS', 'operator login', 'non-admin integration account', 'registration disabled', 'fresh device list'])
        print('PASS: cloud-downloaded backup restored; accounts, policy and verified TLS recovered.')
    finally:
        # Exact newly generated project only; never use production names or existing volumes.
        stack.compose('down', '--volumes', '--remove-orphans')
        summary['disposableVolumesRemoved'] = True
        (directory / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
        operations.BASE = original


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        raise SystemExit(f'Cloud restore drill failed: {type(error).__name__}; secret diagnostics withheld') from None
