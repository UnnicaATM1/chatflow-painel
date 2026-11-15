'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { criarStore, addEmpresa } = require('../src/store');
const { criarServidor } = require('../src/api');

const T = { chat: 'tc', cliente: 'tcl', integracao: 'ti' };

async function subir(opcoes = {}) {
  const s = criarStore();
  addEmpresa(s, {
    id: 'empresa_1', nome: 'empresa_1',
    ambientes: [{ nome: 'salao', mesas: [{ id: 'S1', capacidade: 4, reservavel: true }] }],
    agente: { descricao: 'd', personalidade: '', habilidades: '', produtos: '', restricoes: 'r', editavelPor: { nome: ['cliente', 'integracao'], descricao: ['cliente', 'integracao'], personalidade: ['cliente', 'integracao'], restricoes: ['cliente', 'integracao'] } },
  });
  const srv = criarServidor(s, T, { adminSenha: 'senha-de-teste', ...opcoes });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const f = (path, { token, method = 'GET', body, headers = {}, redirect } = {}) =>
    fetch(base + path, {
      method, redirect,
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
  assert.deepStrictEqual(await (await f('/empresas', { token: T.cliente })).json(), [{ id: 'empresa_1', nome: 'empresa_1', modulos: { reservas: true, conhecimento: true } }]);
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
  assert.deepStrictEqual(await ok.json(), { id: 'empresa_1', nome: 'Cantina Central', modulos: { reservas: true, conhecimento: true } });
  assert.deepStrictEqual(await (await f('/empresas', { token: T.cliente })).json(), [{ id: 'empresa_1', nome: 'Cantina Central', modulos: { reservas: true, conhecimento: true } }]);
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

test('recursos por empresa: reservas e conhecimento ligam e desligam', async () => {
  const { f, fechar } = await subir();
  const json = (caminho, metodo, corpo, token = T.cliente) => f(caminho, { token, method: metodo, body: corpo });
  // empresa sem mesas, só com conhecimento
  const criada = await json('/empresas', 'POST', { nome: 'Oficina Silva', modulos: { reservas: false } });
  assert.strictEqual(criada.status, 201);
  const { id, modulos } = await criada.json();
  assert.deepStrictEqual(modulos, { reservas: false, conhecimento: true });
  assert.strictEqual((await json('/empresas', 'POST', { nome: 'Outra', modulos: { reservas: 'sim' } })).status, 400);
  assert.strictEqual((await json('/empresas', 'POST', { nome: 'Outra2', modulos: { vendas: true } })).status, 400);

  // reservas desativado: tudo que é de mesa responde 404 claro; agente e conhecimento seguem
  const k = await (await json(`/empresas/${id}/api/chave`, 'POST', {}, T.integracao)).json();
  for (const [metodo, caminho, corpo] of [
    ['GET', `/empresas/${id}/disponibilidade?data=2026-11-20&horario=20:00&pessoas=2`],
    ['GET', `/empresas/${id}/mapa?data=2026-11-20&horario=20:00`],
    ['GET', `/empresas/${id}/reservas`],
    ['POST', `/empresas/${id}/reservas`, { data: '2026-11-20', horario: '20:00', pessoas: 2 }],
    ['POST', `/empresas/${id}/ambientes`, { nome: 'Salão' }],
    ['POST', `/empresas/${id}/mesas`, { ambiente: 'Salão', capacidade: 4 }],
  ]) {
    const r = await f(caminho, { token: metodo === 'GET' && caminho.includes('disponibilidade') ? k.chave : T.cliente, method: metodo, body: corpo, headers: { 'Idempotency-Key': 'z' } });
    assert.strictEqual(r.status, 404, `${metodo} ${caminho}`);
    assert.match((await r.json()).erro, /não habilitado/);
  }
  assert.strictEqual((await f(`/empresas/${id}/agente`, { token: k.chave })).status, 200);

  // /recursos diz ao sistema de conversa o que existe
  const rec = await (await f(`/empresas/${id}/recursos`, { token: k.chave })).json();
  assert.deepStrictEqual([rec.reservas, rec.conhecimento], [false, true]);
  assert.ok(rec.endpoints.some((e) => e.caminho === `/empresas/${id}/conhecimento`));
  assert.ok(!rec.endpoints.some((e) => e.caminho.includes('disponibilidade')));

  // ligar e desligar pela equipe (chat não pode); dados preservados
  assert.strictEqual((await json(`/empresas/${id}/modulos`, 'PATCH', { reservas: true }, T.chat)).status, 403);
  assert.strictEqual((await json(`/empresas/${id}/modulos`, 'PATCH', {})).status, 400);
  assert.strictEqual((await json(`/empresas/${id}/modulos`, 'PATCH', { reservas: 1 })).status, 400);
  assert.deepStrictEqual(await (await json(`/empresas/${id}/modulos`, 'PATCH', { reservas: true })).json(), { reservas: true, conhecimento: true });
  assert.strictEqual((await json(`/empresas/${id}/ambientes`, 'POST', { nome: 'Salão' })).status, 201);
  await json(`/empresas/${id}/modulos`, 'PATCH', { conhecimento: false });
  assert.strictEqual((await f(`/empresas/${id}/conhecimento`, { token: k.chave })).status, 404);
  assert.deepStrictEqual((await (await f('/empresas', { token: T.cliente })).json()).find((e) => e.id === id).modulos, { reservas: true, conhecimento: false });
  const est = await (await f(`/empresas/${id}/estrutura`, { token: T.cliente })).json();
  assert.strictEqual(est.ambientes.length, 1); // dados mantidos
  const h = await (await f(`/empresas/${id}/historico?entidade=empresa`, { token: T.cliente })).json();
  assert.ok(h.some((e) => e.depois.modulo_conhecimento === false && e.antes.modulo_conhecimento === true));
  fechar();
});

test('conhecimento: texto, tabela e documento lidos pelo chat', async () => {
  const { f, fechar } = await subir();
  const json = (caminho, metodo, corpo, token = T.cliente) => f(caminho, { token, method: metodo, body: corpo, headers: { 'X-Operador': encodeURIComponent('Marina') } });
  const k = await (await json('/empresas/empresa_1/api/chave', 'POST', {}, T.integracao)).json();
  const base = '/empresas/empresa_1/conhecimento';
  assert.deepStrictEqual(await (await f(base, { token: k.chave })).json(), { itens: [] });

  // texto
  const tx = await json(base, 'POST', { tipo: 'texto', titulo: 'Horário de funcionamento', texto: 'Segunda a sábado, das 8h às 18h.' });
  assert.strictEqual(tx.status, 201);
  const txt = await tx.json();
  assert.strictEqual(txt.texto, 'Segunda a sábado, das 8h às 18h.');

  // tabela de preços
  const tb = await json(base, 'POST', { tipo: 'tabela', titulo: 'Tabela de preços', tabela: { colunas: ['Serviço', 'Preço'], linhas: [['Revisão', 'R$ 250,00'], ['Troca de óleo', 120]] } });
  assert.strictEqual(tb.status, 201);
  const tabela = await tb.json();
  assert.deepStrictEqual(tabela.tabela.linhas[1], ['Troca de óleo', '120']);

  // documentos: texto é extraído; pdf fica como arquivo
  const b64 = (s) => Buffer.from(s).toString('base64');
  const dt = await (await json(base, 'POST', { tipo: 'documento', titulo: 'Regras', arquivo: { nome: 'regras.txt', base64: b64('Não aceitamos cheque.') } })).json();
  assert.strictEqual(dt.texto, 'Não aceitamos cheque.');
  assert.strictEqual(dt.arquivo.nome, 'regras.txt');
  const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('conteudo binario')]);
  const dp = await (await json(base, 'POST', { tipo: 'documento', titulo: 'Catálogo', arquivo: { nome: 'C:\\pasta\\catalogo.PDF', base64: pdfBytes.toString('base64') } })).json();
  assert.strictEqual(dp.arquivo.nome, 'catalogo.PDF');
  assert.strictEqual(dp.texto, undefined);

  // o chat lê tudo de uma vez e baixa o arquivo, com cabeçalhos seguros
  const lista = (await (await f(base, { token: k.chave })).json()).itens;
  assert.deepStrictEqual(lista.map((i) => i.tipo), ['texto', 'tabela', 'documento', 'documento']);
  const dl = await f(`${base}/${dp.id}/arquivo`, { token: k.chave });
  assert.strictEqual(dl.status, 200);
  assert.strictEqual(dl.headers.get('content-type'), 'application/pdf');
  assert.match(dl.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''catalogo\.PDF$/);
  assert.strictEqual(dl.headers.get('x-content-type-options'), 'nosniff');
  assert.deepStrictEqual(Buffer.from(await dl.arrayBuffer()), pdfBytes);
  assert.strictEqual((await f(`${base}/${txt.id}/arquivo`, { token: k.chave })).status, 404); // item sem arquivo
  assert.strictEqual((await f(`${base}/${tabela.id}`, { token: k.chave }).then((r) => r.json())).titulo, 'Tabela de preços');

  // permissões: chat só lê; outra empresa não alcança
  assert.strictEqual((await json(base, 'POST', { tipo: 'texto', titulo: 'x', texto: 'y' }, k.chave)).status, 403);
  assert.strictEqual((await json(`${base}/${txt.id}`, 'DELETE', undefined, k.chave)).status, 403);
  assert.strictEqual((await f('/empresas/empresa_2/conhecimento', { token: k.chave })).status, 403);
  assert.strictEqual((await f(base)).status, 401);

  // validações
  const ruim = async (corpo) => (await json(base, 'POST', corpo)).status;
  assert.strictEqual(await ruim({ tipo: 'video', titulo: 'x' }), 400);
  assert.strictEqual(await ruim({ tipo: 'texto', titulo: '  ', texto: 'a' }), 400);
  assert.strictEqual(await ruim({ tipo: 'texto', titulo: 'x'.repeat(121), texto: 'a' }), 400);
  assert.strictEqual(await ruim({ tipo: 'texto', titulo: 'x', texto: 'a'.repeat(50001) }), 400);
  assert.strictEqual(await ruim({ tipo: 'tabela', titulo: 'x', tabela: { colunas: [], linhas: [] } }), 400);
  assert.strictEqual(await ruim({ tipo: 'tabela', titulo: 'x', tabela: { colunas: ['a', 'b'], linhas: [['1']] } }), 400);
  assert.strictEqual(await ruim({ tipo: 'tabela', titulo: 'x', tabela: { colunas: ['a'], linhas: [['y'.repeat(501)]] } }), 400);
  assert.strictEqual(await ruim({ tipo: 'tabela', titulo: 'x', tabela: { colunas: Array(21).fill('c'), linhas: [] } }), 400);
  assert.strictEqual(await ruim({ tipo: 'documento', titulo: 'x', arquivo: { nome: 'pagina.html', base64: b64('<script>1</script>') } }), 400);
  assert.strictEqual(await ruim({ tipo: 'documento', titulo: 'x', arquivo: { nome: 'imagem.svg', base64: b64('<svg/>') } }), 400);
  assert.strictEqual(await ruim({ tipo: 'documento', titulo: 'x', arquivo: { nome: 'falso.pdf', base64: b64('isto não é pdf') } }), 400);
  assert.strictEqual(await ruim({ tipo: 'documento', titulo: 'x', arquivo: { nome: 'binario.txt', base64: Buffer.from([65, 0, 66, 67, 68, 69]).toString('base64') } }), 400);
  assert.strictEqual(await ruim({ tipo: 'documento', titulo: 'x', arquivo: { nome: 'a.txt', base64: 'não é base64!' } }), 400);
  assert.strictEqual(await ruim({ tipo: 'documento', titulo: 'x', arquivo: { nome: 'a.txt', base64: '' } }), 400);
  const grande = Buffer.alloc(4 * 1024 * 1024 + 1, 0x41).toString('base64');
  assert.strictEqual(await ruim({ tipo: 'documento', titulo: 'x', arquivo: { nome: 'grande.txt', base64: grande } }), 400);
  assert.strictEqual((await json(`${base}/999`, 'PATCH', { titulo: 'x' })).status, 404);

  // editar: parcial, tipo fixo, substituir arquivo
  const ed = await (await json(`${base}/${tabela.id}`, 'PATCH', { titulo: 'Preços 2026', tabela: { colunas: ['Serviço', 'Preço'], linhas: [['Revisão', 'R$ 280,00']] } })).json();
  assert.deepStrictEqual([ed.titulo, ed.tabela.linhas.length], ['Preços 2026', 1]);
  assert.strictEqual((await json(`${base}/${tabela.id}`, 'PATCH', { tipo: 'texto' })).status, 400);
  assert.strictEqual((await json(`${base}/${tabela.id}`, 'PATCH', {})).status, 400);
  assert.strictEqual((await json(`${base}/${tabela.id}`, 'PATCH', { texto: 'x' })).status, 400); // campo de outro tipo não conta
  const troca = await (await json(`${base}/${dt.id}`, 'PATCH', { arquivo: { nome: 'regras2.pdf', base64: pdfBytes.toString('base64') } })).json();
  assert.strictEqual(troca.texto, undefined); // pdf não tem texto extraído: o do arquivo antigo foi limpo
  assert.strictEqual(troca.arquivo.nome, 'regras2.pdf');

  // excluir
  assert.strictEqual((await json(`${base}/${txt.id}`, 'DELETE')).status, 200);
  assert.strictEqual((await f(`${base}/${txt.id}`, { token: k.chave })).status, 404);
  assert.strictEqual((await (await f(base, { token: k.chave })).json()).itens.length, 3);

  // histórico: quem mexeu, antes e depois, e nenhum byte de arquivo
  const h = await (await f('/empresas/empresa_1/historico?entidade=conhecimento', { token: T.cliente })).json();
  assert.deepStrictEqual(h.map((e) => e.acao).reverse(), ['criada', 'criada', 'criada', 'criada', 'editada', 'editada', 'excluida']);
  assert.strictEqual(h[0].antes.titulo, 'Horário de funcionamento');
  assert.strictEqual(h[0].operador, 'Marina');
  const antigo = h.find((e) => e.acao === 'editada' && e.depois.tabela);
  assert.strictEqual(antigo.antes.tabela.linhas.length, 2);
  assert.ok(!JSON.stringify(h).includes(pdfBytes.toString('base64')));
  // a exclusão de item não aparece como exclusão de empresa
  assert.deepStrictEqual(await (await f('/historico/excluidas', { token: T.cliente })).json(), []);
  fechar();
});

test('excluir empresa guarda o conhecimento no instantâneo (sem arquivos)', async () => {
  const { f, fechar } = await subir();
  const post = (caminho, corpo) => f(caminho, { token: T.cliente, method: 'POST', body: corpo });
  await post('/empresas/empresa_1/conhecimento', { tipo: 'documento', titulo: 'Doc', arquivo: { nome: 'a.pdf', base64: Buffer.from('%PDF-1.4 x').toString('base64') } });
  await post('/empresas/empresa_1/conhecimento', { tipo: 'texto', titulo: 'T', texto: 'conteúdo' });
  const r = await post('/empresas/empresa_1/excluir', { senha: 'senha-de-teste', confirmarNome: 'empresa_1' });
  assert.strictEqual(r.status, 200);
  const ev = (await (await f('/historico/excluidas', { token: T.cliente })).json())[0];
  assert.strictEqual(ev.nome, 'empresa_1');
  fechar();
});

test('contexto do agente em uma chamada, com prompt pronto', async () => {
  const { f, fechar } = await subir();
  const json = (caminho, metodo, corpo, token = T.cliente) => f(caminho, { token, method: metodo, body: corpo });
  const k = await (await json('/empresas/empresa_1/api/chave', 'POST', {}, T.integracao)).json();
  await json('/empresas/empresa_1/agente', 'PATCH', { campos: { nome: 'Nico', descricao: 'Cantina italiana.', personalidade: 'Simpático e objetivo.', habilidades: 'Responder dúvidas.', produtos: 'Massas e vinhos.', restricoes: 'Nunca prometer desconto.' } }, T.integracao);
  await json('/empresas/empresa_1/conhecimento', 'POST', { tipo: 'tabela', titulo: 'Preços', tabela: { colunas: ['Prato', 'Preço'], linhas: [['Lasanha', 'R$ 52,00'], ['Risoto | trufa', 'R$ 70,00']] } });
  await json('/empresas/empresa_1/conhecimento', 'POST', { tipo: 'texto', titulo: 'Horário', texto: 'Aberto de terça a domingo.' });
  await json('/empresas/empresa_1/conhecimento', 'POST', { tipo: 'documento', titulo: 'Cardápio', arquivo: { nome: 'cardapio.pdf', base64: Buffer.from('%PDF-1.4 x').toString('base64') } });

  const r = await f('/empresas/empresa_1/contexto', { token: k.chave });
  assert.strictEqual(r.status, 200);
  const c = await r.json();
  assert.deepStrictEqual(c.empresa, { id: 'empresa_1', nome: 'empresa_1' });
  assert.strictEqual(c.agente.nome, 'Nico');
  assert.deepStrictEqual(c.recursos, { reservas: true, conhecimento: true });
  assert.strictEqual(c.conhecimento.length, 3);
  // prompt: tem cada parte, tabela em markdown, link do documento e as regras de reserva
  for (const trecho of ['Você é Nico, atendente virtual da empresa empresa_1', 'Cantina italiana.', '## Personalidade e objetivo', 'Simpático e objetivo.',
    '## Habilidades', '## Produtos e serviços', 'Massas e vinhos.', '## Restrições', 'Nunca prometer desconto.',
    '| Prato | Preço |', '| Lasanha | R$ 52,00 |', '| Risoto / trufa | R$ 70,00 |', 'Aberto de terça a domingo.',
    '/empresas/empresa_1/conhecimento/3/arquivo', '## Reservas de mesa', 'só confirme ao cliente depois que o sistema responder "confirmada"']) {
    assert.ok(c.prompt.includes(trecho), `faltou no prompt: ${trecho}`);
  }
  assert.ok(!c.prompt.includes('—') && !c.prompt.includes('–'), 'o prompt não deve ter travessão');

  // sem recursos ligados o prompt não fala de reservas nem de base de conhecimento
  await json('/empresas/empresa_1/modulos', 'PATCH', { reservas: false, conhecimento: false });
  const c2 = await (await f('/empresas/empresa_1/contexto', { token: k.chave })).json();
  assert.deepStrictEqual([c2.recursos, c2.conhecimento], [{ reservas: false, conhecimento: false }, []]);
  assert.ok(!c2.prompt.includes('Reservas de mesa') && !c2.prompt.includes('Base de conhecimento'));
  assert.ok(c2.prompt.includes('Nunca prometer desconto.'));

  // agente vazio ainda gera um prompt mínimo; chave de outra empresa e anônimo não leem
  const outra = await (await json('/empresas', 'POST', { nome: 'Vazia' })).json();
  const kv = await (await json(`/empresas/${outra.id}/api/chave`, 'POST', {}, T.integracao)).json();
  const cv = await (await f(`/empresas/${outra.id}/contexto`, { token: kv.chave })).json();
  assert.ok(cv.prompt.startsWith('Você é o assistente, atendente virtual da empresa Vazia.'));
  assert.strictEqual((await f('/empresas/empresa_1/contexto', { token: kv.chave })).status, 403);
  assert.strictEqual((await f('/empresas/empresa_1/contexto')).status, 401);
  fechar();
});

test('busca no conhecimento devolve só o que o cliente perguntou', async () => {
  const { f, fechar } = await subir();
  const json = (caminho, metodo, corpo, token = T.cliente) => f(caminho, { token, method: metodo, body: corpo });
  const k = await (await json('/empresas/empresa_1/api/chave', 'POST', {}, T.integracao)).json();
  const base = '/empresas/empresa_1/conhecimento';
  await json(base, 'POST', { tipo: 'tabela', titulo: 'Preços dos pratos', tabela: { colunas: ['Prato', 'Preço'], linhas: [['Lasanha à bolonhesa', 'R$ 52,00'], ['Risoto de cogumelos', 'R$ 64,00'], ['Tiramisù', 'R$ 28,00']] } });
  await json(base, 'POST', { tipo: 'texto', titulo: 'Horário de funcionamento', texto: 'Abrimos de terça a domingo, das 18h às 23h30.\nTolerância de atraso de 15 minutos.\nNão aceitamos cheque.' });
  await json(base, 'POST', { tipo: 'documento', titulo: 'Regras da casa', arquivo: { nome: 'regras.txt', base64: Buffer.from('Crianças são bem-vindas.\nAnimais de estimação só na área externa.').toString('base64') } });
  await json(base, 'POST', { tipo: 'documento', titulo: 'Cardápio de vinhos', arquivo: { nome: 'vinhos.pdf', base64: Buffer.from('%PDF-1.4 x').toString('base64') } });
  const buscar = async (q, token = k.chave) => (await f(`${base}/buscar?q=${encodeURIComponent(q)}`, { token })).json();

  // tabela: só as linhas que casam (com acento e pergunta em linguagem natural)
  const preco = await buscar('Quanto custa a lasanha?');
  assert.strictEqual(preco.resultados[0].tipo, 'tabela');
  assert.deepStrictEqual(preco.resultados[0].colunas, ['Prato', 'Preço']);
  assert.deepStrictEqual(preco.resultados[0].linhas, [['Lasanha à bolonhesa', 'R$ 52,00']]);
  assert.strictEqual(preco.resultados[0].parcial, true);
  // sem acento, plural e maiúsculas
  assert.deepStrictEqual((await buscar('RISOTOS')).resultados[0].linhas, [['Risoto de cogumelos', 'R$ 64,00']]);
  // pelo título: devolve a tabela inteira
  assert.strictEqual((await buscar('precos')).resultados[0].linhas.length, 3);
  // texto: só os parágrafos que casam
  const hor = await buscar('aceita cheque?');
  assert.deepStrictEqual(hor.resultados[0].trechos, ['Não aceitamos cheque.']);
  assert.deepStrictEqual((await buscar('tolerancia atraso')).resultados[0].trechos, ['Tolerância de atraso de 15 minutos.']);
  // documento com texto extraído e link; documento sem texto aparece pelo título
  const regras = (await buscar('animais')).resultados[0];
  assert.deepStrictEqual([regras.titulo, regras.trechos], ['Regras da casa', ['Animais de estimação só na área externa.']]);
  assert.strictEqual(regras.arquivo.url, `${base}/3/arquivo`);
  const vinhos = (await buscar('vinhos')).resultados[0];
  assert.deepStrictEqual([vinhos.titulo, vinhos.tipo, vinhos.arquivo.nome], ['Cardápio de vinhos', 'documento', 'vinhos.pdf']);
  // nada encontrado e pergunta genérica
  assert.deepStrictEqual(await buscar('helicóptero'), { consulta: 'helicóptero', total: 0, resultados: [] });
  const geral = await buscar('o que vocês têm?');
  assert.strictEqual(geral.catalogo, true);
  assert.deepStrictEqual(geral.resultados.map((i) => i.titulo), ['Preços dos pratos', 'Horário de funcionamento', 'Regras da casa', 'Cardápio de vinhos']);
  // validação, permissão e isolamento
  assert.strictEqual((await f(`${base}/buscar`, { token: k.chave })).status, 400);
  assert.strictEqual((await f(`${base}/buscar?q=${'x'.repeat(201)}`, { token: k.chave })).status, 400);
  assert.strictEqual((await f(`${base}/buscar?q=a`)).status, 401);
  assert.strictEqual((await f('/empresas/empresa_2/conhecimento/buscar?q=a', { token: k.chave })).status, 403);
  await json('/empresas/empresa_1/modulos', 'PATCH', { conhecimento: false });
  assert.strictEqual((await f(`${base}/buscar?q=preco`, { token: k.chave })).status, 404);
  fechar();
});

test('prompt carrega o conhecimento pequeno inteiro e o grande só por busca', async () => {
  const { f, fechar } = await subir();
  const json = (caminho, metodo, corpo, token = T.cliente) => f(caminho, { token, method: metodo, body: corpo });
  const k = await (await json('/empresas/empresa_1/api/chave', 'POST', {}, T.integracao)).json();
  const ctx = async () => (await f('/empresas/empresa_1/contexto', { token: k.chave })).json();
  assert.ok(!(await ctx()).prompt.includes('one_buscar_conhecimento')); // sem itens, sem instrução
  await json('/empresas/empresa_1/conhecimento', 'POST', { tipo: 'texto', titulo: 'Pequeno', texto: 'Conteúdo curto da casa.' });
  const p1 = (await ctx()).prompt;
  assert.ok(p1.includes('Conteúdo curto da casa.') && p1.includes('one_buscar_conhecimento'));
  await json('/empresas/empresa_1/conhecimento', 'POST', { tipo: 'texto', titulo: 'Manual enorme', texto: 'palavra '.repeat(900) });
  const p2 = (await ctx()).prompt;
  assert.ok(!p2.includes('Conteúdo curto da casa.') && !p2.includes('palavra palavra'));
  assert.ok(p2.includes('Assuntos disponíveis: Pequeno; Manual enorme.'));
  assert.ok(p2.includes('chame a função one_buscar_conhecimento'));
  assert.ok(!p2.includes('—'));
  fechar();
});

test('reserva guarda nome e contato do cliente vindos do chat', async () => {
  const { f, fechar } = await subir();
  const json = (caminho, metodo, corpo, token = T.cliente, h = {}) => f(caminho, { token, method: metodo, body: corpo, headers: h });
  const k = await (await json('/empresas/empresa_1/api/chave', 'POST', {}, T.integracao)).json();
  const corpo = { data: '2026-11-20', horario: '20:00', pessoas: 2, ambiente: 'salao', nomeCliente: '  Carlos Lima ', contato: '+55 11 90000-0000' };
  const r = await (await json('/empresas/empresa_1/reservas', 'POST', corpo, k.chave, { 'Idempotency-Key': 'c1' })).json();
  assert.strictEqual(r.status, 'confirmada');
  // equipe vê na lista, no mapa e no histórico
  const lista = await (await f('/empresas/empresa_1/reservas?data=2026-11-20', { token: T.cliente })).json();
  assert.deepStrictEqual([lista[0].nomeCliente, lista[0].contato], ['Carlos Lima', '+55 11 90000-0000']);
  const mapa = await (await f('/empresas/empresa_1/mapa?data=2026-11-20&horario=20:00', { token: T.cliente })).json();
  assert.strictEqual(mapa[0].mesas[0].reserva.nomeCliente, 'Carlos Lima');
  const h = await (await f('/empresas/empresa_1/historico?entidade=reserva', { token: T.cliente })).json();
  assert.strictEqual(h[0].depois.nomeCliente, 'Carlos Lima');
  assert.strictEqual(h[0].papel, 'chat');
  // validação
  const ruim = (extra, chave) => json('/empresas/empresa_1/reservas', 'POST', { ...corpo, horario: '22:00', ...extra }, k.chave, { 'Idempotency-Key': chave });
  assert.strictEqual((await ruim({ nomeCliente: 'x'.repeat(81) }, 'c2')).status, 400);
  assert.strictEqual((await ruim({ contato: 'y'.repeat(41) }, 'c3')).status, 400);
  assert.strictEqual((await ruim({ nomeCliente: 123 }, 'c4')).status, 400);
  // sem dados do cliente continua valendo
  const semDados = await ruim({ nomeCliente: undefined, contato: undefined }, 'c5');
  assert.strictEqual(semDados.status, 201);
  // equipe edita e limpa
  const id = r.reservaId;
  const ed = await (await json(`/empresas/empresa_1/reservas/${id}`, 'PATCH', { nomeCliente: 'Carlos A. Lima', contato: '' })).json();
  assert.deepStrictEqual([ed.reserva.nomeCliente, ed.reserva.contato], ['Carlos A. Lima', undefined]);
  const h2 = await (await f(`/empresas/empresa_1/historico?entidade=reserva&id=${id}`, { token: T.cliente })).json();
  assert.deepStrictEqual(h2[0].antes, { nomeCliente: 'Carlos Lima', contato: '+55 11 90000-0000' });
  assert.deepStrictEqual(h2[0].depois, { nomeCliente: 'Carlos A. Lima' }); // contato apagado: some do "depois"
  fechar();
});

// ---- publicação: saúde, CORS, limite de requisições e demo por flag ----

test('GET /saude responde 200 { ok: true } sem autenticação', async () => {
  const { f, fechar } = await subir();
  const r = await f('/saude');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(await r.json(), { ok: true });
  fechar();
});

const ORIGEM = 'https://painel.exemplo.com';

test('CORS: origem permitida recebe o cabeçalho, sem "*" e sem credenciais', async () => {
  const { f, fechar } = await subir({ corsOrigens: [ORIGEM] });
  const r = await f('/saude', { headers: { Origin: ORIGEM } });
  assert.strictEqual(r.headers.get('access-control-allow-origin'), ORIGEM);
  assert.strictEqual(r.headers.get('vary'), 'Origin');
  assert.strictEqual(r.headers.get('access-control-allow-credentials'), null);
  fechar();
});

test('CORS: origem fora da lista não recebe Access-Control-Allow-Origin', async () => {
  const { f, fechar } = await subir({ corsOrigens: [ORIGEM] });
  const r = await f('/saude', { headers: { Origin: 'https://outro.com' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('access-control-allow-origin'), null);
  const p = await f('/empresas', { method: 'OPTIONS', headers: { Origin: 'https://outro.com' } });
  assert.strictEqual(p.status, 204);
  assert.strictEqual(p.headers.get('access-control-allow-origin'), null);
  assert.strictEqual(p.headers.get('access-control-allow-methods'), null);
  fechar();
});

test('CORS: preflight de origem permitida responde 204 com métodos, cabeçalhos e max-age', async () => {
  const { f, fechar } = await subir({ corsOrigens: [ORIGEM, 'https://b.exemplo.com'] });
  const r = await f('/empresas/empresa_1/reservas', { method: 'OPTIONS', headers: { Origin: 'https://b.exemplo.com', 'Access-Control-Request-Method': 'POST' } });
  assert.strictEqual(r.status, 204);
  assert.strictEqual(r.headers.get('access-control-allow-origin'), 'https://b.exemplo.com');
  assert.strictEqual(r.headers.get('access-control-allow-methods'), 'GET, POST, PATCH, DELETE, OPTIONS');
  assert.strictEqual(r.headers.get('access-control-allow-headers'), 'Authorization, Content-Type, Idempotency-Key, X-Operador');
  assert.strictEqual(r.headers.get('access-control-max-age'), '600');
  assert.strictEqual(r.headers.get('access-control-allow-credentials'), null);
  fechar();
});

test('CORS: sem a variável nenhum cabeçalho CORS é enviado', async () => {
  const { f, fechar } = await subir();
  const r = await f('/saude', { headers: { Origin: ORIGEM } });
  assert.strictEqual(r.headers.get('access-control-allow-origin'), null);
  assert.strictEqual(r.headers.get('vary'), null);
  fechar();
});

test('limite: a 21ª tentativa com chave errada em 1 minuto devolve 429 com Retry-After', async () => {
  const { f, fechar } = await subir();
  for (let i = 1; i <= 20; i++) assert.strictEqual((await f('/empresas', { token: 'errada' })).status, 401, `tentativa ${i}`);
  const r = await f('/empresas', { token: 'errada' });
  assert.strictEqual(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  // chave válida do mesmo IP não é afetada pelo contador de chaves inválidas
  assert.strictEqual((await f('/empresas', { token: T.integracao })).status, 200);
  // /saude não entra na conta
  assert.strictEqual((await f('/saude')).status, 200);
  fechar();
});

test('limite: a janela de 1 minuto reinicia a contagem de chaves inválidas', async () => {
  let t = 1000000;
  const { f, fechar } = await subir({ agora: () => t });
  for (let i = 0; i < 20; i++) await f('/empresas', { token: 'errada' });
  assert.strictEqual((await f('/empresas', { token: 'errada' })).status, 429);
  t += 60 * 1000;
  assert.strictEqual((await f('/empresas', { token: 'errada' })).status, 401);
  fechar();
});

test('limite: 300 requisições por minuto por chave válida, a 301ª dá 429; outra chave segue livre', async () => {
  const { f, fechar } = await subir();
  for (let i = 1; i <= 300; i++) {
    const s = (await f('/empresas', { token: T.integracao })).status;
    if (s !== 200) assert.fail(`requisição ${i} devolveu ${s}`);
  }
  assert.strictEqual((await f('/empresas', { token: T.integracao })).status, 429);
  assert.strictEqual((await f('/empresas', { token: T.cliente })).status, 200);
  fechar();
});

test('limite: X-Forwarded-For só vale com confiarProxy', async () => {
  const a = await subir();
  for (let i = 0; i < 20; i++) await a.f('/empresas', { token: 'errada', headers: { 'X-Forwarded-For': `9.9.9.${i}` } });
  assert.strictEqual((await a.f('/empresas', { token: 'errada', headers: { 'X-Forwarded-For': '8.8.8.8' } })).status, 429, 'sem proxy confiável o cabeçalho é ignorado');
  a.fechar();
  const b = await subir({ confiarProxy: true });
  for (let i = 0; i < 20; i++) await b.f('/empresas', { token: 'errada', headers: { 'X-Forwarded-For': '1.1.1.1' } });
  assert.strictEqual((await b.f('/empresas', { token: 'errada', headers: { 'X-Forwarded-For': '1.1.1.1' } })).status, 429);
  assert.strictEqual((await b.f('/empresas', { token: 'errada', headers: { 'X-Forwarded-For': '2.2.2.2' } })).status, 401, 'outro IP tem contagem própria');
  b.fechar();
});

// Sobe src/server.js de verdade (processo filho) e devolve a lista de GET /empresas
async function empresasDoServidor(extraEnv) {
  const { spawn } = require('node:child_process');
  const net = require('node:net');
  const porta = await new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: String(porta), KENDJI_TOKEN_INTEGRACAO: 'ti-teste', ...extraEnv };
  const filho = spawn(process.execPath, [require('node:path').join(__dirname, '..', 'src', 'server.js')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((ok, err) => { filho.stdout.once('data', ok); filho.once('error', err); filho.once('exit', () => err(new Error('servidor saiu'))); });
    const r = await fetch(`http://127.0.0.1:${porta}/empresas`, { headers: { Authorization: 'Bearer ti-teste' } });
    assert.strictEqual(r.status, 200);
    return await r.json();
  } finally { filho.kill(); }
}

test('server.js sem KENDJI_DEMO começa vazio: GET /empresas devolve []', async () => {
  assert.deepStrictEqual(await empresasDoServidor({}), []);
  assert.deepStrictEqual(await empresasDoServidor({ KENDJI_DEMO: '0' }), []);
});

test('server.js com KENDJI_DEMO=1 cria as 3 empresas de demonstração', async () => {
  const lista = await empresasDoServidor({ KENDJI_DEMO: '1' });
  assert.strictEqual(lista.length, 3);
});

test('GET /app sem barra redireciona 301 para /app/ (preservando a query)', async () => {
  const { f, fechar } = await subir();
  const r = await f('/app', { redirect: 'manual' });
  assert.strictEqual(r.status, 301);
  assert.strictEqual(r.headers.get('location'), '/app/');
  const q = await f('/app?x=1', { redirect: 'manual' });
  assert.strictEqual(q.status, 301);
  assert.strictEqual(q.headers.get('location'), '/app/?x=1');
  assert.strictEqual((await f('/app/')).status, 200);
  fechar();
});

test('GET /app/config.js é servido como JavaScript', async () => {
  const { f, fechar } = await subir();
  const r = await f('/app/config.js');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('content-type'), 'text/javascript; charset=utf-8');
  fechar();
});
