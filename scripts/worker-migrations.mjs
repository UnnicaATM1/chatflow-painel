import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const separador = '--> statement-breakpoint';
// Cada posição fica fixa para as migrações já entregues. Novas migrações são anexadas.
const primeiraMigracao = Date.UTC(2026, 10, 22);

export async function empacotarMigracoes(origem, destino) {
  const arquivos = (await readdir(origem)).filter((nome) => nome.endsWith('.sql')).sort();
  await mkdir(new URL('meta/', destino), { recursive: true });

  const db = new DatabaseSync(':memory:');
  const entries = [];
  try {
    for (const arquivo of arquivos) {
      let sql = (await readFile(new URL(arquivo, origem), 'utf8')).trim();
      const instrucoes = [];
      while (sql) {
        // SQLite identifica a instrução inteira, incluindo BEGIN/END dos gatilhos.
        const instrucao = db.prepare(sql);
        instrucao.run();
        instrucoes.push(instrucao.sourceSQL);
        sql = sql.slice(instrucao.sourceSQL.length).trimStart();
      }
      await writeFile(new URL(arquivo, destino), instrucoes.join('\n' + separador + '\n') + '\n');
      entries.push({
        idx: entries.length,
        version: '6',
        when: primeiraMigracao + entries.length,
        tag: arquivo.slice(0, -4),
        breakpoints: true,
      });
    }
  } finally {
    db.close();
  }
  const journal = { version: '7', dialect: 'sqlite', entries };
  await writeFile(new URL('meta/_journal.json', destino), JSON.stringify(journal, null, 2) + '\n');
}
