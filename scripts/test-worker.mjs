import { spawn } from 'node:child_process';
import { buildWorker } from './build-worker.mjs';

await buildWorker('tests/fixtures/worker-entry.mjs', 'node_modules/.cache/chatflow/worker-entry.js');
const teste = spawn(process.execPath, ['--test', 'tests/api.test.js'], {
  env: {
    ...process.env,
    CHATFLOW_TESTE_WORKER: '1',
    CHATFLOW_TESTE_WORKER_D1: process.argv.includes('--d1') ? '1' : '0',
  },
  stdio: 'inherit',
});
process.exitCode = await new Promise((resolve, reject) => {
  teste.once('error', reject);
  teste.once('exit', (codigo) => resolve(codigo ?? 1));
});
