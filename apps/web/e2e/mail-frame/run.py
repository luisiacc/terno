import os, subprocess, time, urllib.request, json
from pathlib import Path


def process_identity(p):
  return subprocess.check_output(['ps', '-p', str(p.pid), '-o', 'pid=,lstart=,command='], text=True)


def stop_owned(p, identity, grace=15):
  if p.poll() is not None:
    p.wait()
    return
  if process_identity(p) != identity:
    raise RuntimeError('PID identity changed')
  p.terminate()
  try:
    p.wait(timeout=grace)
  except subprocess.TimeoutExpired:
    if p.poll() is None:
      if process_identity(p) != identity:
        raise RuntimeError('PID identity changed before escalation')
      p.kill()
    p.wait(timeout=grace)


def main():
  root = Path(__file__).resolve().parents[4]
  out = Path('/tmp/terno-w11-tall-mail-61630')
  out.mkdir(parents=True, exist_ok=True)
  for name in ['results', 'browser.log', 'vite.log', 'cleanup.json', 'server-identity.txt', 'test-identity.txt']:
    source = out/name
    if source.exists():
      source.rename(out/(name+'.'+str(time.time_ns())+'.archive'))
  env = dict(os.environ)
  env['NODE_OPTIONS'] = env.get('NODE_OPTIONS', '') + ' --require=/tmp/terno-network-guard.cjs'
  env['E2E_PORT'] = '61630'
  serverlog = open(out/'vite.log','w')
  p = subprocess.Popen(['node','node_modules/vite/bin/vite.js','--config','e2e/mail-frame/vite.config.ts'],cwd=root/'apps/web',env=env,stdout=serverlog,stderr=subprocess.STDOUT)
  identity = subprocess.check_output(['ps','-p',str(p.pid),'-o','pid=,lstart=,command='],text=True)
  (out/'server-identity.txt').write_text(identity)
  r = None
  test_identity = None
  try:
    deadline=time.monotonic()+45
    while time.monotonic()<deadline:
      if p.poll() is not None: raise RuntimeError('Vite exited: '+(out/'vite.log').read_text())
      try:
        urllib.request.urlopen('http://127.0.0.1:61630/e2e/mail-frame/index.html',timeout=1).close()
        break
      except OSError: time.sleep(.2)
    else: raise RuntimeError('Vite startup deadline')
    with open(out/'browser.log','w') as log:
      r=subprocess.Popen(['node','node_modules/@playwright/test/cli.js','test','--config','e2e/mail-frame/playwright.config.ts'],cwd=root/'apps/web',env=env,stdout=log,stderr=subprocess.STDOUT)
      test_identity=subprocess.check_output(['ps','-p',str(r.pid),'-o','pid=,lstart=,command='],text=True)
      (out/'test-identity.txt').write_text(test_identity)
      r.wait(timeout=120)
    print((out/'browser.log').read_text())
    print('BROWSER_EXIT',r.returncode)
  finally:
    children = []
    errors = []
    for child, birth in [(r, test_identity), (p, identity)]:
      if child is None:
        continue
      try:
        stop_owned(child, birth)
      except Exception as error:
        errors.append(str(error))
      children.append({'pid': child.pid, 'identity': birth, 'joined': child.poll() is not None, 'exit': child.returncode})
    serverlog.close()
    (out/'cleanup.json').write_text(json.dumps({'children': children, 'errors': errors}))
    if errors:
      raise RuntimeError('Cleanup failed: ' + '; '.join(errors))

  return r.returncode


if __name__ == "__main__":
  raise SystemExit(main())
