import json
import os
from pathlib import Path
import subprocess
import sys
import time
from run import process_identity, stop_owned

root = Path(__file__).resolve().parents[4]
out = Path('/tmp/terno-w11-full-61640')
env = dict(os.environ)
env['NODE_OPTIONS'] = env.get('NODE_OPTIONS', '') + ' --require=/tmp/terno-network-guard.cjs'
env['PYTHONDONTWRITEBYTECODE'] = '1'
for name in ['validation-processes.json', 'types-main.log', 'types-worker.log', 'types-fixture.log', 'unit-final.log', 'lint.log', 'browser-coherent-r1.log']:
    path = out/name
    if path.exists(): path.rename(out/(name + '.' + str(time.time_ns()) + '.archive'))
records = []

def run(command, name, deadline=60):
    with open(out/(name + '.log'), 'w') as log:
        child = subprocess.Popen(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
        birth = process_identity(child)
        try:
            child.wait(timeout=deadline)
        finally:
            stop_owned(child, birth)
            records.append({'command': command, 'pid': child.pid, 'identity': birth, 'exit': child.returncode, 'joined': child.poll() is not None})
            (out/'validation-processes.json').write_text(json.dumps(records, indent=2))
    print(name, child.returncode, flush=True)
    if child.returncode:
        raise SystemExit(child.returncode)

pnpm = ['pnpm', '--config.verify-deps-before-run=false', 'exec']
for suffix, config in [('main', 'apps/web/tsconfig.json'), ('worker', 'apps/web/tsconfig.worker.json'), ('fixture', 'apps/web/e2e/full-message/tsconfig.json')]:
    run(pnpm + ['tsc', '-p', config], 'types-' + suffix)
run(pnpm + ['vitest', 'run', '--config', 'apps/web/e2e/full-message/vitest.config.ts'], 'unit-final')
files = [
    'apps/web/src/components/' + name for name in ['mail-body.tsx', 'mail-reader-view.tsx', 'mail-reader-back.ts', 'full-message.tsx', 'mail-sections.ts', 'reader.tsx']
] + ['apps/web/src/lib/page.ts', 'apps/web/e2e/mail-repaint.spec.ts'] + [
    'apps/web/e2e/full-message/' + name for name in ['fixture.tsx', 'reader-fixture.tsx', 'transport.ts', 'full-message.probe.ts', 'lazy.unit.ts', 'back.unit.ts', 'sections.unit.ts', 'frame-load.unit.ts', 'vite.config.ts', 'playwright.config.ts', 'vitest.config.ts', 'perf.config.ts', 'perf-setup.ts']
] + ['packages/i18n/src/locales/en.ts', 'packages/i18n/src/locales/es.ts']
run(pnpm + ['oxlint', '--deny-warnings'] + files, 'lint')
run([sys.executable, 'apps/web/e2e/full-message/run.py'], 'browser-coherent-r1', 200)
