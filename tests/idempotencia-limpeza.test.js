'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { limparIdempotencia } = require('../src/sqlite/idempotencia-limpeza');

const MIGRACAO = path.join(__dirname, '..', 'db', 'migrations', '0001_inicial.sql');
const H = 60 * 60 * 1000;
const AGORA = 1_800_000_000_000;

function banco(linhas = []) {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(MIGRACAO, 'utf8')); // o esquema real do T04, não uma cópia
  const insEmpresa = db.prepare("INSERT INTO empresas (id, nome, agente, modulos) VALUES (?, ?, '{}', '{}')");
  for (const id of new Set(linhas.map(([empresaId]) => empresaId))) insEmpresa.run(id, id);
  const ins = db.prepare('INSERT INTO idempotencia (empresa_id, chave, resposta, criada_em) VALUES (?, ?, ?, ?)');
  for (const [e, c, t] of linhas) ins.run(e, c, '{}', t);
  return db;
}
const chaves = (db, e) => db.prepare('SELECT chave FROM idempotencia WHERE empresa_id = ? ORDER BY criada_em, chave').all(e).map((r) => r.chave);

test('apaga o que passou da validade e mantém o resto', async () => {
  const db = banco([['e1', 'velha', AGORA - 25 * H], ['e1', 'nova', AGORA - 1 * H]]);
  const r = await limparIdempotencia(db, { empresaId: 'e1', ttlMs: 24 * H, agoraMs: AGORA });
  assert.deepStrictEqual(r, { porTtl: 1, porTeto: 0 });
  assert.deepStrictEqual(chaves(db, 'e1'), ['nova']);
});

test('na fronteira: exatamente ttl de idade expira (igual à memória), um ms a menos fica', async () => {
  const db = banco([['e1', 'exata', AGORA - 24 * H], ['e1', 'quase', AGORA - 24 * H + 1]]);
  await limparIdempotencia(db, { empresaId: 'e1', ttlMs: 24 * H, agoraMs: AGORA });
  assert.deepStrictEqual(chaves(db, 'e1'), ['quase']);
});

test('acima do teto por empresa saem as mais antigas', async () => {
  const db = banco([['e1', 'a', AGORA - 5], ['e1', 'b', AGORA - 4], ['e1', 'c', AGORA - 3], ['e1', 'd', AGORA - 2], ['e1', 'e', AGORA - 1]]);
  const r = await limparIdempotencia(db, { empresaId: 'e1', ttlMs: H, max: 3, agoraMs: AGORA });
  assert.deepStrictEqual(r, { porTtl: 0, porTeto: 2 });
  assert.deepStrictEqual(chaves(db, 'e1'), ['c', 'd', 'e']);
});

test('limpar uma empresa não mexe nas outras', async () => {
  const db = banco([['e1', 'velha', AGORA - 30 * H], ['e2', 'velha', AGORA - 30 * H], ['e2', 'a', AGORA - 3], ['e2', 'b', AGORA - 2], ['e2', 'c', AGORA - 1]]);
  await limparIdempotencia(db, { empresaId: 'e1', ttlMs: 24 * H, max: 1, agoraMs: AGORA });
  assert.deepStrictEqual(chaves(db, 'e1'), []);
  assert.strictEqual(chaves(db, 'e2').length, 4);
});

test('sem empresaId limpa todas, cada uma com o seu teto', async () => {
  const db = banco([
    ['e1', 'a', AGORA - 3], ['e1', 'b', AGORA - 2], ['e1', 'c', AGORA - 1],
    ['e2', 'x', AGORA - 3], ['e2', 'y', AGORA - 2],
    ['e3', 'velha', AGORA - 48 * H],
  ]);
  const r = await limparIdempotencia(db, { ttlMs: 24 * H, max: 2, agoraMs: AGORA });
  assert.deepStrictEqual(r, { porTtl: 1, porTeto: 1 });
  assert.deepStrictEqual(chaves(db, 'e1'), ['b', 'c']);
  assert.deepStrictEqual(chaves(db, 'e2'), ['x', 'y']);
  assert.deepStrictEqual(chaves(db, 'e3'), []);
});

test('empate de criada_em: sai a gravada primeiro (ordem de gravação)', async () => {
  const db = banco([['e1', 'primeira', AGORA - 5], ['e1', 'segunda', AGORA - 5], ['e1', 'terceira', AGORA - 5]]);
  await limparIdempotencia(db, { empresaId: 'e1', ttlMs: H, max: 2, agoraMs: AGORA });
  assert.deepStrictEqual(chaves(db, 'e1'), ['segunda', 'terceira']);
});

test('é idempotente: a segunda rodada não apaga nada', async () => {
  const db = banco([['e1', 'velha', AGORA - 30 * H], ['e1', 'a', AGORA - 2], ['e1', 'b', AGORA - 1]]);
  const op = { empresaId: 'e1', ttlMs: 24 * H, max: 1, agoraMs: AGORA };
  await limparIdempotencia(db, op);
  assert.deepStrictEqual(await limparIdempotencia(db, op), { porTtl: 0, porTeto: 0 });
  assert.deepStrictEqual(chaves(db, 'e1'), ['b']);
});

test('usa os padrões de 24 h e 10000 quando não informados', async () => {
  const db = banco([['e1', 'velha', AGORA - 25 * H], ['e1', 'nova', AGORA - 23 * H]]);
  await limparIdempotencia(db, { empresaId: 'e1', agoraMs: AGORA });
  assert.deepStrictEqual(chaves(db, 'e1'), ['nova']);
});

test('aceita o formato do D1 (prepare().bind().run() com meta.changes)', async () => {
  const real = banco([['e1', 'velha', AGORA - 30 * H], ['e1', 'nova', AGORA - 1]]);
  const d1 = {
    prepare(sql) {
      const stmt = real.prepare(sql);
      return { bind: (...p) => ({ run: async () => ({ meta: { changes: stmt.run(...p).changes } }) }) };
    },
  };
  const r = await limparIdempotencia(d1, { empresaId: 'e1', ttlMs: 24 * H, agoraMs: AGORA });
  assert.deepStrictEqual(r, { porTtl: 1, porTeto: 0 });
  assert.deepStrictEqual(chaves(real, 'e1'), ['nova']);
});

test('rejeita ttl e teto inválidos', async () => {
  const db = banco();
  await assert.rejects(() => limparIdempotencia(db, { ttlMs: 0 }), /ttlMs/);
  await assert.rejects(() => limparIdempotencia(db, { max: -1 }), /max/);
  await assert.rejects(() => limparIdempotencia(db, { max: 1.5 }), /max/);
});
