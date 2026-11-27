'use strict';

// Contrato A (docs/plano-setores-gestao-ambientes-mesas.md): mesmas assinaturas e mesmo comportamento
// no repositório em memória e no SQLite.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { criarRepositorioSqlite } = require('../src/sqlite/repositorio');
const { criarRepositorioMemoria } = require('../src/repositorio');
const { plataformaWeb } = require('../src/plataforma');
const { abrirD1 } = require('./auxiliar/d1.cjs');

const AGORA = Date.parse('2026-11-21T15:00:00Z'); // 12:00 em São Paulo
const plat = { ...plataformaWeb(), agora: () => AGORA };
const E = 'empresa_1';
const base = () => ({
  id: E,
  nome: 'Restaurante',
  agente: {},
  ambientes: [
    { nome: 'Salão', mesas: [{ id: 'S1', capacidade: 4, reservavel: true }, { id: 'S2', capacidade: 2, reservavel: true }] },
    { nome: 'Varanda', mesas: [{ id: 'V1', capacidade: 4, reservavel: true }] },
  ],
  reservas: [
    { mesaId: 'S1', data: '2026-11-20', horario: '20:00', pessoas: 2, status: 'confirmada' }, // passada
    { mesaId: 'S2', data: '2026-11-25', horario: '20:00', pessoas: 2, status: 'cancelada' }, // futura, cancelada
    { mesaId: 'V1', data: '2026-11-25', horario: '20:00', pessoas: 2, status: 'confirmada' }, // ativa
  ],
});

async function criar(modo, t) {
  if (modo === 'd1') {
    const store = (await abrirD1(t)).abrir({ plat });
    await store.empresaCriar(base());
    return { store };
  }
  if (modo === 'memoria') {
    const store = criarRepositorioMemoria({ plat });
    await store.empresaCriar(base());
    return { store };
  }
  const pasta = mkdtempSync(join(tmpdir(), 'chatflow-ca-'));
  const store = criarRepositorioSqlite({ plat, caminho: join(pasta, 'a.sqlite') });
  t.after(async () => { try { await store.fechar?.(); } catch { /* já fechado */ } rmSync(pasta, { recursive: true, force: true }); });
  await store.empresaCriar(base());
  return { store };
}

for (const modo of ['memoria', 'sqlite', 'd1']) {
  test(`${modo}: ambienteRenomear valida nome e atualiza as reservas`, async (t) => {
    const { store } = await criar(modo, t);
    assert.deepEqual(await store.ambienteRenomear(E, 'Inexistente', 'X'), { erro: 'nao_encontrado' });
    assert.deepEqual(await store.ambienteRenomear(E, 'Salão', 'varanda'), { erro: 'nome_duplicado' });
    const novo = await store.ambienteRenomear(E, 'Salão', 'Salão Principal');
    assert.equal(novo.nome, 'Salão Principal');
    assert.deepEqual(novo.mesas.map((m) => m.id), ['S1', 'S2']);
    assert.deepEqual((await store.empresaObter(E)).ambientes.map((a) => a.nome), ['Salão Principal', 'Varanda']);
    const doSalao = (await store.reservaListar(E)).filter((r) => r.mesaId?.startsWith('S'));
    assert.equal(doSalao.length, 2);
    assert.ok(doSalao.every((r) => r.ambiente === 'Salão Principal'));
    assert.equal((await store.ambienteRenomear(E, 'Varanda', 'VARANDA')).nome, 'VARANDA'); // só muda a caixa
  });

  test(`${modo}: mesaRemover recusa reserva ativa e desliga as passadas e canceladas`, async (t) => {
    const { store } = await criar(modo, t);
    assert.deepEqual(await store.mesaRemover(E, 'ZZ'), { erro: 'nao_encontrado' });
    const bloqueada = await store.mesaRemover(E, 'V1');
    assert.equal(bloqueada.erro, 'mesa_com_reserva');
    assert.equal(bloqueada.reservas.length, 1);
    assert.ok((await store.empresaObter(E)).ambientes[1].mesas.some((m) => m.id === 'V1')); // nada gravado
    const ok = await store.mesaRemover(E, 'S1');
    assert.equal(ok.ok, true);
    assert.equal(ok.reservasDesligadas.length, 1);
    const r = await store.reservaObter(E, ok.reservasDesligadas[0]);
    assert.equal(r.mesaId ?? null, null);
    assert.deepEqual((await store.empresaObter(E)).ambientes[0].mesas.map((m) => m.id), ['S2']);
    assert.deepEqual(await store.mesaRemover(E, 'S1'), { erro: 'nao_encontrado' });
  });

  test(`${modo}: ambienteRemover é tudo ou nada e remove as mesas`, async (t) => {
    const { store } = await criar(modo, t);
    assert.deepEqual(await store.ambienteRemover(E, 'Inexistente'), { erro: 'nao_encontrado' });
    const bloqueado = await store.ambienteRemover(E, 'Varanda');
    assert.equal(bloqueado.erro, 'mesa_com_reserva');
    assert.equal((await store.empresaObter(E)).ambientes.length, 2);
    const ok = await store.ambienteRemover(E, 'Salão');
    assert.deepEqual(ok, { ok: true, mesasRemovidas: ['S1', 'S2'] });
    assert.deepEqual((await store.empresaObter(E)).ambientes.map((a) => a.nome), ['Varanda']);
    assert.equal((await store.reservaListar(E)).length, 3); // reservas preservadas
  });

  test(`${modo}: reservaExcluir só exclui cancelada e o código não volta a ser emitido`, async (t) => {
    const { store } = await criar(modo, t);
    const todas = await store.reservaListar(E);
    const ativa = todas.find((r) => r.status === 'confirmada' && r.mesaId === 'V1');
    const cancelada = todas.find((r) => r.status === 'cancelada');
    assert.deepEqual(await store.reservaExcluir(E, 'ZZZZZZZZ'), { erro: 'nao_encontrada' });
    assert.deepEqual(await store.reservaExcluir(E, ativa.id), { erro: 'reserva_ativa' });
    const ok = await store.reservaExcluir(E, cancelada.id);
    assert.equal(ok.ok, true);
    assert.equal(ok.reserva.id, cancelada.id);
    assert.equal(ok.reserva.status, 'cancelada');
    assert.equal(await store.reservaObter(E, cancelada.id), null);
    assert.deepEqual(await store.reservaExcluir(E, cancelada.id), { erro: 'nao_encontrada' });
    assert.equal((await store.reservaListar(E)).length, 2);
  });

  test(`${modo}: reserva sem mesa não pode ser reativada`, async (t) => {
    const { store } = await criar(modo, t);
    const { reservasDesligadas } = await store.mesaRemover(E, 'S2');
    const r = await store.reservaReativar(E, reservasDesligadas[0]);
    assert.equal(r.ok, false);
  });
}

test('SQLite: a migração 0002 preserva os dados e permite mesa_id nulo', async (t) => {
  const pasta = mkdtempSync(join(tmpdir(), 'chatflow-mig-'));
  const abertos = [];
  t.after(async () => {
    for (const x of abertos) { try { await (x.fechar ? x.fechar() : x.close()); } catch { /* já fechado */ } }
    rmSync(pasta, { recursive: true, force: true });
  });
  const caminho = join(pasta, 'a.sqlite');
  // Banco na versão 1: só a 0001, com uma reserva gravada.
  const db = new DatabaseSync(caminho);
  db.exec(readFileSync(join(__dirname, '..', 'db', 'migrations', '0001_inicial.sql'), 'utf8'));
  db.exec('PRAGMA user_version = 1');
  db.exec("INSERT INTO empresas (id, nome, nome_normalizado, agente, modulos) VALUES ('empresa_1','R','r','{}','{}')");
  db.exec(`INSERT INTO reservas (id, empresa_id, codigo, mesa_id, ambiente, data, horario, pessoas, inicio, fim, status)
    VALUES ('u1','empresa_1','22222222','S1','Salão','2026-11-20','20:00',2,1000,1090,'confirmada')`);
  db.close();
  const store = criarRepositorioSqlite({ plat, caminho });
  abertos.push(store);
  const r = await store.reservaObter('empresa_1', '22222222');
  assert.equal(r.mesaId, 'S1');
  assert.equal(r.pessoas, 2);
  const verifica = new DatabaseSync(caminho);
  abertos.push(verifica);
  assert.equal(verifica.prepare('PRAGMA user_version').get().user_version, 5);
  assert.equal(verifica.prepare('SELECT COUNT(*) AS n FROM reservas_codigos').get().n, 1);
  verifica.exec("UPDATE reservas SET mesa_id = NULL WHERE codigo = '22222222'"); verifica.exec("DELETE FROM reservas WHERE codigo = '22222222'");
  assert.throws(() => verifica.exec(`INSERT INTO reservas (id, empresa_id, codigo, mesa_id, ambiente, data, horario, pessoas, inicio, fim, status)
    VALUES ('u2','empresa_1','22222222',NULL,'x','d','h',1,1,2,'cancelada')`), /UNIQUE|codigo de reserva ja emitido/);
});

for (const modo of ['memoria', 'sqlite', 'd1']) {
  test(`${modo}: a descrição da mesa é gravada, preservada, apagada e vem da semente`, async (t) => {
    const { store } = await criar(modo, t);
    const mesa = async (id) => (await store.empresaObter(E)).ambientes.flatMap((a) => a.mesas).find((m) => m.id === id);
    await store.mesaEditar(E, 'S1', { descricao: 'Perto da porta' });
    assert.equal((await mesa('S1')).descricao, 'Perto da porta');
    await store.mesaEditar(E, 'S1', { capacidade: 8 });
    assert.equal((await mesa('S1')).descricao, 'Perto da porta');
    await store.mesaEditar(E, 'S1', { descricao: '' });
    assert.ok(!('descricao' in (await mesa('S1'))));
    const nova = await store.mesaCriar(E, 'Salão', { capacidade: 2, descricao: 'Área verde' });
    assert.equal((await mesa(nova.id)).descricao, 'Área verde');
    const semente = base();
    semente.ambientes[0].mesas[0].descricao = 'Parede do bar';
    await store.empresaCriar({ ...semente, id: 'empresa_2', nome: 'Outro', reservas: [] });
    assert.equal((await store.empresaObter('empresa_2')).ambientes[0].mesas[0].descricao, 'Parede do bar');
  });
}
