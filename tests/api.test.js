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

test('disponibilidade por ambiente e reserva em mesa escolhida', async () => {
  const { f, fechar } = await subir();
  const q = '/lojas/L1/disponibilidade?data=2026-11-20&horario=20:00&pessoas=2';
  const antes = await (await f(q, { token: T.chat })).json();
  assert.deepStrictEqual(antes.ambientes, [{ ambiente: 'salao', mesas: [{ id: 'S1', capacidade: 4 }] }]);
  const post = (mesaId, chave) => f('/lojas/L1/reservas', { token: T.chat, method: 'POST', body: { ...res, mesaId }, headers: { 'Idempotency-Key': chave } });
  assert.strictEqual((await post('S1', 'm1')).status, 201);
  const depois = await (await f(q, { token: T.chat })).json();
  assert.deepStrictEqual(depois.ambientes, [{ ambiente: 'salao', mesas: [] }]);
  const bate = await (await post('S1', 'm2')).json();
  assert.strictEqual(bate.status, 'indisponivel');
  assert.deepStrictEqual(bate.disponibilidade, depois.ambientes);
  assert.strictEqual((await f('/lojas/L1/disponibilidade?data=2026-11-20&horario=20:00', { token: T.chat })).status, 400);
  assert.strictEqual((await f(q)).status, 401);
  fechar();
});

test('editar, cancelar e reativar reserva', async () => {
  const { f, fechar } = await subir();
  const post = (chave, extra = {}) => f('/lojas/L1/reservas', { token: T.chat, method: 'POST', body: { ...res, ...extra }, headers: { 'Idempotency-Key': chave } });
  const a = await (await post('a')).json();
  const id = a.reservaId;
  const patch = (corpo, token = T.cliente) => f(`/lojas/L1/reservas/${id}`, { token, method: 'PATCH', body: corpo });
  // adicionar e retirar pessoas (mesa de 4)
  assert.strictEqual((await (await patch({ pessoas: 4 })).json()).reserva.pessoas, 4);
  assert.strictEqual((await (await patch({ pessoas: 1 })).json()).reserva.pessoas, 1);
  // acima da capacidade: 409 com disponibilidade
  const estouro = await patch({ pessoas: 5 });
  assert.strictEqual(estouro.status, 409);
  assert.strictEqual((await estouro.json()).status, 'indisponivel');
  assert.strictEqual((await patch({ pessoas: 0 })).status, 400);
  // mudar horário e mesa
  assert.strictEqual((await (await patch({ horario: '22:00' })).json()).reserva.horario, '22:00');
  assert.strictEqual((await patch({ mesaId: 'XX' })).status, 409);
  // permissão
  assert.strictEqual((await patch({ pessoas: 2 }, T.chat)).status, 403);
  // cancelar libera a mesa; cancelada não edita; reativar confere conflito
  assert.strictEqual((await f(`/lojas/L1/reservas/${id}`, { token: T.cliente, method: 'DELETE' })).status, 200);
  const disp = await (await f('/lojas/L1/disponibilidade?data=2026-11-20&horario=22:00&pessoas=2', { token: T.chat })).json();
  assert.strictEqual(disp.ambientes.flatMap((x) => x.mesas).length, 1);
  assert.strictEqual((await patch({ pessoas: 2 })).status, 409);
  assert.strictEqual((await (await post('b', { horario: '22:00' })).json()).status, 'confirmada');
  assert.strictEqual((await patch({ status: 'confirmada' })).status, 409);
  assert.strictEqual((await f('/lojas/L1/reservas/999', { token: T.cliente, method: 'DELETE' })).status, 404);
  fechar();
});

test('histórico registra quem, quando, antes e depois; desfazer volta o estado', async () => {
  const { f, fechar } = await subir();
  const op = { 'X-Operador': encodeURIComponent('Marina Souza') };
  const hist = async (q = '') => (await (await f('/lojas/L1/historico' + q, { token: T.cliente })).json());
  const c = await (await f('/lojas/L1/reservas', { token: T.chat, method: 'POST', body: res, headers: { 'Idempotency-Key': 'h1' } })).json();
  await f('/lojas/L1/reservas', { token: T.chat, method: 'POST', body: res, headers: { 'Idempotency-Key': 'h1' } }); // reenvio não duplica evento
  const id = c.reservaId;
  const patch = (corpo) => f(`/lojas/L1/reservas/${id}`, { token: T.cliente, method: 'PATCH', body: corpo, headers: op });
  await patch({ pessoas: 3 });
  await f(`/lojas/L1/reservas/${id}`, { token: T.integracao, method: 'DELETE' });
  await patch({ status: 'confirmada' });
  await f('/lojas/L1/mesas/S1', { token: T.cliente, method: 'PATCH', body: { capacidade: 6 }, headers: op });
  await f('/lojas/L1/agente', { token: T.cliente, method: 'PATCH', body: { campo: 'descricao', valor: 'nova' }, headers: op });

  const todos = await hist();
  assert.deepStrictEqual(todos.map((e) => e.acao).reverse(), ['criada', 'editada', 'cancelada', 'reativada', 'editada', 'editada']);
  assert.deepStrictEqual(todos.map((e) => e.entidade).reverse(), ['reserva', 'reserva', 'reserva', 'reserva', 'mesa', 'agente']);
  const criada = todos[todos.length - 1];
  assert.strictEqual(criada.papel, 'chat');
  assert.strictEqual(criada.operador, null);
  assert.ok(!Number.isNaN(Date.parse(criada.quando)));
  const edit = todos.find((e) => e.entidade === 'reserva' && e.acao === 'editada');
  assert.deepStrictEqual(edit.antes, { pessoas: 2 });
  assert.deepStrictEqual(edit.depois, { pessoas: 3 });
  assert.strictEqual(edit.operador, 'Marina Souza');
  assert.strictEqual(todos.find((e) => e.acao === 'cancelada').papel, 'integracao');
  assert.strictEqual((await hist(`?entidade=reserva&id=${id}`)).length, 4);

  // chat não lê o histórico
  assert.strictEqual((await f('/lojas/L1/historico', { token: T.chat })).status, 403);

  // desfazer: conflito no mesmo campo é recusado; mudanças independentes podem ser desfeitas
  const des = (seq) => f(`/lojas/L1/historico/${seq}/desfazer`, { token: T.cliente, method: 'POST', headers: op });
  const seqEdit = todos.find((e) => e.entidade === 'reserva' && e.acao === 'editada').seq; // pessoas 2 -> 3
  await patch({ pessoas: 4 });
  assert.strictEqual((await des(seqEdit)).status, 409); // pessoas mudou depois
  const ultima = (await hist(`?entidade=reserva&id=${id}`))[0];
  assert.deepStrictEqual(ultima.depois, { pessoas: 4 });
  assert.strictEqual((await des(ultima.seq)).status, 200); // volta a 3
  assert.strictEqual((await des(seqEdit)).status, 200); // volta a 2
  const reativ = todos.find((e) => e.acao === 'reativada');
  assert.strictEqual((await des(reativ.seq)).status, 200); // volta a cancelada
  assert.strictEqual((await des(reativ.seq)).status, 409); // já foi desfeito
  const desf = (await hist(`?entidade=reserva&id=${id}`))[0];
  assert.strictEqual(desf.acao, 'desfeita');
  assert.strictEqual(desf.refSeq, reativ.seq);
  assert.strictEqual(desf.operador, 'Marina Souza');
  const lista = await (await f('/lojas/L1/reservas', { token: T.cliente })).json();
  assert.strictEqual(lista[0].status, 'cancelada');
  assert.strictEqual(lista[0].pessoas, 2);
  assert.strictEqual((await des(9999)).status, 404);

  // sem rota para apagar ou alterar eventos
  assert.strictEqual((await f(`/lojas/L1/historico/${criada.seq}`, { token: T.integracao, method: 'DELETE' })).status, 404);
  fechar();
});
