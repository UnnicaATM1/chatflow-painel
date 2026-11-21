'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { once } = require('node:events');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { criarRepositorioSqlite } = require('../src/sqlite/repositorio');
const { criarContexto, tratar } = require('../src/nucleo');

const empresa = {
  id: 'empresa_1',
  nome: 'Restaurante',
  agente: {},
  ambientes: [{ nome: 'salão', mesas: [{ id: 'S1', capacidade: 4, reservavel: true }] }],
};
const reserva = { data: '2026-11-20', horario: '20:00', pessoas: 2, inicio: 1000, fim: 1090 };
const pedido = (chave) => ({
  empresaId: empresa.id, chave, candidatas: [{ mesaId: 'S1', ambiente: 'salão' }], reserva,
});

function arquivoDeTeste(t) {
  const configurado = process.env.CHATFLOW_BANCO_ARQUIVO;
  const pasta = configurado && configurado !== ':memory:' ? dirname(resolve(configurado)) : tmpdir();
  const dir = mkdtempSync(join(pasta, 'chatflow-sqlite-'));
  const abertos = new Set();
  t.after(async () => {
    await Promise.all([...abertos].map((store) => store.fechar()));
    rmSync(dir, { recursive: true, force: true });
  });
  const caminho = join(dir, 'teste.sqlite');
  const abrir = (opcoes) => {
    const store = criarRepositorioSqlite({ ...opcoes, caminho });
    abertos.add(store);
    return store;
  };
  const fechar = async (store) => {
    await store.fechar();
    abertos.delete(store);
  };
  return { caminho, abrir, fechar };
}

test('SQLite: várias conexões concorrentes reservam a mesma mesa e só uma vence', async (t) => {
  const { caminho, abrir, fechar } = arquivoDeTeste(t);
  const semente = abrir();
  await semente.empresaCriar(empresa);
  await fechar(semente);

  const codigo = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { criarRepositorioSqlite } = require(workerData.modulo);
    const store = criarRepositorioSqlite({ caminho: workerData.caminho });
    parentPort.once('message', async () => {
      const resultado = await store.reservaCriar(workerData.pedido);
      await store.fechar();
      parentPort.postMessage(resultado);
    });
    parentPort.postMessage('pronto');
  `;
  const workers = Array.from({ length: 8 }, (_, i) => new Worker(codigo, {
    eval: true,
    workerData: { modulo: require.resolve('../src/sqlite/repositorio'), caminho, pedido: pedido(`concorrente-${i}`) },
  }));
  t.after(() => Promise.all(workers.map((w) => w.terminate())));

  await Promise.all(workers.map((w) => once(w, 'message')));
  const pendentes = workers.map((w) => once(w, 'message'));
  for (const worker of workers) worker.postMessage('reservar');
  const resultados = (await Promise.all(pendentes)).flat();
  assert.equal(resultados.filter((r) => r.criada).length, 1);
  assert.equal(resultados.filter((r) => r.conflito).length, workers.length - 1);

  const store = abrir();
  assert.equal((await store.reservaListar(empresa.id)).length, 1);
  assert.equal(await store.idempotenciaTamanho(empresa.id), 1);
});

test('SQLite: dados, idempotência e sequências sobrevivem ao fechar e reabrir o arquivo', async (t) => {
  const { abrir, fechar } = arquivoDeTeste(t);
  const primeira = abrir();
  await primeira.empresaCriar(empresa);
  await primeira.agenteAtualizar(empresa.id, { descricao: 'Mudança persistente' });
  const criada = await primeira.reservaCriar(pedido('persistente'));
  const { item } = await primeira.conhecimentoCriar(empresa.id, { tipo: 'texto', titulo: 'Horário', texto: 'Até as 23h' }, 5);
  const evento = await primeira.historicoAcrescentar({ empresaId: empresa.id, entidade: 'reserva', entidadeId: criada.reserva.id, acao: 'criada' });
  await primeira.tentativasAdminGravar({ n: 5, ate: 2_000_000_000_000 });
  await fechar(primeira);

  const segunda = abrir();
  const empresaSalva = await segunda.empresaObter(empresa.id);
  assert.equal(empresaSalva.agente.descricao, 'Mudança persistente');
  assert.deepEqual(empresaSalva.ambientes, empresa.ambientes);
  assert.deepEqual(await segunda.reservaListar(empresa.id), [criada.reserva]);
  assert.deepEqual(await segunda.reservaCriar(pedido('persistente')), { criada: false, resposta: criada.resposta });
  assert.deepEqual(await segunda.conhecimentoObter(empresa.id, item.id), item);
  assert.deepEqual(await segunda.historicoObter(empresa.id, evento.seq), evento);
  assert.deepEqual(await segunda.tentativasAdminObter(), { n: 5, ate: 2_000_000_000_000 });
  await segunda.reservaCancelar(empresa.id, criada.reserva.id);
  const seguinte = await segunda.reservaCriar(pedido('seguinte'));
  assert.equal(seguinte.reserva.id, criada.reserva.id + 1);
});

test('SQLite: desfazer reverte a alteração se falhar ao gravar o histórico', async (t) => {
  const { caminho, abrir } = arquivoDeTeste(t);
  const auditoria = [];
  const store = abrir({ sink: (ev) => auditoria.push(ev) });
  await store.empresaCriar(empresa);
  const { reserva: criada } = await store.reservaCriar(pedido('desfazer'));
  const evento = await store.historicoAcrescentar({
    empresaId: empresa.id, entidade: 'reserva', entidadeId: criada.id, acao: 'criada',
    antes: {}, depois: { status: 'confirmada' },
  });
  const injecao = new DatabaseSync(caminho);
  try {
    injecao.exec(`CREATE TRIGGER falhar_desfazer BEFORE INSERT ON historico WHEN NEW.acao = 'desfeita'
      BEGIN SELECT RAISE(ABORT, 'falha de teste'); END`);
    const ctx = criarContexto({ store, tokens: { cliente: 'teste' } });
    const desfazer = () => tratar({
      metodo: 'POST',
      url: `/empresas/${empresa.id}/historico/${evento.seq}/desfazer`,
      headers: { authorization: 'Bearer teste' },
    }, ctx);
    assert.equal((await desfazer()).status, 400);
    assert.deepEqual(await store.reservaObter(empresa.id, criada.id), criada);
    assert.deepEqual(await store.historicoListar(empresa.id), [evento]);
    assert.deepEqual(auditoria, [evento]);

    injecao.exec('DROP TRIGGER falhar_desfazer');
    const respostas = await Promise.all([desfazer(), desfazer()]);
    assert.deepEqual(respostas.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await store.reservaObter(empresa.id, criada.id)).status, 'cancelada');
    assert.equal(auditoria.filter((ev) => ev.acao === 'desfeita').length, 1);
  } finally {
    injecao.close();
  }
});
