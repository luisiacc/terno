import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import socket
from run import process_identity, stop_owned

root = Path(__file__).resolve().parents[4]
out = Path('/tmp/terno-w11-full-61640')
archive = out/('perf-archive-' + str(time.time_ns()))
archive.mkdir(parents=True)
paths = [root/'packages/backend/dist/incoming.worker.cjs', root/'test-results/perf/ui.json']
records = []
for i, path in enumerate(paths):
    existed = path.exists()
    backup = archive/str(i)
    if existed:
        shutil.copy2(path, backup)
    records.append((path, backup, existed))
env = dict(os.environ)
env['NODE_OPTIONS'] = env.get('NODE_OPTIONS', '') + ' --require=/tmp/terno-network-guard.cjs'
env['VITE_RENDER_PROBE'] = '1'
proxy = socket.socket()
proxy.bind(('127.0.0.1', 61641))
try:
    result = subprocess.Popen([sys.executable, str(Path(__file__).with_name('run.py')), '--config', 'e2e/full-message/perf.config.ts'], env=env)
    birth = process_identity(result)
    (out/'perf-runner-identity.txt').write_text(birth)
    try:
        result.wait(timeout=180)
    except subprocess.TimeoutExpired:
        stop_owned(result, birth)
        raise
finally:
    proxy.close()
    for i, (path, backup, existed) in enumerate(records):
        if path.exists():
            shutil.copy2(path, archive/('generated-' + str(i)))
        if existed:
            shutil.copy2(backup, path)
            if hashlib.sha256(path.read_bytes()).digest() != hashlib.sha256(backup.read_bytes()).digest():
                raise RuntimeError('Artifact restore mismatch')
        elif path.exists():
            path.unlink()
raise SystemExit(result.returncode)
