const { app, utilityProcess } = require('electron');
const { createServer } = require('node:http');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { BackendRetirement } = require(process.argv[2]);
app.setPath('userData', process.argv[3]);
const identity = (pid) => ({ pid, birth: execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim(), argv: execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim() });
console.log(JSON.stringify({ main: identity(process.pid) }));
app.whenReady().then(async () => {
  let terminal;
  const socketClosed = new Promise((r) => { terminal = r; });
  const server = createServer((req, res) => {
    if (req.url !== '/held') throw new Error('Unexpected fixture route');
    req.socket.once('close', terminal);
    res.writeHead(200); res.write('held native body');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const child = utilityProcess.fork(join(__dirname, 'retirement-utility.cjs'), [String(server.address().port)], { stdio: 'inherit' });
  const retirement = new BackendRetirement(child);
  let sawBody = false, exited = false, finishing = false;
  const finish = async (code) => {
    if (finishing) return;
    finishing = true;
    clearTimeout(watchdog);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    app.exit(code);
  };
  child.on('spawn', () => { console.log(JSON.stringify({ utility: identity(child.pid) })); child.postMessage('go'); });
  child.on('exit', () => { exited = true; if (!sawBody) void finish(2); });
  const watchdog = setTimeout(async () => { console.error('Fixture watchdog'); if (await retirement.retire()) void finish(3); }, 10000);
  child.on('message', async (msg) => {
    if (msg !== 'logical-closed-body-held') throw new Error('Unexpected fixture message');
    sawBody = true;
    if (retirement.exited || exited) throw new Error('ACK falsely terminal');
    const done = retirement.retire();
    if (!retirement.retiring || retirement.exited) throw new Error('Premature authority release');
    if (!(await done) || !exited) throw new Error('Exit not joined');
    await socketClosed;
    clearTimeout(watchdog);
    await new Promise((r) => server.close(r));
    console.log(JSON.stringify({ sawBody, exited, socketTerminal: true, retirement: retirement.exited }));
    app.quit();
  });
});
