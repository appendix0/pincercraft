#!/usr/bin/env python3
"""Minimal Minecraft RCON client for the eval rig.

    python3 eval/rcon.py "<command>" [more commands...]

Exists so the RUNNER can reach the server console without the agent being op.
That split is deliberate: resetting world state between attempts needs
`clear`/`tp`, but an LLM-driven bot holding op could `kill`, `ban`, or `op`
itself, and the Code of Conduct layer is not a security boundary. The password
lives in .runtime/rcon.pass (0600) and RCON binds only on the eval server
(pincercraft-ts :25575) — never YOON.

Protocol (Source RCON): little-endian [len][id][type][body\\0\\0]; type 3 =
auth, 2 = command. An auth failure comes back as id -1.
"""
import os, socket, struct, sys

HOST = os.environ.get('RCON_HOST', '127.0.0.1')
PORT = int(os.environ.get('RCON_PORT', '25575'))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PASS_FILE = os.path.join(ROOT, '.runtime', 'rcon.pass')


def _pack(req_id, typ, body):
    payload = struct.pack('<ii', req_id, typ) + body.encode() + b'\x00\x00'
    return struct.pack('<i', len(payload)) + payload


def _read(sock):
    raw = sock.recv(4)
    if len(raw) < 4:
        raise RuntimeError('short read from RCON')
    (length,) = struct.unpack('<i', raw)
    data = b''
    while len(data) < length:
        chunk = sock.recv(length - len(data))
        if not chunk:
            raise RuntimeError('RCON closed mid-packet')
        data += chunk
    req_id, _typ = struct.unpack('<ii', data[:8])
    return req_id, data[8:-2].decode('utf-8', 'replace')


def run(commands):
    with open(PASS_FILE) as f:
        password = f.read().strip()
    out = []
    with socket.create_connection((HOST, PORT), timeout=10) as s:
        s.sendall(_pack(1, 3, password))
        rid, _ = _read(s)
        if rid == -1:
            raise SystemExit('RCON auth failed — check .runtime/rcon.pass')
        for i, cmd in enumerate(commands):
            s.sendall(_pack(10 + i, 2, cmd))
            _, body = _read(s)
            out.append(body.strip())
    return out


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    for line in run(sys.argv[1:]):
        if line:
            print(line)
