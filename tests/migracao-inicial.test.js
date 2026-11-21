'use strict';

// Revisão da migração do T04 (TASK-010): o que a migração garante de verdade, medido com node:sqlite em memória.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SQL = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '0001_inicial.sql'), 'utf8');

function banco() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SQL);
  db.exec("INSERT INTO empresas (id, nome, agente, modulos) VALUES ('e1', 'A', '{}', '{}')");
  return db;
}
const evento = (db, acao = 'criada', refSeq = null, seq = null) =>
  db.prepare("INSERT OR ABORT INTO historico (seq, empresa_id, entidade, entidade_id, acao, ref_seq, evento) VALUES (?, 'e1', 'reserva', '1', ?, ?, '{}')").run(seq, acao, refSeq);

test('a migração pode ser aplicada duas vezes (IF NOT EXISTS)', () => {
  const db = banco();
  assert.doesNotThrow(() => db.exec(SQL));
});

test('histórico: UPDATE, DELETE e INSERT OR REPLACE do mesmo seq são recusados', () => {
  const db = banco();
  evento(db);
  assert.throws(() => db.exec("UPDATE historico SET acao = 'x'"), /apenas novos eventos/);
  assert.throws(() => db.exec('DELETE FROM historico'), /apenas novos eventos/);
  assert.throws(() => db.prepare("INSERT OR REPLACE INTO historico (seq, empresa_id, entidade, acao, evento) VALUES (1, 'e1', 'x', 'y', '{}')").run(), /apenas novos eventos/);
  db.exec('PRAGMA recursive_triggers = ON');
  assert.throws(() => db.prepare("INSERT OR REPLACE INTO historico (seq, empresa_id, entidade, acao, evento) VALUES (1, 'e1', 'x', 'y', '{}')").run(), /apenas novos eventos/);
  assert.strictEqual(db.prepare('SELECT acao FROM historico').get().acao, 'criada');
});

test('histórico: seq sem buraco e o mesmo evento não é desfeito duas vezes', () => {
  const db = banco();
  evento(db); evento(db, 'desfeita', 1);
  assert.deepStrictEqual(db.prepare('SELECT seq FROM historico ORDER BY seq').all().map((r) => r.seq), [1, 2]);
  assert.throws(() => evento(db, 'desfeita', 1));
  assert.throws(() => db.prepare("INSERT OR REPLACE INTO historico (empresa_id, entidade, acao, ref_seq, evento) VALUES ('e1', 'x', 'desfeita', 1, '{}')").run());
});

test('excluir a empresa leva reservas e conhecimento, mas o histórico fica', () => {
  const db = banco();
  db.exec("INSERT INTO reservas (id, codigo, empresa_id, mesa_id, ambiente, data, horario, pessoas, inicio, fim, status) VALUES ('00000000-0000-4000-8000-000000000000', '22222222', 'e1', 'S1', 'salao', '2026-11-20', '20:00', 2, 1, 91, 'confirmada')");
  db.exec("INSERT INTO conhecimento (empresa_id, id, item) VALUES ('e1', 1, '{}')");
  evento(db);
  db.exec("DELETE FROM empresas WHERE id = 'e1'");
  for (const t of ['reservas', 'conhecimento']) assert.strictEqual(db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c, 0, t);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM historico').get().c, 1);
});

test('chaves estrangeiras e CHECK de status valem', () => {
  const db = banco();
  const inserir = db.prepare(`INSERT INTO reservas (id, codigo, empresa_id, mesa_id, ambiente, data, horario, pessoas, inicio, fim, status)
    VALUES ('00000000-0000-4000-8000-000000000000', '22222222', ?, 'S1', 'a', 'd', 'h', 1, 1, 2, ?)`);
  assert.throws(() => inserir.run('nao', 'confirmada'), /FOREIGN KEY/);
  assert.throws(() => inserir.run('e1', 'x'), /CHECK/);
});
