'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { abrirD1 } = require('./auxiliar/d1.cjs');
const { criarContexto, tratar } = require('../src/nucleo');

const E = 'empresa_1';
const BASE = `/empresas/${E}/reservas`;
const empresa = {
  id: E, nome: 'Cantina', agente: {},
  ambientes: [{ nome: 'Salão', mesas: ['S1', 'S2', 'S3'].map((id) => ({ id, capacidade: 4, reservavel: true })) }],
};
const dados = { mesaId: 'S1', pessoas: 2, data: '2030-01-01', horario: '20:00' };

function cliente(store) {
  const ctx = criarContexto({ store, tokens: { cliente: 'teste' } });
  return (metodo, url, corpo, chave) => tratar({
    metodo, url, headers: { authorization: 'Bearer teste', ...(chave ? { 'idempotency-key': chave } : {}) },
    corpo: corpo === undefined ? null : new TextEncoder().encode(JSON.stringify(corpo)),
  }, ctx);
}

test('D1: pedidos concorrentes em stores independentes gravam uma reserva e um evento', async (t) => {
  const d1 = await abrirD1(t);
  const store = d1.abrir();
  await store.empresaCriar(empresa);
  const respostas = await Promise.all(Array.from({ length: 16 }, (_, i) =>
    cliente(d1.abrir())('POST', BASE, dados, i < 8 ? 'mesma-chave' : `distinta-${i}`)));
  assert.ok(respostas.every((r) => [200, 201].includes(r.status)));
  for (const r of respostas.slice(0, 8)) assert.deepEqual(r.corpo, respostas[0].corpo);
  const confirmadas = respostas.filter((r) => r.status === 201);
  assert.ok(confirmadas.length > 0);
  assert.equal(new Set(confirmadas.map((r) => r.corpo.reservaId)).size, 1);
  assert.equal(await store.idempotenciaTamanho(E), 9);
  const [reserva, ...restantes] = await store.reservaListar(E);
  assert.deepEqual(restantes, []);
  const [evento, ...eventos] = await store.historicoListar(E);
  assert.deepEqual(eventos, []);
  assert.equal(evento.acao, 'criada');
  assert.equal(evento.entidadeId, reserva.id);
  assert.equal(reserva.id, confirmadas[0].corpo.reservaId);
});

test('D1: edição e reativação concorrentes disputam a mesma mesa e só a vencedora gera histórico', async (t) => {
  const d1 = await abrirD1(t);
  const store = d1.abrir();
  await store.empresaCriar(empresa);
  const chamar = cliente(store);
  const a = (await chamar('POST', BASE, dados, 'a')).corpo.reservaId;
  const b = (await chamar('POST', BASE, { ...dados, mesaId: 'S2' }, 'b')).corpo.reservaId;
  assert.equal((await chamar('DELETE', `${BASE}/${a}`)).status, 200);

  const concorrentes = await Promise.all([
    chamar('PATCH', `${BASE}/${b}`, { mesaId: 'S1' }),
    cliente(d1.abrir())('PATCH', `${BASE}/${a}`, { status: 'confirmada' }),
  ]);
  assert.deepEqual(concorrentes.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await store.reservaConfirmadas(E)).filter((r) => r.mesaId === 'S1').length, 1);
  const eventos = await store.historicoListar(E);
  assert.equal(eventos.length, 4);
  assert.equal(eventos[0].acao, concorrentes[0].status === 200 ? 'editada' : 'reativada');
});

test('D1: remover mesa e reservar simultaneamente preserva o vínculo ou impede a reserva', async (t) => {
  const d1 = await abrirD1(t);
  const store = d1.abrir();
  await store.empresaCriar(empresa);
  const remover = () => cliente(d1.abrir())('DELETE', `/empresas/${E}/mesas/S1`);
  const reservar = (chave) => cliente(d1.abrir())('POST', BASE, dados, chave);
  const [remocao, reserva] = await Promise.all([remover(), reservar('corrida')]);
  assert.deepEqual([remocao.status, reserva.status], reserva.status === 201 ? [409, 201] : [200, 200]);
  const ambiente = (await store.empresaObter(E)).ambientes[0];
  assert.equal(ambiente.mesas.some((mesa) => mesa.id === 'S1'), reserva.status === 201);
  assert.equal((await store.reservaListar(E)).length, reserva.status === 201 ? 1 : 0);
  assert.deepEqual((await store.historicoListar(E)).map((ev) => ev.acao), [reserva.status === 201 ? 'criada' : 'mesa_removida']);
});

test('D1: falha no histórico reverte criação, idempotência, edição, reativação e desfazer', async (t) => {
  const d1 = await abrirD1(t);
  const auditoria = [];
  const store = d1.abrir({ sink: (ev) => auditoria.push(ev) });
  await store.empresaCriar(empresa);
  const chamar = cliente(store);
  const falhar = (acao) => d1.DB.prepare(`CREATE TRIGGER falha_teste BEFORE INSERT ON historico
    WHEN NEW.acao = '${acao}' BEGIN SELECT RAISE(ABORT, 'falha de teste'); END`).run();
  const removerFalha = () => d1.DB.prepare('DROP TRIGGER falha_teste').run();
  await falhar('criada');
  assert.equal((await chamar('POST', BASE, dados, 'a')).status, 400);
  assert.deepEqual(await store.reservaListar(E), []);
  assert.equal(await store.idempotenciaTamanho(E), 0);
  assert.deepEqual(auditoria, []);
  await removerFalha();

  const a = (await chamar('POST', BASE, dados, 'a')).corpo.reservaId;
  const caminho = `${BASE}/${a}`;
  await falhar('editada');
  assert.equal((await chamar('PATCH', caminho, { mesaId: 'S2' })).status, 400);
  assert.equal((await store.reservaObter(E, a)).mesaId, 'S1');
  await removerFalha();

  await falhar('desfeita');
  const desfazer = () => chamar('POST', `/empresas/${E}/historico/${auditoria[0].seq}/desfazer`);
  assert.equal((await desfazer()).status, 400);
  assert.equal((await store.reservaObter(E, a)).status, 'confirmada');
  assert.equal(auditoria.length, 1);
  await removerFalha();
  assert.deepEqual((await Promise.all([desfazer(), desfazer()])).map((r) => r.status).sort(), [200, 409]);

  await falhar('reativada');
  assert.equal((await chamar('PATCH', caminho, { status: 'confirmada' })).status, 400);
  assert.equal((await store.reservaObter(E, a)).status, 'cancelada');
  assert.deepEqual((await store.historicoListar(E)).map((ev) => ev.acao), ['desfeita', 'criada']);
  assert.equal(auditoria.length, 2);
});

test('D1/R2: documento de 4 MiB persiste, troca falha sem perder a versão antiga e exclusão limpa o objeto', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'chatflow-d1-'));
  const opcoes = { d1Persist: join(dir, 'd1'), r2Persist: join(dir, 'r2') };
  let d1;
  t.after(async () => {
    await d1?.fechar();
    rmSync(dir, { recursive: true, force: true });
  });
  d1 = await abrirD1(t, opcoes);
  let store = d1.abrir();
  await store.empresaCriar(empresa);
  const bytes = Buffer.alloc(4 * 1024 * 1024, 65);
  const arquivo = { nome: 'cardapio.txt', mime: 'text/plain', tamanho: bytes.length, base64: bytes.toString('base64') };
  const { item } = await store.conhecimentoCriar(E, { tipo: 'documento', titulo: 'Cardápio', arquivo }, 10);
  const { item: linha } = await d1.DB.prepare('SELECT item FROM conhecimento').first();
  const metadados = JSON.parse(linha);
  assert.equal(metadados.arquivo.base64, undefined);
  assert.match(metadados.arquivoChave, /^empresas\/empresa_1\/conhecimento\/[a-f0-9-]{36}$/);
  assert.deepEqual((await store.conhecimentoObter(E, item.id, { incluirArquivo: false })).arquivo, metadados.arquivo);
  assert.equal(await store.conhecimentoObter('empresa_2', item.id), null);
  await d1.fechar();
  d1 = await abrirD1(t, opcoes, false);
  store = d1.abrir();
  assert.deepEqual(await store.conhecimentoObter(E, item.id), item);

  await d1.DB.prepare(`CREATE TRIGGER falha_teste BEFORE UPDATE ON conhecimento
    BEGIN SELECT RAISE(ABORT, 'falha de teste'); END`).run();
  const novo = { ...arquivo, base64: 'YWJj', tamanho: 3 };
  await assert.rejects(store.conhecimentoEditar(E, item.id, { arquivo: novo }), /falha de teste/);
  assert.equal((await d1.BUCKET.list()).objects.length, 1);
  assert.deepEqual((await store.conhecimentoObter(E, item.id)).arquivo, arquivo);
  await d1.DB.prepare('DROP TRIGGER falha_teste').run();
  assert.deepEqual((await store.conhecimentoEditar(E, item.id, { arquivo: novo })).arquivo, novo);
  assert.equal(await d1.BUCKET.get(metadados.arquivoChave), null);
  assert.equal((await d1.BUCKET.list()).objects.length, 1);
  await store.empresaExcluir(E, { empresaId: E, entidade: 'empresa', acao: 'excluida' });
  assert.equal((await d1.BUCKET.list()).objects.length, 0);
});
