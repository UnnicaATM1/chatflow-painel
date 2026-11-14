'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { criarStore, addEmpresa } = require('../src/store');
const { criarServidor } = require('../src/api');

const T = { chat: 'tc', cliente: 'tcl', integracao: 'ti' };

async function subir() {
  const s = criarStore();
  addEmpresa(s, {
    id: 'empresa_1', nome: 'empresa_1',
    ambientes: [{ nome: 'salao', mesas: [{ id: 'S1', capacidade: 4, reservavel: true }] }],
    agente: { descricao: 'd', personalidade: '', habilidades: '', produtos: '', restricoes: 'r', editavelPor: { nome: ['cliente', 'integracao'], descricao: ['cliente', 'integracao'], personalidade: ['cliente', 'integracao'], restricoes: ['cliente', 'integracao'] } },
  });
  const srv = criarServidor(s, T, { adminSenha: 'senha-de-teste' });
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
  assert.strictEqual((await f('/empresas/empresa_1/agente')).status, 401);
  assert.strictEqual((await f('/empresas/empresa_1/agente', { token: 'errado' })).status, 401);
  fechar();
});

test('chat lê o bloco inteiro e empresa inexistente dá 404', async () => {
  const { f, fechar } = await subir();
  const r = await f('/empresas/empresa_1/agente', { token: T.chat });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(Object.keys(await r.json()), ['nome', 'descricao', 'personalidade', 'habilidades', 'produtos', 'restricoes']);
  assert.strictEqual((await f('/empresas/X/agente', { token: T.chat })).status, 404);
  fechar();
});

test('reserva idempotente via Idempotency-Key, alternativa e validação', async () => {
  const { f, fechar } = await subir();
  const a = await f('/empresas/empresa_1/reservas', { token: T.chat, method: 'POST', body: res, headers: { 'Idempotency-Key': 'k1' } });
  const b = await f('/empresas/empresa_1/reservas', { token: T.chat, method: 'POST', body: res, headers: { 'Idempotency-Key': 'k1' } });
  assert.strictEqual(a.status, 201);
  assert.deepStrictEqual(await a.json(), await b.json());
  const c = await f('/empresas/empresa_1/reservas', { token: T.chat, method: 'POST', body: res, headers: { 'Idempotency-Key': 'k2' } });
  assert.strictEqual(c.status, 200);
  assert.strictEqual((await c.json()).status, 'indisponivel');
  assert.strictEqual((await f('/empresas/empresa_1/reservas', { token: T.chat, method: 'POST', body: res })).status, 400);
  assert.strictEqual((await f('/empresas/empresa_1/reservas', { token: T.chat, method: 'POST', body: { ...res, pessoas: 0 }, headers: { 'Idempotency-Key': 'k3' } })).status, 400);
  fechar();
});

test('edição e mapa só para staff, com permissão por campo', async () => {
  const { f, fechar } = await subir();
  const patch = (token, campo, valor) => f('/empresas/empresa_1/agente', { token, method: 'PATCH', body: { campo, valor } });
  assert.strictEqual((await patch(T.chat, 'descricao', 'x')).status, 403);
  assert.strictEqual((await patch(T.cliente, 'descricao', 'novo')).status, 200);
  assert.strictEqual((await patch(T.cliente, 'produtos', 'x')).status, 403);
  assert.strictEqual((await patch(T.integracao, 'produtos', 'x')).status, 200);
  assert.strictEqual((await patch(T.cliente, 'restricoes', 'Sem reservas acima de 12')).status, 200);
  const q = '/empresas/empresa_1/mapa?data=2026-11-20&horario=20:00';
  assert.strictEqual((await f(q, { token: T.chat })).status, 403);
  assert.strictEqual((await f(q, { token: T.cliente })).status, 200);
  fechar();
});

test('listagens, estrutura, edição de mesa e front estático', async () => {
  const { f, fechar } = await subir();
  assert.strictEqual((await f('/empresas', { token: T.chat })).status, 403);
  assert.deepStrictEqual(await (await f('/empresas', { token: T.cliente })).json(), [{ id: 'empresa_1', nome: 'empresa_1' }]);
  await f('/empresas/empresa_1/reservas', { token: T.chat, method: 'POST', body: res, headers: { 'Idempotency-Key': 'a' } });
  const lista = await (await f('/empresas/empresa_1/reservas?data=2026-11-20', { token: T.cliente })).json();
  assert.strictEqual(lista.length, 1);
  assert.strictEqual(lista[0].mesaId, 'S1');
  assert.strictEqual((await f('/empresas/empresa_1/estrutura', { token: T.cliente })).status, 200);
  const patch = (corpo, id = 'S1', token = T.cliente) => f(`/empresas/empresa_1/mesas/${id}`, { token, method: 'PATCH', body: corpo });
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
  const q = '/empresas/empresa_1/disponibilidade?data=2026-11-20&horario=20:00&pessoas=2';
  const antes = await (await f(q, { token: T.chat })).json();
  assert.deepStrictEqual(antes.ambientes, [{ ambiente: 'salao', mesas: [{ id: 'S1', capacidade: 4 }] }]);
  const post = (mesaId, chave) => f('/empresas/empresa_1/reservas', { token: T.chat, method: 'POST', body: { ...res, mesaId }, headers: { 'Idempotency-Key': chave } });
  assert.strictEqual((await post('S1', 'm1')).status, 201);
  const depois = await (await f(q, { token: T.chat })).json();
  assert.deepStrictEqual(depois.ambientes, [{ ambiente: 'salao', mesas: [] }]);
  const bate = await (await post('S1', 'm2')).json();
  assert.strictEqual(bate.status, 'indisponivel');
  assert.deepStrictEqual(bate.disponibilidade, depois.ambientes);
  assert.strictEqual((await f('/empresas/empresa_1/disponibilidade?data=2026-11-20&horario=20:00', { token: T.chat })).status, 400);
  assert.strictEqual((await f(q)).status, 401);
  fechar();
});

test('editar, cancelar e reativar reserva', async () => {
  const { f, fechar } = await subir();
  const post = (chave, extra = {}) => f('/empresas/empresa_1/reservas', { token: T.chat, method: 'POST', body: { ...res, ...extra }, headers: { 'Idempotency-Key': chave } });
  const a = await (await post('a')).json();
  const id = a.reservaId;
  const patch = (corpo, token = T.cliente) => f(`/empresas/empresa_1/reservas/${id}`, { token, method: 'PATCH', body: corpo });
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
  assert.strictEqual((await f(`/empresas/empresa_1/reservas/${id}`, { token: T.cliente, method: 'DELETE' })).status, 200);
  const disp = await (await f('/empresas/empresa_1/disponibilidade?data=2026-11-20&horario=22:00&pessoas=2', { token: T.chat })).json();
  assert.strictEqual(disp.ambientes.flatMap((x) => x.mesas).length, 1);
  assert.strictEqual((await patch({ pessoas: 2 })).status, 409);
  assert.strictEqual((await (await post('b', { horario: '22:00' })).json()).status, 'confirmada');
  assert.strictEqual((await patch({ status: 'confirmada' })).status, 409);
  assert.strictEqual((await f('/empresas/empresa_1/reservas/999', { token: T.cliente, method: 'DELETE' })).status, 404);
  fechar();
});

test('histórico registra quem, quando, antes e depois; desfazer volta o estado', async () => {
  const { f, fechar } = await subir();
  const op = { 'X-Operador': encodeURIComponent('Marina Souza') };
  const hist = async (q = '') => (await (await f('/empresas/empresa_1/historico' + q, { token: T.cliente })).json());
  const c = await (await f('/empresas/empresa_1/reservas', { token: T.chat, method: 'POST', body: res, headers: { 'Idempotency-Key': 'h1' } })).json();
  await f('/empresas/empresa_1/reservas', { token: T.chat, method: 'POST', body: res, headers: { 'Idempotency-Key': 'h1' } }); // reenvio não duplica evento
  const id = c.reservaId;
  const patch = (corpo) => f(`/empresas/empresa_1/reservas/${id}`, { token: T.cliente, method: 'PATCH', body: corpo, headers: op });
  await patch({ pessoas: 3 });
  await f(`/empresas/empresa_1/reservas/${id}`, { token: T.integracao, method: 'DELETE' });
  await patch({ status: 'confirmada' });
  await f('/empresas/empresa_1/mesas/S1', { token: T.cliente, method: 'PATCH', body: { capacidade: 6 }, headers: op });
  await f('/empresas/empresa_1/agente', { token: T.cliente, method: 'PATCH', body: { campos: { descricao: 'nova' } }, headers: op });

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
  assert.strictEqual((await f('/empresas/empresa_1/historico', { token: T.chat })).status, 403);

  // desfazer: conflito no mesmo campo é recusado; mudanças independentes podem ser desfeitas
  const des = (seq) => f(`/empresas/empresa_1/historico/${seq}/desfazer`, { token: T.cliente, method: 'POST', headers: op });
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
  const lista = await (await f('/empresas/empresa_1/reservas', { token: T.cliente })).json();
  assert.strictEqual(lista[0].status, 'cancelada');
  assert.strictEqual(lista[0].pessoas, 2);
  assert.strictEqual((await des(9999)).status, 404);

  // sem rota para apagar ou alterar eventos
  assert.strictEqual((await f(`/empresas/empresa_1/historico/${criada.seq}`, { token: T.integracao, method: 'DELETE' })).status, 404);
  fechar();
});

test('agente: limites de caracteres e salvar vários campos de uma vez', async () => {
  const { f, fechar } = await subir();
  const put = (campos, token = T.cliente) => f('/empresas/empresa_1/agente', { token, method: 'PATCH', body: { campos } });
  const ler = async () => (await f('/empresas/empresa_1/agente', { token: T.chat })).json();
  // tudo de uma vez, nos limites exatos
  const ok = await put({ descricao: 'a'.repeat(1000), personalidade: 'p'.repeat(2000), restricoes: 'r'.repeat(2000) });
  assert.strictEqual(ok.status, 200);
  const cfg = await ler();
  assert.strictEqual(cfg.descricao.length, 1000);
  assert.strictEqual(cfg.personalidade.length, 2000);
  // 1 caractere acima: 400, e nada é gravado (tudo ou nada)
  assert.strictEqual((await put({ descricao: 'novo', personalidade: 'p'.repeat(2001) })).status, 400);
  assert.strictEqual((await ler()).descricao.length, 1000);
  assert.strictEqual((await put({ descricao: 'a'.repeat(1001) })).status, 400);
  assert.strictEqual((await put({ restricoes: 'r'.repeat(2001) })).status, 400);
  // um campo sem permissão derruba o lote inteiro
  assert.strictEqual((await put({ descricao: 'zzz', produtos: 'x' })).status, 403);
  assert.strictEqual((await ler()).descricao.length, 1000);
  // tipo e campo inválidos
  assert.strictEqual((await put({ descricao: ['x'] })).status, 400);
  assert.strictEqual((await put({ inexistente: 'x' })).status, 400);
  assert.strictEqual((await put({})).status, 400);
  // 22.000 em habilidades e produtos (integração)
  const grande = await put({ habilidades: 'h'.repeat(22000), produtos: 'p'.repeat(22000) }, T.integracao);
  assert.strictEqual(grande.status, 200);
  assert.strictEqual((await put({ habilidades: 'h'.repeat(22001) }, T.integracao)).status, 400);
  assert.strictEqual((await ler()).habilidades.length, 22000);
  // histórico: um evento por campo alterado
  const h = await (await f('/empresas/empresa_1/historico?entidade=agente', { token: T.cliente })).json();
  assert.deepStrictEqual(h.map((e) => e.entidadeId).sort(), ['descricao', 'habilidades', 'personalidade', 'produtos', 'restricoes']);
  fechar();
});

test('nome do agente e renomear empresa', async () => {
  const { f, fechar } = await subir();
  const put = (campos) => f('/empresas/empresa_1/agente', { token: T.cliente, method: 'PATCH', body: { campos } });
  assert.strictEqual((await put({ nome: 'Nico', descricao: 'd' })).status, 200);
  assert.strictEqual((await (await f('/empresas/empresa_1/agente', { token: T.chat })).json()).nome, 'Nico');
  assert.strictEqual((await put({ nome: 'n'.repeat(101) })).status, 400);
  const ren = (token, nome) => f('/empresas/empresa_1', { token, method: 'PATCH', body: { nome } });
  assert.strictEqual((await ren(T.chat, 'X')).status, 403);
  assert.strictEqual((await ren(T.cliente, '   ')).status, 400);
  assert.strictEqual((await ren(T.cliente, 'x'.repeat(61))).status, 400);
  const ok = await ren(T.cliente, '  Cantina Central ');
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(await ok.json(), { id: 'empresa_1', nome: 'Cantina Central' });
  assert.deepStrictEqual(await (await f('/empresas', { token: T.cliente })).json(), [{ id: 'empresa_1', nome: 'Cantina Central' }]);
  assert.strictEqual((await f('/empresas/XX', { token: T.cliente, method: 'PATCH', body: { nome: 'a' } })).status, 404);
  const h = await (await f('/empresas/empresa_1/historico?entidade=empresa', { token: T.cliente })).json();
  assert.deepStrictEqual([h[0].antes, h[0].depois], [{ nome: 'empresa_1' }, { nome: 'Cantina Central' }]);
  fechar();
});

test('adicionar empresas, ambientes e mesas; cada empresa com a sua chave de API', async () => {
  const { f, fechar } = await subir();
  const post = (caminho, corpo, token = T.cliente, headers = {}) => f(caminho, { token, method: 'POST', body: corpo, headers });
  // criar empresa
  assert.strictEqual((await post('/empresas', { nome: 'X' }, T.chat)).status, 403);
  assert.strictEqual((await post('/empresas', { nome: '  ' })).status, 400);
  assert.strictEqual((await post('/empresas', { nome: 'EMPRESA_1' })).status, 409); // já existe "empresa_1" (sem diferenciar maiúsculas)
  const nova = await post('/empresas', { nome: 'Cantina Norte' });
  assert.strictEqual(nova.status, 201);
  const { id } = await nova.json();
  assert.strictEqual((await (await f('/empresas', { token: T.cliente })).json()).length, 2);
  const cfg = await (await f(`/empresas/${id}/agente`, { token: T.cliente })).json();
  assert.deepStrictEqual(cfg, { nome: '', descricao: '', personalidade: '', habilidades: '', produtos: '', restricoes: '' });
  // ambientes e mesas
  assert.strictEqual((await post(`/empresas/${id}/ambientes`, { nome: 'Salão' }, T.chat)).status, 403);
  assert.strictEqual((await post(`/empresas/${id}/ambientes`, { nome: '' })).status, 400);
  assert.strictEqual((await post(`/empresas/${id}/ambientes`, { nome: 'Salão' })).status, 201);
  assert.strictEqual((await post(`/empresas/${id}/ambientes`, { nome: 'salão' })).status, 409);
  assert.strictEqual((await post(`/empresas/${id}/mesas`, { ambiente: 'Varanda', capacidade: 4 })).status, 404);
  assert.strictEqual((await post(`/empresas/${id}/mesas`, { ambiente: 'Salão', capacidade: 0 })).status, 400);
  const m1 = await (await post(`/empresas/${id}/mesas`, { ambiente: 'Salão', capacidade: 4 })).json();
  const m2 = await (await post(`/empresas/${id}/mesas`, { ambiente: 'Salão', capacidade: 2 })).json();
  assert.deepStrictEqual([m1.id, m2.id], ['S1', 'S2']);

  // chave de API: só integração gera; aparece uma vez; só o hash fica
  assert.strictEqual((await post(`/empresas/${id}/api/chave`, {}, T.cliente)).status, 403);
  assert.strictEqual((await f(`/empresas/${id}/api`, { token: T.cliente })).status, 403);
  assert.deepStrictEqual(await (await f(`/empresas/${id}/api`, { token: T.integracao })).json(), { ativa: false, prefixo: null, criadaEm: null });
  const g = await post(`/empresas/${id}/api/chave`, {}, T.integracao);
  assert.strictEqual(g.status, 201);
  const k = await g.json();
  assert.match(k.chave, /^k1_[A-Za-z0-9_-]{43}$/);
  const status = await (await f(`/empresas/${id}/api`, { token: T.integracao })).json();
  assert.strictEqual(status.ativa, true);
  assert.ok(!JSON.stringify(status).includes(k.chave));

  // a chave da empresa funciona na empresa dela...
  const agenda = { data: '2026-11-20', horario: '20:00', pessoas: 2 };
  assert.strictEqual((await f(`/empresas/${id}/agente`, { token: k.chave })).status, 200);
  assert.strictEqual((await f(`/empresas/${id}/disponibilidade?data=2026-11-20&horario=20:00&pessoas=2`, { token: k.chave })).status, 200);
  const r = await post(`/empresas/${id}/reservas`, { ...agenda, mesaId: 'S2' }, k.chave, { 'Idempotency-Key': 'n1' });
  assert.strictEqual(r.status, 201);
  assert.strictEqual((await r.json()).mesa, 'S2');
  // ...e em nenhuma outra, nem nas rotas de equipe
  assert.strictEqual((await f('/empresas/empresa_1/agente', { token: k.chave })).status, 403);
  assert.strictEqual((await post('/empresas/empresa_1/reservas', { ...res }, k.chave, { 'Idempotency-Key': 'n2' })).status, 403);
  assert.strictEqual((await f('/empresas', { token: k.chave })).status, 403);
  assert.strictEqual((await f(`/empresas/${id}/reservas`, { token: k.chave })).status, 403);
  assert.strictEqual((await f(`/empresas/${id}/historico`, { token: k.chave })).status, 403);
  assert.strictEqual((await post(`/empresas/${id}/api/chave`, {}, k.chave)).status, 403);

  // girar a chave invalida a anterior; revogar derruba a nova
  const k2 = await (await post(`/empresas/${id}/api/chave`, {}, T.integracao)).json();
  assert.strictEqual((await f(`/empresas/${id}/agente`, { token: k.chave })).status, 401);
  assert.strictEqual((await f(`/empresas/${id}/agente`, { token: k2.chave })).status, 200);
  assert.strictEqual((await f(`/empresas/${id}/api/chave`, { token: T.integracao, method: 'DELETE' })).status, 200);
  assert.strictEqual((await f(`/empresas/${id}/agente`, { token: k2.chave })).status, 401);

  // histórico: criação, quem pediu, e nenhum segredo gravado
  const h = await (await f(`/empresas/${id}/historico`, { token: T.cliente })).json();
  assert.deepStrictEqual(h.map((e) => e.acao).reverse(), ['criada', 'criada', 'criada', 'criada', 'chave_gerada', 'criada', 'chave_gerada', 'chave_revogada']);
  assert.ok(!JSON.stringify(h).includes(k.chave) && !JSON.stringify(h).includes(k2.chave));
  assert.strictEqual(h.find((e) => e.acao === 'chave_gerada').papel, 'integracao');
  fechar();
});

test('excluir empresa exige a senha do administrador e deixa registro', async () => {
  const { f, fechar } = await subir();
  const post = (caminho, corpo, token = T.cliente) => f(caminho, { token, method: 'POST', body: corpo, headers: { 'X-Operador': encodeURIComponent('Marina') } });
  const { id } = await (await post('/empresas', { nome: 'Cantina Sul' })).json();
  await post(`/empresas/${id}/ambientes`, { nome: 'Salão' });
  await post(`/empresas/${id}/mesas`, { ambiente: 'Salão', capacidade: 4 });
  const k = await (await post(`/empresas/${id}/api/chave`, {}, T.integracao)).json();
  const rr = await post(`/empresas/${id}/reservas`, { data: '2026-11-20', horario: '20:00', pessoas: 2 }, k.chave);
  assert.strictEqual(rr.status, 400); // sem Idempotency-Key
  const ok = await f(`/empresas/${id}/reservas`, { token: k.chave, method: 'POST', body: { data: '2026-11-20', horario: '20:00', pessoas: 2 }, headers: { 'Idempotency-Key': 'x1' } });
  assert.strictEqual(ok.status, 201);
  const excluir = (corpo, token = T.cliente) => post(`/empresas/${id}/excluir`, corpo, token);

  // sem permissão, sem senha, senha errada, nome errado
  assert.strictEqual((await excluir({ senha: 'senha-de-teste', confirmarNome: 'Cantina Sul' }, T.chat)).status, 403);
  assert.strictEqual((await excluir({ confirmarNome: 'Cantina Sul' })).status, 403);
  assert.strictEqual((await excluir({ senha: 'errada', confirmarNome: 'Cantina Sul' })).status, 403);
  assert.strictEqual((await excluir({ senha: 'senha-de-teste', confirmarNome: 'cantina' })).status, 400);
  assert.strictEqual((await f('/empresas', { token: T.cliente }).then((r) => r.json())).length, 2); // nada foi apagado

  // a chave da própria empresa não consegue excluir
  assert.strictEqual((await excluir({ senha: 'senha-de-teste', confirmarNome: 'Cantina Sul' }, k.chave)).status, 403);

  // senha certa: exclui tudo
  const del = await excluir({ senha: 'senha-de-teste', confirmarNome: 'Cantina Sul' });
  assert.strictEqual(del.status, 200);
  assert.deepStrictEqual((await f('/empresas', { token: T.cliente }).then((r) => r.json())).map((l) => l.id), ['empresa_1']);
  assert.strictEqual((await f(`/empresas/${id}/agente`, { token: k.chave })).status, 401); // chave morreu junto
  assert.strictEqual((await f(`/empresas/${id}/agente`, { token: T.cliente })).status, 404);
  assert.strictEqual((await f(`/empresas/${id}/historico`, { token: T.cliente })).status, 404);

  // as outras empresas seguem intactas e ids de reserva não colidem
  const n1 = await (await f('/empresas/empresa_1/reservas', { token: T.cliente, method: 'POST', body: res, headers: { 'Idempotency-Key': 'y1' } })).json();
  const n2 = await (await f('/empresas/empresa_1/reservas', { token: T.cliente, method: 'POST', body: { ...res, horario: '23:00' }, headers: { 'Idempotency-Key': 'y2' } })).json();
  assert.notStrictEqual(n1.reservaId, n2.reservaId);
  assert.ok(n1.reservaId > 1);

  // o id da empresa excluída não é reaproveitado
  const outra = await (await post('/empresas', { nome: 'Cantina Leste' })).json();
  assert.notStrictEqual(outra.id, id);

  // registro: tentativas negadas e exclusão com instantâneo; nada do segredo
  const lista = await (await f('/historico/excluidas', { token: T.cliente })).json();
  assert.strictEqual(lista.length, 1);
  assert.deepStrictEqual([lista[0].nome, lista[0].empresaId, lista[0].reservas, lista[0].ambientes, lista[0].mesas, lista[0].operador], ['Cantina Sul', id, 1, 1, 1, 'Marina']);
  assert.strictEqual((await f('/historico/excluidas', { token: T.chat })).status, 403);
  assert.strictEqual((await f('/historico/excluidas', { token: k.chave })).status, 401); // a chave morreu com a empresa
  fechar();
});

test('excluir empresa: bloqueio após erros de senha e desativado sem senha configurada', async () => {
  const { f, fechar } = await subir();
  const tentar = (senha) => f('/empresas/empresa_1/excluir', { token: T.cliente, method: 'POST', body: { senha, confirmarNome: 'empresa_1' } });
  for (let i = 0; i < 5; i++) assert.strictEqual((await tentar('errada' + i)).status, 403);
  assert.strictEqual((await tentar('senha-de-teste')).status, 429); // mesmo a senha certa é recusada durante o bloqueio
  assert.strictEqual((await f('/empresas', { token: T.cliente }).then((r) => r.json())).length, 1);
  fechar();

  // servidor sem senha de administrador: exclusão desativada
  const s = criarStore();
  addEmpresa(s, { id: 'empresa_1', nome: 'empresa_1', ambientes: [], agente: {} });
  const srv = criarServidor(s, T);
  await new Promise((r) => srv.listen(0, r));
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/empresas/empresa_1/excluir`, {
    method: 'POST', headers: { Authorization: `Bearer ${T.cliente}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ senha: '', confirmarNome: 'empresa_1' }),
  });
  assert.strictEqual(r.status, 503);
  assert.strictEqual(s.empresas.size, 1);
  srv.close();
});
