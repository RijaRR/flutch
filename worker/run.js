'use strict';

const { MickaelWorker, sleep } = require('./agent');

function getIntervalMs() {
  const minutes = Number(process.env.CYCLE_INTERVAL_MINUTES || 30);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : 30 * 60 * 1000;
}

async function main() {
  const worker = new MickaelWorker();
  const runOnce = process.argv.includes('--once');

  if (runOnce) {
    // Mode pratique pour validation manuelle, cron externe ou exécution one-shot.
    await worker.runCycle();
    return;
  }

  while (true) {
    await worker.runCycle();
    await sleep(getIntervalMs());
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
