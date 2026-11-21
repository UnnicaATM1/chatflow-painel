// Limpeza das respostas de idempotência guardadas em SQL (SQLite local ou D1).
// Faz no banco o que `idemGravar` faz na memória (src/repositorio.js): apaga o que passou da validade (ttlMs) e, acima do
// teto por empresa (max), as entradas mais antigas.
//
// Tabela esperada (db/migrations/0001_inicial.sql, T04): idempotencia(id, empresa_id, chave, resposta, criada_em),
// com criada_em em milissegundos, id crescente (ordem de gravação) e UNIQUE (empresa_id, chave). Só SQL padrão do SQLite: funciona igual no
// D1 (que aceita funções de janela e comparação de linhas).
//
// `db` pode ser o DatabaseSync do node:sqlite (`prepare(sql).run(...params)`) ou o binding D1
// (`prepare(sql).bind(...params).run()`); a função detecta qual é.
// Idempotente: pode rodar várias vezes e em paralelo, o resultado final é o mesmo.

import { IDEMPOTENCIA_TTL_PADRAO_MS, IDEMPOTENCIA_MAX_PADRAO } from '../repositorio.js';

// Validade: igual à regra da memória (`agora - quando >= ttl` expira), então criada_em <= agora - ttl sai.
const SQL_TTL = 'DELETE FROM idempotencia WHERE criada_em <= ?';
const SQL_TTL_EMPRESA = 'DELETE FROM idempotencia WHERE empresa_id = ? AND criada_em <= ?';

// Teto: numera as entradas de cada empresa da mais nova para a mais antiga (desempate pelo id, a ordem de gravação)
// e apaga da posição max+1 em diante. Usa o índice idempotencia_por_empresa (empresa_id, criada_em, id).
const SQL_TETO = `DELETE FROM idempotencia WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY empresa_id ORDER BY criada_em DESC, id DESC) AS posicao
    FROM idempotencia
  ) WHERE posicao > ?
)`;
const SQL_TETO_EMPRESA = `DELETE FROM idempotencia WHERE id IN (
  SELECT id FROM idempotencia WHERE empresa_id = ? ORDER BY criada_em DESC, id DESC LIMIT -1 OFFSET ?
)`;

async function executar(db, sql, params) {
  const stmt = db.prepare(sql);
  const r = typeof stmt.bind === 'function' ? await stmt.bind(...params).run() : await stmt.run(...params);
  // node:sqlite: { changes }; D1: { meta: { changes } }
  return Number((r && (r.meta ? r.meta.changes : r.changes)) || 0);
}

function inteiroPositivo(v, padrao, nome) {
  if (v === undefined || v === null) return padrao;
  if (!Number.isInteger(v) || v < 1) throw new Error(`${nome} deve ser um inteiro positivo`);
  return v;
}

// Apaga as respostas vencidas e as que passam do teto. Sem `empresaId`, limpa todas as empresas (cada uma com seu teto).
// Devolve quantas linhas saíram por validade e por teto.
export async function limparIdempotencia(db, { empresaId, ttlMs, max, agoraMs } = {}) {
  const ttl = inteiroPositivo(ttlMs, IDEMPOTENCIA_TTL_PADRAO_MS, 'ttlMs');
  const teto = inteiroPositivo(max, IDEMPOTENCIA_MAX_PADRAO, 'max');
  const agora = agoraMs === undefined ? Date.now() : agoraMs;
  if (!Number.isFinite(agora)) throw new Error('agoraMs deve ser um número');
  const limite = agora - ttl;
  if (empresaId === undefined || empresaId === null) {
    const porTtl = await executar(db, SQL_TTL, [limite]);
    const porTeto = await executar(db, SQL_TETO, [teto]);
    return { porTtl, porTeto };
  }
  const porTtl = await executar(db, SQL_TTL_EMPRESA, [empresaId, limite]);
  const porTeto = await executar(db, SQL_TETO_EMPRESA, [empresaId, teto]);
  return { porTtl, porTeto };
}
