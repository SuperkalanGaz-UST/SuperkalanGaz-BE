#!/usr/bin/env python3
"""Initialize the fresh middleware over its VM-local Docker network.

Run as root after container health checks. No credentials enter arguments or logs.
"""
import http.client
import json
import os
from pathlib import Path
import subprocess
import urllib.parse

os.umask(0o077)
base = Path('/opt/superkalan-traccar')
operator = json.loads((base / 'operator.json').read_text())
result = subprocess.run(['docker', 'compose', '--env-file', str(base / '.env'),
                         '-f', str(base / 'compose.yaml'), '-p', 'superkalan-traccar',
                         'ps', '-q', 'traccar'], check=True, capture_output=True, text=True)
container = result.stdout.strip()
if not container:
    raise SystemExit('Traccar container is missing')
inspection = subprocess.run(['docker', 'inspect', '--format', '{{json .NetworkSettings.Networks}}',
                             container], check=True, capture_output=True, text=True)
address = next(iter(json.loads(inspection.stdout).values()))['IPAddress']
cookie = None


def request(method, path, payload=None, form=False, bearer=None):
    global cookie
    connection = http.client.HTTPConnection(address, 8082, timeout=15)
    headers = {}
    body = None
    if cookie:
        headers['Cookie'] = cookie
    if bearer:
        headers['Authorization'] = 'Bearer ' + bearer
    if payload is not None:
        body = urllib.parse.urlencode(payload) if form else json.dumps(payload)
        headers['Content-Type'] = 'application/x-www-form-urlencoded' if form else 'application/json'
    connection.request(method, path, body, headers)
    response = connection.getresponse()
    session = response.getheader('Set-Cookie')
    if session:
        cookie = session.split(';', 1)[0]
    data = response.read().decode()
    status = response.status
    connection.close()
    if status >= 300:
        raise RuntimeError(f'Initialization request {method} {path} returned HTTP {status}; body withheld')
    try:
        return json.loads(data)
    except json.JSONDecodeError:
        return data


try:
    server = request('GET', '/api/server')
    if server.get('newServer'):
        request('POST', '/api/users', {'name': 'Superkalan Traccar operator',
                                     'email': operator['email'], 'password': operator['password']})
    administrator = request('POST', '/api/session', {'email': operator['email'],
                                                     'password': operator['password']}, form=True)
    if not administrator.get('administrator'):
        raise RuntimeError('Operator does not administer this fresh server')
    server = request('GET', '/api/server')
    server['registration'] = False
    request('PUT', '/api/server', server)
    users = request('GET', '/api/users')
    integration = next((user for user in users if user.get('email') == operator['integration_email']), None)
    if integration is None:
        integration = request('POST', '/api/users', {'name': 'NestJS integration',
                              'email': operator['integration_email'],
                              'password': operator['integration_password'],
                              'administrator': False, 'readonly': False,
                              'deviceLimit': -1, 'userLimit': 0, 'attributes': {}})
    if integration.get('administrator'):
        raise RuntimeError('Integration account must not administer the server')
    request('POST', '/api/session', {'email': operator['integration_email'],
                                    'password': operator['integration_password']}, form=True)
    token_file = base / 'integration-token'
    if token_file.exists():
        token = token_file.read_text()
    else:
        token = request('POST', '/api/session/token', {'expiration': '2026-12-19T16:00:00Z'}, form=True)
        if not isinstance(token, str) or len(token) < 20:
            raise RuntimeError('Unexpected token format')
        token_file.write_text(token)
        token_file.chmod(0o600)
    cookie = None
    devices = request('GET', '/api/devices', bearer=token)
    if not isinstance(devices, list):
        raise RuntimeError('Authenticated middleware API failed')
    print('Fresh Traccar configured: registration disabled; non-administrator API token verified; token payload withheld.')
except Exception as error:
    raise SystemExit(str(error)) from None
