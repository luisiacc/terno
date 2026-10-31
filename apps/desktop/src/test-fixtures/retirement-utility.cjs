// Real Node native fetch inside Electron's utility, deliberately retaining a body.
require('/tmp/terno-network-guard.cjs');
(async () => {
  const response = await fetch(`http://127.0.0.1:${process.argv[2]}/held`);
  const reader = response.body.getReader();
  await reader.read();
  process.parentPort.postMessage('logical-closed-body-held');
  await reader.read();
  throw new Error('Fixture body unexpectedly completed');
})();
