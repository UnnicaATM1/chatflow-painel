'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { criarStore, addLoja } = require('../src/store');
const { criarServidor } = require('../src/api');

const T = { chat: 'tc', cliente: 'tcl', integracao: 'ti' };

async function subir() {
  const s = criarStore();
  addLoja(s, {
    id: 'L1', nome: 'L1',
    ambientes: [{ nome: 'salao', mesas: [{ id: 'S1', capacidade: 4, reservavel: true }] }],
    agente: { descricao: 'd', habilidades: [], produtos: [], restricoes: ['r'], editavelPor: { descricao: ['cliente', 'integracao'] } },
  });
  const srv = criarServidor(s, T);
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const f = (path, { token, method = 'GET', body, headers = {} } = {}) =>
    fetch(base + path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  return { f, fechar: () => srv.close() };
}

const res = { data: '2026-11-20', horario: '20:00', pessoas: 2, ambiente: 'salao' };

test('exige token', async () => {
  const { f, fechar } = await subir();
  assert.strictEqual((await f('/lojas/L1/agente')).status, 401);
  assert.strictEqual((await f('/lojas/L1/agente', { token: 'errado' })).status, 401);
  fechar();
});

test('chat lê o bloco inteiro e loja inexistente dá 404', async () => {
  const { f, fechar } = await subir();
  const r = await f('/lojas/L1/agente', { token: T.chat });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(Object.keys(await r.json()), ['descricao', 'habilidades', 'produtos', 'restricoes']);
  assert.strictEqual((await f('/lojas/X/agente', { token: T.chat })).status, 404);
  fechar();
});

test('reserva idempotente via Idempotency-Key, alternativa e validação', async () => {
  const { f, fechar } = await subir();
  const a = await f('/lojas/L1/reservas', { token: T.chat, method: 'POST', body: res, headers: { 'Idempotency-Key': 'k1' } });
  const b = await f('/lojas/L1/reservas', { token: T.chat, method: 'POST', body: res, headers: { 'Idempotency-Key': 'k1' } });
  assert.strictEqual(a.status, 201);
  assert.deepStrictEqual(await a.json(), await b.json());
  const c = await f('/lojas/L1/reservas', { token: T.chat, method: 'POST', body: res, headers: { 'Idempotency-Key': 'k2' } });
  assert.strictEqual(c.status, 200);
  assert.strictEqual((await c.json()).status, 'indisponivel');
  assert.strictEqual((await f('/lojas/L1/reservas', { token: T.chat, method: 'POST', body: res })).status, 400);
  assert.strictEqual((await f('/lojas/L1/reservas', { token: T.chat, method: 'POST', body: { ...res, pessoas: 0 }, headers: { 'Idempotency-Key': 'k3' } })).status, 400);
  fechar();
});

test('edição e mapa só para staff, com permissão por campo', async () => {
  const { f, fechar } = await subir();
  const patch = (token, campo, valor) => f('/lojas/L1/agente', { token, method: 'PATCH', body: { campo, valor } });
  assert.strictEqual((await patch(T.chat, 'descricao', 'x')).status, 403);
  assert.strictEqual((await patch(T.cliente, 'descricao', 'novo')).status, 200);
  assert.strictEqual((await patch(T.cliente, 'restricoes', [])).status, 403);
  assert.strictEqual((await patch(T.integracao, 'restricoes', [])).status, 200);
  const q = '/lojas/L1/mapa?data=2026-11-20&horario=20:00';
  assert.strictEqual((await f(q, { token: T.chat })).status, 403);
  assert.strictEqual((await f(q, { token: T.cliente })).status, 200);
  fechar();
});

test('listagens, estrutura, edição de mesa e front estático', async () => {
  const { f, fechar } = await subir();
  assert.strictEqual((await f('/lojas', { token: T.chat })).status, 403);
  assert.deepStrictEqual(await (await f('/lojas', { token: T.cliente })).json(), [{ id: 'L1', nome: 'L1' }]);
  await f('/lojas/L1/reservas', { token: T.chat, method: 'POST', body: res, headers: { 'Idempotency-Key': 'a' } });
  const lista = await (await f('/lojas/L1/reservas?data=2026-11-20', { token: T.cliente })).json();
  assert.strictEqual(lista.length, 1);
  assert.strictEqual(lista[0].mesaId, 'S1');
  assert.strictEqual((await f('/lojas/L1/estrutura', { token: T.cliente })).status, 200);
  const patch = (corpo, id = 'S1', token = T.cliente) => f(`/lojas/L1/mesas/${id}`, { token, method: 'PATCH', body: corpo });
  assert.strictEqual((await patch({ capacidade: 6 })).status, 200);
  assert.strictEqual((await patch({ capacidade: 0 })).status, 400);
  assert.strictEqual((await patch({ reservavel: 'x' })).status, 400);
  assert.strictEqual((await patch({ capacidade: 2 }, 'XX')).status, 404);
  assert.strictEqual((await patch({ capacidade: 2 }, 'S1', T.chat)).status, 403);
  assert.strictEqual((await f('/app/')).status, 200);
  assert.strictEqual((await f('/app/app.js')).status, 200);
  assert.strictEqual((await f('/app/..%2fsrc%2fapi.js')).status, 404);
  fechar();
});
