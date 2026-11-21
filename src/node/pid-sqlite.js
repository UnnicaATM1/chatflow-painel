import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';

function pidDoTiniPai(pid) {
  if (process.platform !== 'linux' || pid !== 1 || process.ppid !== pid) return false;
  try { return ['tini', 'tini-static'].includes(readFileSync('/proc/1/comm', 'utf8').trim()); }
  catch { return false; }
}

export function reservarPidSqlite(caminho) {
  const arquivo = `${caminho}.pid`;
  const pidAtual = String(process.pid);
  function lerPid() {
    try { return readFileSync(arquivo, 'utf8').trim(); }
    catch { return null; }
  }

  const anterior = lerPid();
  const pid = Number(anterior);
  // O PID do processo atual ou do init pode ter sobrado de um contêiner
  // anterior. Na primeira subida com Tini, PID 1 agora identifica o init.
  if (pid !== process.pid && /^[0-9]+$/.test(anterior) && Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff) {
    let vivo = true;
    try { process.kill(pid, 0); }
    catch (erro) {
      vivo = erro.code !== 'ESRCH';
    }
    if (vivo && !pidDoTiniPai(pid)) throw new Error(`O servidor SQLite parece estar rodando (PID ${pid} em "${arquivo}")`);
  }

  // A abertura do servidor já detém o lock do SQLite. O rename também protege
  // leitores externos que não usam esse lock contra um marcador parcial.
  const temporario = `${arquivo}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporario, pidAtual + '\n', { flag: 'wx', mode: 0o600, flush: true });
    renameSync(temporario, arquivo);
  } finally {
    rmSync(temporario, { force: true });
  }

  function liberar() {
    if (lerPid() === pidAtual) unlinkSync(arquivo);
  }
  return liberar;
}
