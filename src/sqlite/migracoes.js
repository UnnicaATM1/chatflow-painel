import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIRETORIO = fileURLToPath(new URL('../../db/migrations/', import.meta.url));

export function aplicarMigracoesSqlite(db, diretorio = DIRETORIO) {
  const migracoes = readdirSync(diretorio)
    .map((arquivo) => ({ arquivo, numero: Number(/^(\d{4})_.+\.sql$/.exec(arquivo)?.[1]) }))
    .filter(({ numero }) => Number.isInteger(numero))
    .sort((a, b) => a.numero - b.numero);
  if (!migracoes.length || migracoes.some(({ numero }, i) => numero !== i + 1)) {
    throw new Error('Migrações SQLite devem ser consecutivas a partir de 0001');
  }

  const versao = db.prepare('PRAGMA user_version');
  const instalada = versao.get().user_version;
  if (instalada > migracoes.length) {
    throw new Error(`Banco SQLite na versão ${instalada}, acima da última migração disponível (${migracoes.length})`);
  }
  for (const { arquivo, numero } of migracoes.slice(instalada)) {
    const sql = readFileSync(join(diretorio, arquivo), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      // Outra conexão pode ter aplicado a migração enquanto esperávamos o lock.
      if (versao.get().user_version < numero) {
        db.exec(sql);
        db.exec(`PRAGMA user_version = ${numero}`);
      }
      db.exec('COMMIT');
    } catch (erro) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw new Error(`Falha na migração SQLite ${arquivo}: ${erro.message}`, { cause: erro });
    }
  }
}
