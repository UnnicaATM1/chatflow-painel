'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { criarStore: criarStoreMemoria, addEmpresa } = require('../src/store');
const { criarServidor } = require('../src/api');

const usarSqlite = process.env.CHATFLOW_BANCO === 'sqlite';
const criarRepositorioSqlite = usarSqlite ? require('../src/sqlite/repositorio').criarRepositorioSqlite : null;
const repositorios = [];
function criarStore(opcoes) {
  if (!usarSqlite) return criarStoreMemoria(opcoes);
  const store = criarRepositorioSqlite(opcoes);
  repositorios.push(store);
  return store;
}
test.after(() => Promise.all(repositorios.map((store) => store.fechar())));

const T = { chat: 'tc', cliente: 'tcl', integracao: 'ti' };

// Régua de contrato (docs/migracao-rust.md): sem CHATFLOW_SERVIDOR, o servidor sobe em processo (src/api.js).
// Com CHATFLOW_SERVIDOR (array JSON do comando, ex.: ["node","src/server.js"] ou ["C:/.../one-node.exe"]),
// cada teste sobe esse comando como processo filho, com a empresa de teste semeada por CHATFLOW_SEMENTE_ARQUIVO,
// e conversa só por HTTP. Os mesmos testes valem para o JavaScript e para o binário Rust.
const EXTERNO = process.env.CHATFLOW_SERVIDOR ? JSON.parse(process.env.CHATFLOW_SERVIDOR) : null;
const WORKER = process.env.CHATFLOW_TESTE_WORKER === '1';
const WORKER_D1 = WORKER && process.env.CHATFLOW_TESTE_WORKER_D1 === '1';
// Testes que só fazem sentido dentro do processo do JavaScript (núcleo, repositório, plataforma, relógio injetado)
const INTERNO = { skip: EXTERNO || WORKER ? 'teste interno do JavaScript (fora da régua de contrato HTTP)' : false };

const runtimes = new Set();
test.after(() => Promise.all([...runtimes].map((fechar) => fechar())));

function subirWorker(bindings, { comSemente = true, migrar = true, persistencia } = {}) {
  const { Miniflare } = require('miniflare');
  const { join } = require('node:path');
  const runtime = new Miniflare({
    modules: true,
    scriptPath: join(__dirname, '..', comSemente ? 'node_modules/.cache/chatflow/worker-entry.js' : 'dist/server/index.js'),
    compatibilityDate: '2025-01-01',
    bindings,
    ...(WORKER_D1 && {
      d1Databases: { DB: 'chatflow' },
      r2Buckets: { BUCKET: 'chatflow-anexos' },
      d1Persist: persistencia,
      r2Persist: persistencia,
    }),
  });
  let fechamento;
  const fechar = () => {
    fechamento ??= runtime.dispose().finally(() => runtimes.delete(fechar));
    return fechamento;
  };
  runtimes.add(fechar);
  const pronto = WORKER_D1 && migrar ? (async () => {
    const { readFile } = require('node:fs/promises');
    const pasta = join(__dirname, '..', 'dist/.openai/drizzle');
    const { entries } = JSON.parse(await readFile(join(pasta, 'meta/_journal.json'), 'utf8'));
    const db = await runtime.getD1Database('DB');
    for (const { tag } of entries) {
      const sql = await readFile(join(pasta, tag + '.sql'), 'utf8');
      await db.batch(sql.split('--> statement-breakpoint').map((comando) => db.prepare(comando.trim())));
    }
  })() : Promise.resolve();
  return {
    fetch: async (path, init) => {
      await pronto;
      return runtime.dispatchFetch('http://localhost' + path, init);
    },
    fechar,
  };
}

const FILHOS = new Set();
process.on('exit', () => { for (const c of FILHOS) { try { c.kill(); } catch { /* já saiu */ } } });

const SEMENTE_PADRAO = [{
  id: 'empresa_1', nome: 'empresa_1',
  ambientes: [{ nome: 'salao', mesas: [{ id: 'S1', capacidade: 4, reservavel: true }] }],
  agente: { descricao: 'd', personalidade: '', habilidades: '', produtos: '', restricoes: 'r', editavelPor: { nome: ['cliente', 'integracao'], descricao: ['cliente', 'integracao'], personalidade: ['cliente', 'integracao'], restricoes: ['cliente', 'integracao'] } },
}];

// Sobe o comando (CHATFLOW_SERVIDOR ou `node src/server.js`) como processo filho e espera /saude responder.
async function lancar(env) {
  const { spawn } = require('node:child_process');
  const net = require('node:net');
  const porta = await new Promise((r) => { const l = net.createServer().listen(0, () => { const p = l.address().port; l.close(() => r(p)); }); });
  const cmd = EXTERNO || [process.execPath, require('node:path').join(__dirname, '..', 'src', 'server.js')];
  const base = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, PORT: String(porta),
    CHATFLOW_BANCO: usarSqlite ? 'sqlite' : 'memoria', CHATFLOW_BANCO_ARQUIVO: ':memory:',
  };
  const filho = spawn(cmd[0], cmd.slice(1), { env: { ...base, ...env }, stdio: ['ignore', 'ignore', 'inherit'], shell: false });
  FILHOS.add(filho);
  let saiu = false;
  const saida = new Promise((resolve) => filho.once('exit', () => {
    saiu = true;
    FILHOS.delete(filho);
    resolve();
  }));
  const url = `http://127.0.0.1:${porta}`;
  const limite = Date.now() + 15000;
  for (;;) {
    if (saiu) throw new Error('o servidor saiu antes de ficar pronto');
    try { if ((await fetch(`${url}/saude`)).status === 200) break; } catch { /* ainda subindo */ }
    if (Date.now() > limite) { filho.kill(); throw new Error('o servidor não respondeu /saude em 15 s'); }
    await new Promise((r) => setTimeout(r, 25));
  }
  return { base: url, fechar: () => { if (!saiu) filho.kill(); return saida; } };
}

// opcoes: corsOrigens, confiarProxy, adminSenha (null = sem senha), semente (empresas iniciais), agora (só em processo).
async function subir(opcoes = {}) {
  const { semente = SEMENTE_PADRAO, adminSenha = 'senha-de-teste', ...resto } = opcoes;
  let base, fechar;
  let requisitar = (path, init) => fetch(base + path, init);
  if (WORKER) {
    const runtime = subirWorker({
      CHATFLOW_TOKEN_CLIENTE: T.cliente,
      CHATFLOW_TOKEN_INTEGRACAO: T.integracao,
      CHATFLOW_ADMIN_SENHA: adminSenha || '',
      CHATFLOW_CORS_ORIGENS: resto.corsOrigens?.join(',') || '',
      CHATFLOW_FUSO: resto.fuso || '',
      TEST_SEMENTE: JSON.stringify(semente),
      TEST_CHAVE_EMPRESA: T.chat,
    });
    requisitar = runtime.fetch;
    fechar = runtime.fechar;
  } else if (EXTERNO && !resto.agora) {
    const fs = require('node:fs');
    const arq = require('node:path').join(require('node:os').tmpdir(), `one-semente-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(arq, JSON.stringify(semente));
    const env = {
      CHATFLOW_TOKEN_CHAT: T.chat, CHATFLOW_TOKEN_CLIENTE: T.cliente, CHATFLOW_TOKEN_INTEGRACAO: T.integracao,
      CHATFLOW_SEMENTE_ARQUIVO: arq,
      ...(adminSenha ? { CHATFLOW_ADMIN_SENHA: adminSenha } : {}),
      ...(resto.corsOrigens ? { CHATFLOW_CORS_ORIGENS: resto.corsOrigens.join(',') } : {}),
      ...(resto.confiarProxy ? { CHATFLOW_CONFIAR_PROXY: '1' } : {}),
      ...(resto.fuso ? { CHATFLOW_FUSO: resto.fuso } : {}),
    };
    const srv = await lancar(env);
    base = srv.base;
    fechar = async () => { await srv.fechar(); try { fs.unlinkSync(arq); } catch { /* já apagado */ } };
  } else {
    const s = criarStore({ fuso: resto.fuso });
    for (const e of JSON.parse(JSON.stringify(semente))) await addEmpresa(s, e);
    const srv = criarServidor(s, T, { ...(adminSenha ? { adminSenha } : {}), ...resto });
    await new Promise((r) => srv.listen(0, r));
    base = `http://127.0.0.1:${srv.address().port}`;
    fechar = () => srv.close();
  }
  const f = (path, { token, method = 'GET', body, headers = {}, redirect } = {}) =>
    requisitar(path, {
      method, redirect,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  return { f, fechar };
}

const res = { data: '2026-11-20', horario: '20:00', pessoas: 2, ambiente: 'salao' };

test('exige token', async () => {
  const { f, fechar } = await subir();
  assert.strictEqual((await f('/empresas/empresa_1/agente')).status, 401);
  assert.strictEqual((await f('/empresas/empresa_1/agente', { token: 'errado' })).status, 401);
  fechar();
});

test('chat lê o bloco inteiro e não acessa empresa inexistente', async () => {
  const { f, fechar } = await subir();
  const r = await f('/empresas/empresa_1/agente', { token: T.chat });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(Object.keys(await r.json()), ['nome', 'descricao', 'personalidade', 'habilidades', 'produtos', 'restricoes']);
  assert.strictEqual((await f('/empresas/X/agente', { token: T.chat })).status, WORKER ? 403 : 404);
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

test('gestão de ambientes e mesas: renomeia, bloqueia remoção ativa e desliga reservas elegíveis', async (t) => {
  const { f, fechar } = await subir({ semente: [{
    ...SEMENTE_PADRAO[0],
    ambientes: [
      { nome: 'Salão/A', mesas: ['A1', 'A2'].map((id) => ({ reservavel: true, capacidade: 4, id })) },
      { nome: 'Varanda', mesas: [] },
    ],
  }] });
  t.after(fechar);
  const chamar = async (caminho, method, body, token = T.cliente) => {
    const r = await f('/empresas/empresa_1' + caminho, { token, method, body, headers: { 'X-Operador': 'Marina' } });
    return [r.status, await r.text()];
  };
  const reservarMesa = async (mesaId, data, chave) => {
    const r = await f('/empresas/empresa_1/reservas', {
      token: T.chat, method: 'POST', body: { ...res, ambiente: undefined, mesaId, data }, headers: { 'Idempotency-Key': chave },
    });
    assert.strictEqual(r.status, 201);
    return (await r.json()).reservaId;
  };
  const ativo = await reservarMesa('A2', '2099-01-01', 'ativo');
  const passado = await reservarMesa('A1', '2000-01-01', 'passado');
  const cancelado = await reservarMesa('A2', '2099-01-02', 'cancelado');
  assert.strictEqual((await chamar('/reservas/' + cancelado, 'DELETE'))[0], 200);
  const antigo = '/ambientes/' + encodeURIComponent('Salão/A');
  assert.deepStrictEqual(await chamar(antigo, 'PATCH', { nome: 'varanda' }), [409, '{"erro":"nome já usado"}']);
  for (const nome of ['', 9, 'á'.repeat(61)]) {
    assert.deepStrictEqual(await chamar(antigo, 'PATCH', { nome }), [400, '{"erro":"nome do ambiente deve ter de 1 a 60 caracteres"}']);
  }
  assert.deepStrictEqual(await chamar(antigo, 'PATCH', { nome: ' Salão Novo ' }, T.integracao), [
    200, '{"nome":"Salão Novo","mesas":[{"id":"A1","capacidade":4,"reservavel":true},{"id":"A2","capacidade":4,"reservavel":true}]}',
  ]);
  assert.deepStrictEqual(await chamar(antigo, 'DELETE'), [404, '{"erro":"ambiente inexistente"}']);
  const novo = '/ambientes/' + encodeURIComponent('Salão Novo');
  const conflito = [409, JSON.stringify({ erro: 'mesa com reserva ativa', reservas: [ativo] })];
  assert.deepStrictEqual(await chamar(novo, 'DELETE'), conflito);
  assert.deepStrictEqual(await chamar('/mesas/A2', 'DELETE'), conflito);
  const listar = async (caminho) => JSON.parse((await chamar(caminho, 'GET'))[1]);
  const relacoes = async () => Object.fromEntries((await listar('/reservas')).map((r) => [r.id, r.mesaId]));
  assert.ok((await listar('/reservas')).every((r) => r.ambiente === 'Salão Novo'));
  assert.deepStrictEqual(await relacoes(), { [ativo]: 'A2', [passado]: 'A1', [cancelado]: 'A2' });
  assert.deepStrictEqual(await chamar('/mesas/A1', 'DELETE'), [200, JSON.stringify({ ok: true, reservasDesligadas: [passado] })]);
  assert.deepStrictEqual(await chamar('/mesas/A1', 'DELETE'), [404, '{"erro":"mesa inexistente"}']);
  assert.strictEqual((await chamar('/reservas/' + ativo, 'DELETE'))[0], 200);
  assert.deepStrictEqual(await chamar(novo, 'DELETE', undefined, T.integracao), [200, '{"ok":true,"mesasRemovidas":["A2"]}']);
  assert.deepStrictEqual(await relacoes(), { [ativo]: null, [passado]: null, [cancelado]: null });
  assert.deepStrictEqual((await listar('/estrutura')).ambientes, [{ nome: 'Varanda', mesas: [] }]);

  const historico = (await listar('/historico')).filter((e) => e.entidade === 'ambiente' || e.entidade === 'mesa');
  assert.deepStrictEqual(historico.map((e) => [e.acao, e.papel, e.operador, e.entidadeId, e.depois]), [
    ['ambiente_removido', 'integracao', 'Marina', 'Salão Novo', null],
    ['mesa_removida', 'cliente', 'Marina', 'A1', null],
    ['ambiente_renomeado', 'integracao', 'Marina', 'Salão/A', { nome: 'Salão Novo' }],
  ]);
  assert.deepStrictEqual(historico[1].antes.reservas, [{ id: passado, mesaId: 'A1' }]);
  assert.deepStrictEqual(historico[2].antes, { nome: 'Salão/A' });
});

test('exclusão definitiva exige cancelamento e guarda o instantâneo no histórico', async (t) => {
  const { f, fechar } = await subir();
  t.after(fechar);
  const base = '/empresas/empresa_1';
  const post = await f(base + '/reservas', {
    token: T.chat, method: 'POST', body: { ...res, nomeCliente: 'Carlos', contato: 'carlos@example.com' },
    headers: { 'Idempotency-Key': 'excluir' },
  });
  assert.strictEqual(post.status, 201);
  const { reservaId } = await post.json();
  const rota = base + '/reservas/' + reservaId;
  const del = async (query) => {
    const r = await f(rota + query, { token: T.cliente, method: 'DELETE' });
    return [r.status, await r.text()];
  };
  assert.deepStrictEqual(await del('?definitivo=1'), [409, '{"erro":"reserva ativa; cancele antes de excluir"}']);
  const [status, corpo] = await del('?definitivo=0');
  assert.strictEqual(status, 200);
  const { reserva } = JSON.parse(corpo);
  assert.strictEqual(reserva.status, 'cancelada');
  assert.deepStrictEqual(await del('?definitivo=1'), [200, '{"ok":true}']);
  assert.deepStrictEqual(await del('?definitivo=1'), [404, '{"erro":"reserva inexistente"}']);
  assert.deepStrictEqual(await (await f(base + '/reservas', { token: T.cliente })).json(), []);
  const eventos = await (await f(base + '/historico?entidade=reserva&id=' + reservaId, { token: T.cliente })).json();
  const exclusoes = eventos.filter((e) => e.acao === 'reserva_excluida');
  assert.strictEqual(exclusoes.length, 1);
  const [exclusao] = exclusoes;
  assert.deepStrictEqual(Object.keys(exclusao.antes), [...Object.keys(reserva), 'inicio', 'fim']);
  const { inicio, fim, ...dados } = exclusao.antes;
  assert.deepStrictEqual(dados, reserva);
  assert.strictEqual(fim - inicio, 90);
  assert.strictEqual(exclusao.depois, null);
});

test('remoção de mesa usa o fuso de negócio para decidir se a reserva terminou', async (t) => {
  const { f, fechar } = await subir({ fuso: 'Etc/GMT+12' });
  t.after(fechar);
  // Seis horas atrás em UTC ainda está seis horas à frente no relógio UTC-12.
  const instante = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const base = '/empresas/empresa_1';
  const reserva = await f(base + '/reservas', {
    token: T.chat, method: 'POST', body: { ...res, data: instante.slice(0, 10), horario: instante.slice(11, 16) },
    headers: { 'Idempotency-Key': 'fuso' },
  });
  assert.strictEqual(reserva.status, 201);
  const { reservaId } = await reserva.json();
  const remover = await f(base + '/mesas/S1', { token: T.cliente, method: 'DELETE' });
  assert.strictEqual(remover.status, 409);
  assert.deepStrictEqual(await remover.json(), { erro: 'mesa com reserva ativa', reservas: [reservaId] });
});

test('gestão de ambientes, mesas e exclusão definitiva exige equipe e módulo reservas ligado', async (t) => {
  const { f, fechar } = await subir();
  t.after(fechar);
  const base = '/empresas/empresa_1';
  const chave = await f(base + '/api/chave', { token: T.integracao, method: 'POST' });
  assert.strictEqual(chave.status, 201);
  const { chave: token } = await chave.json();
  const desligar = await f(base + '/modulos', { token: T.cliente, method: 'PATCH', body: { reservas: false } });
  assert.strictEqual(desligar.status, 200);
  for (const [method, caminho, body] of [
    ['PATCH', '/ambientes/salao', { nome: 'Novo' }],
    ['DELETE', '/ambientes/salao'],
    ['DELETE', '/mesas/S1'],
    ['DELETE', '/reservas/22222222?definitivo=1'],
  ]) {
    const bloqueado = await f(base + caminho, { token, method, body });
    assert.strictEqual(bloqueado.status, 403);
    assert.deepStrictEqual(await bloqueado.json(), { erro: 'sem permissão' });
    const recurso = await f(base + caminho, { token: T.integracao, method, body });
    assert.strictEqual(recurso.status, 404);
    assert.deepStrictEqual(await recurso.json(), { erro: 'recurso "reservas" não habilitado para esta empresa' });
  }
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

// reservaId (TASK-012): código de 8 caracteres do alfabeto sem 0, O, 1, I e L. O valor é aleatório; a régua só confere o formato.
const CODIGO_RESERVA = /^[2-9A-HJKMNP-Z]{8}$/;

test('reservaId é um código curto aleatório: formato, idempotência, histórico, desfazer e rotas', async () => {
  const { f, fechar } = await subir();
  const post = (chave, extra = {}) => f('/empresas/empresa_1/reservas', { token: T.chat, method: 'POST', body: { ...res, ...extra }, headers: { 'Idempotency-Key': chave } });
  const a = await (await post('c1')).json();
  assert.match(a.reservaId, CODIGO_RESERVA);
  assert.strictEqual(typeof a.reservaId, 'string');
  const b = await (await post('c2', { horario: '22:00' })).json();
  assert.match(b.reservaId, CODIGO_RESERVA);
  assert.notStrictEqual(a.reservaId, b.reservaId);
  // mesma chave devolve a mesma resposta, com o mesmo código
  assert.deepStrictEqual(await (await post('c1')).json(), a);
  // lista, histórico e rotas usam o código; nada de uuid na resposta
  const lista = await (await f('/empresas/empresa_1/reservas', { token: T.cliente })).json();
  assert.deepStrictEqual(lista.map((r) => r.id).sort(), [a.reservaId, b.reservaId].sort());
  assert.ok(lista.every((r) => CODIGO_RESERVA.test(r.id) && r.uuid === undefined));
  const mapa = await (await f('/empresas/empresa_1/mapa?data=2026-11-20&horario=20:00', { token: T.cliente })).json();
  assert.deepStrictEqual(mapa[0].mesas[0].reserva, { horario: '20:00', pessoas: 2, status: 'confirmada' });
  const rotaDisponibilidade = '/empresas/empresa_1/disponibilidade?data=2026-11-20&horario=20:00&pessoas=2';
  const disponivel = await (await f(`${rotaDisponibilidade}&ignorar=${a.reservaId}`, { token: T.cliente })).json();
  assert.deepStrictEqual(disponivel.ambientes[0].mesas.map((m) => m.id), ['S1']);
  for (const invalido of ['', '123', 'OOOOOOOO']) {
    assert.strictEqual((await f(`${rotaDisponibilidade}&ignorar=${invalido}`, { token: T.cliente })).status, 400);
  }
  const hist = await (await f('/empresas/empresa_1/historico?entidade=reserva', { token: T.cliente })).json();
  assert.ok(hist.length >= 2 && hist.every((e) => [a.reservaId, b.reservaId].includes(e.entidadeId)));
  const cancel = await f(`/empresas/empresa_1/reservas/${a.reservaId}`, { token: T.cliente, method: 'DELETE' });
  assert.strictEqual(cancel.status, 200);
  assert.strictEqual((await cancel.json()).reserva.id, a.reservaId);
  // desfazer o cancelamento pelo código do histórico
  const ev = (await (await f('/empresas/empresa_1/historico?entidade=reserva', { token: T.cliente })).json()).find((e) => e.entidadeId === a.reservaId && e.acao === 'cancelada');
  assert.ok(ev);
  const des = await f(`/empresas/empresa_1/historico/${ev.seq}/desfazer`, { token: T.cliente, method: 'POST' });
  assert.strictEqual(des.status, 200);
  assert.strictEqual((await des.json()).reserva.status, 'confirmada');
  // números e códigos inexistentes: 404
  for (const ruim of ['1', '999', '22222222', 'abc']) {
    assert.strictEqual((await f(`/empresas/empresa_1/reservas/${ruim}`, { token: T.cliente, method: 'DELETE' })).status, 404, ruim);
  }
  // o código não é reaproveitado depois de cancelar
  const c = await (await post('c3', { horario: '23:00' })).json();
  assert.ok(![a.reservaId, b.reservaId].includes(c.reservaId));
  fechar();
});

test('a carga de empresas converte IDs numéricos de reservas semeadas em códigos públicos', INTERNO, async (t) => {
  const semente = [{
    ...SEMENTE_PADRAO[0],
    reservas: [
      { ...res, id: 101, mesaId: 'S1', status: 'confirmada' },
      { ...res, id: 102, mesaId: 'S1', status: 'cancelada' },
    ],
  }];
  const { f, fechar } = await subir({ semente });
  t.after(fechar);
  const lista = await (await f('/empresas/empresa_1/reservas', { token: T.cliente })).json();
  assert.deepStrictEqual(lista.map((r) => r.status), ['confirmada', 'cancelada']);
  assert.ok(lista.every((r) => CODIGO_RESERVA.test(r.id) && r.uuid === undefined));
  assert.strictEqual(new Set(lista.map((r) => r.id)).size, 2);
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
  assert.match(n1.reservaId, CODIGO_RESERVA); // código curto, não contador

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
  const sem = await subir({ adminSenha: null, semente: [{ id: 'empresa_1', nome: 'empresa_1', ambientes: [], agente: {} }] });
  const r = await sem.f('/empresas/empresa_1/excluir', { token: T.cliente, method: 'POST', body: { senha: '', confirmarNome: 'empresa_1' } });
  assert.strictEqual(r.status, 503);
  assert.strictEqual((await sem.f('/empresas', { token: T.cliente }).then((x) => x.json())).length, 1);
  sem.fechar();
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

test('limite: a janela de 1 minuto reinicia a contagem de chaves inválidas', INTERNO, async () => {
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
  if (WORKER) return; // Workers usam o IP do ingresso Cloudflare. CHATFLOW_CONFIAR_PROXY é do Node.
  const b = await subir({ confiarProxy: true });
  for (let i = 0; i < 20; i++) await b.f('/empresas', { token: 'errada', headers: { 'X-Forwarded-For': '1.1.1.1' } });
  assert.strictEqual((await b.f('/empresas', { token: 'errada', headers: { 'X-Forwarded-For': '1.1.1.1' } })).status, 429);
  assert.strictEqual((await b.f('/empresas', { token: 'errada', headers: { 'X-Forwarded-For': '2.2.2.2' } })).status, 401, 'outro IP tem contagem própria');
  b.fechar();
});

// Sobe o servidor de verdade (processo filho) e devolve a lista de GET /empresas
async function empresasDoServidor(extraEnv) {
  const srv = await lancar({ CHATFLOW_TOKEN_INTEGRACAO: 'ti-teste', ...extraEnv });
  try {
    const r = await fetch(`${srv.base}/empresas`, { headers: { Authorization: 'Bearer ti-teste' } });
    assert.strictEqual(r.status, 200);
    return await r.json();
  } finally { srv.fechar(); }
}

test('server.js sem CHATFLOW_DEMO começa vazio: GET /empresas devolve []', { skip: WORKER }, async () => {
  assert.deepStrictEqual(await empresasDoServidor({}), []);
  assert.deepStrictEqual(await empresasDoServidor({ CHATFLOW_DEMO: '0' }), []);
});

test('server.js com CHATFLOW_DEMO=1 cria as 3 empresas de demonstração', { skip: WORKER }, async () => {
  const lista = await empresasDoServidor({ CHATFLOW_DEMO: '1' });
  assert.strictEqual(lista.length, 3);
});

if (WORKER) {
  test('artefato Worker: saúde anônima, login de equipe, painel na mesma origem e chave global desativada', async (t) => {
    const srv = subirWorker({
      CHATFLOW_TOKEN_INTEGRACAO: T.integracao,
      CHATFLOW_TOKEN_CHAT: T.chat,
      CHATFLOW_DEMO: '1',
    }, { comSemente: false });
    t.after(srv.fechar);
    const saude = await srv.fetch('/saude');
    assert.strictEqual(saude.status, 200);
    assert.deepStrictEqual(await saude.json(), { ok: true });
    for (const authorization of ['', `Bearer ${T.chat}`]) {
      const negado = await srv.fetch('/empresas', { headers: { authorization } });
      assert.strictEqual(negado.status, 401);
      assert.deepStrictEqual(await negado.json(), { erro: 'não autenticado' });
    }
    for (const [method, path] of [
      ['POST', '/empresas'], ['PATCH', '/empresas/empresa_1'], ['POST', '/empresas/empresa_1/excluir'],
      ['GET', '/empresas/empresa_1/contexto'], ['GET', '/empresas/empresa_1/agente'], ['GET', '/empresas/empresa_1/recursos'],
      ['GET', '/empresas/empresa_1/disponibilidade'], ['GET', '/empresas/empresa_1/conhecimento'],
      ['GET', '/empresas/empresa_1/conhecimento/k1/arquivo'], ['POST', '/empresas/empresa_1/reservas'],
      ['DELETE', '/empresas/empresa_1/reservas/r1?definitivo=1'], ['DELETE', '/empresas/empresa_1/mesas/S1'],
      ['POST', '/empresas/empresa_1/ambientes'], ['GET', '/empresas/empresa_1/mapa'],
      ['GET', '/empresas/empresa_1/historico'], ['POST', '/empresas/empresa_1/api/chave'],
      ['GET', '/rota-inexistente'],
    ]) {
      assert.strictEqual((await srv.fetch(path, { method })).status, 401, `${method} ${path}`);
    }
    const lista = await srv.fetch('/empresas', { headers: { authorization: `Bearer ${T.integracao}` } });
    assert.strictEqual(lista.status, 200);
    assert.deepStrictEqual(await lista.json(), []);
    const painel = await srv.fetch('/');
    assert.strictEqual(painel.status, 200);
    assert.match(await painel.text(), /ChatFlow Painel/);
    const config = await srv.fetch('/app/config.js');
    assert.match(await config.text(), /apiBase: ''/);
  });

  test('Worker sem segredos ainda responde saúde e rejeita API sem chave', async (t) => {
    const srv = subirWorker({}, { comSemente: false });
    t.after(srv.fechar);
    assert.strictEqual((await srv.fetch('/saude')).status, 200);
    assert.strictEqual((await srv.fetch('/empresas')).status, 401);
  });

  test('Worker recusa duas reservas simultâneas sobrepostas para a mesma mesa', async (t) => {
    const { f, fechar } = await subir();
    t.after(fechar);
    assert.strictEqual((await f('/saude')).status, 200);
    const reservar = (chave) => f('/empresas/empresa_1/reservas', {
      token: T.chat,
      method: 'POST',
      body: { ...res, mesaId: 'S1' },
      headers: { 'Idempotency-Key': chave },
    });
    const respostas = await Promise.all([reservar('corrida-1'), reservar('corrida-2')]);
    assert.deepStrictEqual(respostas.map((resposta) => resposta.status).sort(), [200, 201]);
    const resultados = await Promise.all(respostas.map((resposta) => resposta.json()));
    assert.strictEqual(resultados.filter((resultado) => resultado.status === 'confirmada').length, 1);
    const lista = await f('/empresas/empresa_1/reservas', { token: T.integracao });
    assert.strictEqual(lista.status, 200);
    assert.strictEqual((await lista.json()).length, 1);
  });
}

if (WORKER_D1) {
  test('artefato Worker D1: empresa, reserva e anexo do R2 persistem depois de reiniciar o runtime', async (t) => {
    const { mkdtemp, rm } = require('node:fs/promises');
    const { tmpdir } = require('node:os');
    const { join } = require('node:path');
    const persistencia = await mkdtemp(join(tmpdir(), 'chatflow-worker-'));
    const ambiente = { CHATFLOW_TOKEN_INTEGRACAO: T.integracao };
    const headers = { Authorization: `Bearer ${T.integracao}`, 'Content-Type': 'application/json' };
    let srv = subirWorker(ambiente, { comSemente: false, persistencia });
    t.after(async () => {
      await srv.fechar();
      await rm(persistencia, { recursive: true, force: true });
    });

    const criar = (path, dados, extras) => srv.fetch(path, {
      method: 'POST', headers: { ...headers, ...extras }, body: JSON.stringify(dados),
    });
    const nova = await criar('/empresas', { nome: 'Persistência' });
    assert.strictEqual(nova.status, 201);
    const empresa = await nova.json();
    const base = `/empresas/${empresa.id}`;
    const endpoint = base + '/conhecimento';
    assert.strictEqual((await criar(base + '/ambientes', { nome: 'salao' })).status, 201);
    const respostaMesa = await criar(base + '/mesas', { ambiente: 'salao', capacidade: 4, reservavel: true });
    assert.strictEqual(respostaMesa.status, 201);
    const mesa = await respostaMesa.json();
    const respostaReserva = await criar(base + '/reservas', { ...res, mesaId: mesa.id }, { 'Idempotency-Key': 'reabertura' });
    assert.strictEqual(respostaReserva.status, 201);
    const reserva = await respostaReserva.json();
    const texto = 'anexo persistente';
    const anexo = await criar(endpoint, {
      tipo: 'documento', titulo: 'Arquivo', arquivo: { nome: 'anexo.txt', base64: Buffer.from(texto).toString('base64') },
    });
    assert.strictEqual(anexo.status, 201);
    const item = await anexo.json();
    await srv.fechar();

    srv = subirWorker(ambiente, { comSemente: false, persistencia, migrar: false });
    const lista = await srv.fetch('/empresas', { headers });
    assert.strictEqual((await lista.json())[0].nome, 'Persistência');
    const reservas = await srv.fetch(base + '/reservas', { headers });
    assert.strictEqual(reservas.status, 200);
    assert.deepStrictEqual((await reservas.json()).map(({ id, mesaId, status }) => ({ id, mesaId, status })), [
      { id: reserva.reservaId, mesaId: mesa.id, status: 'confirmada' },
    ]);
    const arquivo = await srv.fetch(`${endpoint}/${item.id}/arquivo`, { headers });
    assert.strictEqual(arquivo.status, 200);
    assert.strictEqual(await arquivo.text(), texto);
  });
}

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

test('GET /app/vendor entrega os dois arquivos locais do React como JavaScript', async (t) => {
  const { readFile } = require('node:fs/promises');
  const { join } = require('node:path');
  const { f, fechar } = await subir();
  t.after(fechar);
  for (const nome of ['react.production.min.js', 'react-dom.production.min.js']) {
    const r = await f('/app/vendor/' + nome);
    assert.strictEqual(r.status, 200, nome);
    assert.strictEqual(r.headers.get('content-type'), 'text/javascript; charset=utf-8', nome);
    assert.deepStrictEqual(Buffer.from(await r.arrayBuffer()), await readFile(join(__dirname, '..', 'web', 'vendor', nome)), nome);
  }
});

test('CORS: sem a variável, OPTIONS responde 204 sem nenhum cabeçalho Access-Control-*', async () => {
  const { f, fechar } = await subir();
  const r = await f('/empresas', { method: 'OPTIONS', headers: { Origin: ORIGEM, 'Access-Control-Request-Method': 'GET' } });
  assert.strictEqual(r.status, 204);
  for (const h of ['allow-origin', 'allow-methods', 'allow-headers', 'max-age', 'allow-credentials']) {
    assert.strictEqual(r.headers.get('access-control-' + h), null, h);
  }
  assert.strictEqual(r.headers.get('vary'), null);
  fechar();
});

// ---- portabilidade (TASK-005): núcleo chamado direto, plataforma alternativa e núcleo sem Node ----

const nucleoMod = require('../src/nucleo');
const { plataformaWeb } = require('../src/plataforma');
const { plataformaNode } = require('../src/node/plataforma');

// Uma bateria de contrato escrita contra uma função `chamar(metodo, caminho, { token, corpo, headers })` que devolve
// { status, headers, corpo }. Roda sobre tratar() direto e sobre o servidor Node; devolve a transcrição (sem segredos).
async function bateria(chamar) {
  const t = [];
  const reg = (nome, r, extra) => t.push([nome, r.status, extra === undefined ? null : extra]);
  const TOK = { token: 'ti-bat' };

  reg('saude', await chamar('GET', '/saude'), (await chamar('GET', '/saude')).corpo);
  reg('sem token', await chamar('GET', '/empresas'));
  reg('rota inexistente', await chamar('GET', '/nada', TOK));
  const criada = await chamar('POST', '/empresas', { ...TOK, corpo: { nome: 'Cantina Bateria' } });
  reg('criar empresa', criada, criada.corpo);
  const id = criada.corpo.id;
  reg('nome repetido', await chamar('POST', '/empresas', { ...TOK, corpo: { nome: 'cantina bateria' } }));
  reg('ambiente', await chamar('POST', `/empresas/${id}/ambientes`, { ...TOK, corpo: { nome: 'salao' } }));
  const mesa = await chamar('POST', `/empresas/${id}/mesas`, { ...TOK, corpo: { ambiente: 'salao', capacidade: 4 } });
  reg('mesa', mesa, mesa.corpo);

  const res = { data: '2026-11-20', horario: '23:30', pessoas: 2, ambiente: 'salao' };
  const a = await chamar('POST', `/empresas/${id}/reservas`, { ...TOK, corpo: res, headers: { 'idempotency-key': 'k1' } });
  const b = await chamar('POST', `/empresas/${id}/reservas`, { ...TOK, corpo: res, headers: { 'idempotency-key': 'k1' } });
  assert.match(a.corpo.reservaId, CODIGO_RESERVA);
  assert.deepStrictEqual(b.corpo, a.corpo);
  reg('reserva criada', a, { ...a.corpo, reservaId: '<codigo>' });
  reg('reserva repetida (idempotente)', b, { ...b.corpo, reservaId: '<codigo>' });
  const c = await chamar('POST', `/empresas/${id}/reservas`, { ...TOK, corpo: { ...res, data: '2026-11-21', horario: '00:30' }, headers: { 'idempotency-key': 'k2' } });
  reg('cruza a meia-noite: indisponível', c, c.corpo.status);
  reg('reserva sem chave', await chamar('POST', `/empresas/${id}/reservas`, { ...TOK, corpo: res }));
  reg('corpo não-JSON', await chamar('POST', `/empresas/${id}/reservas`, { ...TOK, corpo: '{ruim', headers: { 'idempotency-key': 'k3' } }));
  reg('data impossível', await chamar('GET', `/empresas/${id}/mapa?data=2026-02-30&horario=10:00`, TOK));

  const conteudo = 'Preço da pizza: 50 reais';
  const doc = await chamar('POST', `/empresas/${id}/conhecimento`, {
    ...TOK, corpo: { tipo: 'documento', titulo: 'Cardápio', arquivo: { nome: 'cardapio.txt', base64: Buffer.from(conteudo).toString('base64') } },
  });
  reg('documento', doc, doc.corpo.arquivo.tamanho);
  const arq = await chamar('GET', `/empresas/${id}/conhecimento/${doc.corpo.id}/arquivo`, TOK);
  reg('download binário', arq, [arq.headers['x-content-type-options'], arq.headers['content-security-policy'], Buffer.from(arq.corpo).toString('utf8')]);
  const pdfRuim = await chamar('POST', `/empresas/${id}/conhecimento`, { ...TOK, corpo: { tipo: 'documento', titulo: 'x', arquivo: { nome: 'x.pdf', base64: Buffer.from('nao e pdf').toString('base64') } } });
  reg('pdf falso', pdfRuim, pdfRuim.corpo.erro);
  const busca = await chamar('GET', `/empresas/${id}/conhecimento/buscar?q=pizza`, TOK);
  reg('busca', busca, busca.corpo.total);

  const chave = await chamar('POST', `/empresas/${id}/api/chave`, { ...TOK, corpo: {} });
  reg('gerar chave', chave, Object.keys(chave.corpo).sort());
  const comChave = await chamar('GET', `/empresas/${id}/agente`, { token: chave.corpo.chave });
  reg('chave da empresa lê o agente', comChave);
  reg('chave da empresa não vê outras rotas', await chamar('GET', '/empresas', { token: chave.corpo.chave }));
  const hist = await chamar('GET', `/empresas/${id}/historico`, TOK);
  reg('histórico', hist, hist.corpo.map((e) => e.acao).sort());
  return t;
}

function chamarTratar(ctx) {
  return async (metodo, caminho, { token, corpo, headers } = {}) => {
    const bytes = corpo === undefined ? null : new TextEncoder().encode(typeof corpo === 'string' ? corpo : JSON.stringify(corpo));
    const r = await nucleoMod.tratar({
      metodo, url: caminho, ip: '127.0.0.1', corpo: bytes,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers || {}) },
    }, ctx);
    const h = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v]));
    return { status: r.status, headers: h, corpo: r.corpo };
  };
}

function ctxCom(plat) {
  const store = criarStore({ plat });
  return nucleoMod.criarContexto({ store, tokens: { integracao: 'ti-bat' } });
}

test('núcleo: tratar() direto, sem rede, passa a bateria de contrato', INTERNO, async () => {
  const t = await bateria(chamarTratar(ctxCom(plataformaNode())));
  const status = Object.fromEntries(t.map(([n, s]) => [n, s]));
  assert.strictEqual(status['saude'], 200);
  assert.strictEqual(status['sem token'], 401);
  assert.strictEqual(status['criar empresa'], 201);
  assert.strictEqual(status['reserva criada'], 201);
  assert.strictEqual(status['reserva repetida (idempotente)'], 201);
  assert.strictEqual(status['download binário'], 200);
  assert.strictEqual(status['pdf falso'], 400);
  assert.strictEqual(status['data impossível'], 400);
});

test('núcleo: plataforma alternativa (crypto.subtle) dá exatamente o mesmo resultado que a do Node', INTERNO, async () => {
  const noNode = await bateria(chamarTratar(ctxCom(plataformaNode())));
  const web = await bateria(chamarTratar(ctxCom(plataformaWeb())));
  assert.deepStrictEqual(web, noNode);
});

test('D1: a bateria do núcleo preserva respostas e ordem de chaves da memória', INTERNO, async (t) => {
  const { abrirD1 } = require('./auxiliar/d1.cjs');
  const { abrir } = await abrirD1(t);
  const ctx = nucleoMod.criarContexto({ store: abrir(), tokens: { integracao: 'ti-bat' } });
  const esperado = await bateria(chamarTratar(ctxCom(plataformaNode())));
  const d1 = await bateria(chamarTratar(ctx));
  assert.strictEqual(JSON.stringify(d1), JSON.stringify(esperado));
});

test('núcleo: a mesma bateria pelo servidor Node (adaptador) devolve a mesma transcrição', INTERNO, async () => {
  const noNucleo = await bateria(chamarTratar(ctxCom(plataformaNode())));
  const s = criarStore();
  const srv = criarServidor(s, { integracao: 'ti-bat' });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const http = async (metodo, caminho, { token, corpo, headers } = {}) => {
    const r = await fetch(base + caminho, {
      method: metodo,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(corpo !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(headers || {}) },
      body: corpo === undefined ? undefined : (typeof corpo === 'string' ? corpo : JSON.stringify(corpo)),
    });
    const buf = new Uint8Array(await r.arrayBuffer());
    const tipo = r.headers.get('content-type') || '';
    return { status: r.status, headers: Object.fromEntries(r.headers.entries()), corpo: tipo.startsWith('application/json') ? JSON.parse(new TextDecoder().decode(buf)) : buf };
  };
  const viaHttp = await bateria(http);
  srv.close();
  assert.deepStrictEqual(viaHttp, noNucleo);
});

test('plataformas: sha256, base64 (4 MB), tempo constante e aleatório são equivalentes', INTERNO, async () => {
  const pn = plataformaNode(), pw = plataformaWeb();
  assert.strictEqual(await pn.sha256Hex('chave-secreta'), await pw.sha256Hex('chave-secreta'));
  assert.strictEqual(await pw.sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  const grande = new Uint8Array(4 * 1024 * 1024).map((_, i) => (i * 31) % 251);
  const b64 = pw.base64Codificar(grande);
  assert.strictEqual(b64, pn.base64Codificar(grande));
  assert.deepStrictEqual(pw.base64Decodificar(b64), grande);
  assert.deepStrictEqual(pn.base64Decodificar(b64), grande);
  for (const p of [pn, pw]) {
    assert.deepStrictEqual(Array.from(p.base64Decodificar('QUJD\nREVG')), [65, 66, 67, 68, 69, 70], 'tolera quebra de linha');
    assert.deepStrictEqual(Array.from(p.base64Decodificar('QQ')), [65], 'tolera falta de padding');
    assert.throws(() => p.base64Decodificar('A$B='), /base64/);
    assert.throws(() => p.base64Decodificar('A'), /base64/);
    assert.strictEqual(p.iguaisTempoConstante('abc', 'abc'), true);
    assert.strictEqual(p.iguaisTempoConstante('abc', 'abd'), false);
    assert.strictEqual(p.iguaisTempoConstante('abc', 'abcd'), false);
    assert.match(p.aleatorio(32), /^[A-Za-z0-9_-]{43}$/);
    assert.notStrictEqual(p.aleatorio(32), p.aleatorio(32));
    assert.match(p.uuid(), /^[0-9a-f-]{36}$/);
  }
});

test('núcleo sem Node: nenhum arquivo de src/ (fora de src/node/) usa require(, node:, Buffer ou process.', INTERNO, () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'src');
  const arquivos = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(arquivos.includes('nucleo.js') && arquivos.includes('repositorio.js') && arquivos.includes('plataforma.js'));
  const semComentarios = (txt) => txt.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');
  const proibidos = [/\brequire\(/, /node:/, /\bBuffer\b/, /\bprocess\./];
  for (const f of arquivos) {
    const codigo = semComentarios(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const re of proibidos) assert.ok(!re.test(codigo), `${f} usa ${re}`);
  }
  // e o adaptador, ao contrário, é onde o Node vive
  assert.match(fs.readFileSync(path.join(dir, 'node', 'servidor.js'), 'utf8'), /node:http/);
});

function testeRepositorio(nome, verificar) {
  test(nome, INTERNO, () => verificar(criarStore));
  test(`D1: ${nome}`, INTERNO, async (t) => {
    const { abrirD1 } = require('./auxiliar/d1.cjs');
    const d1 = await abrirD1(t);
    await verificar(d1.abrir);
  });
}

testeRepositorio('repositório: reservaCriar rechecando a sobreposição devolve conflito e não grava nada', async (abrir) => {
  const s = abrir();
  await addEmpresa(s, { id: 'empresa_1', nome: 'E', ambientes: [{ nome: 'salao', mesas: [{ id: 'S1', capacidade: 4, reservavel: true }] }], agente: {} });
  const entrada = (inicio, chave) => ({ empresaId: 'empresa_1', chave, candidatas: [{ mesaId: 'S1', ambiente: 'salao' }], reserva: { data: '2026-11-20', horario: '20:00', pessoas: 2, inicio, fim: inicio + 90 } });
  const a = await s.reservaCriar(entrada(1000, 'k1'));
  assert.strictEqual(a.criada, true);
  const rep = await s.reservaCriar(entrada(1000, 'k1'));
  assert.deepStrictEqual([rep.criada, rep.resposta], [false, a.resposta]);
  assert.deepStrictEqual(await s.reservaCriar(entrada(1089, 'k2')), { conflito: true });
  assert.strictEqual((await s.reservaCriar(entrada(1090, 'k3'))).criada, true);
  assert.strictEqual((await s.reservaListar('empresa_1')).length, 2);
});

// ---- TASK-006: o corpo só é lido depois de autenticar, com o limite da rota ----

test('corpo: sem token, com chave errada ou em rota inexistente o núcleo não lê o corpo', INTERNO, async () => {
  const ctx = ctxCom(plataformaNode());
  const chamadas = [];
  const req = (metodo, url, token) => ({
    metodo, url, ip: '127.0.0.1',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    lerCorpo: async (limite) => { chamadas.push([metodo, url, limite]); return new TextEncoder().encode('{"nome":"X"}'); },
  });
  assert.strictEqual((await nucleoMod.tratar(req('POST', '/empresas'), ctx)).status, 401);
  assert.strictEqual((await nucleoMod.tratar(req('POST', '/empresas', 'errada'), ctx)).status, 401);
  assert.strictEqual((await nucleoMod.tratar(req('POST', '/saude'), ctx)).status, 401);
  assert.strictEqual((await nucleoMod.tratar(req('POST', '/nada', 'ti-bat'), ctx)).status, 404);
  assert.strictEqual((await nucleoMod.tratar(req('OPTIONS', '/empresas'), ctx)).status, 204);
  assert.deepStrictEqual(chamadas, [], 'nenhuma leitura de corpo antes de autenticar');
  // autenticado, a rota que precisa do corpo lê com o limite dela
  assert.strictEqual((await nucleoMod.tratar(req('POST', '/empresas', 'ti-bat'), ctx)).status, 201);
  assert.deepStrictEqual(chamadas, [['POST', '/empresas', 512 * 1024]]);
});

test('corpo: documento de conhecimento usa o limite de 6 MiB; as demais rotas, 512 KiB', INTERNO, async () => {
  const ctx = ctxCom(plataformaNode());
  const limites = [];
  const chamar = (metodo, url, corpo) => nucleoMod.tratar({
    metodo, url, ip: '127.0.0.1', headers: { authorization: 'Bearer ti-bat' },
    lerCorpo: async (limite) => { limites.push(limite); return new TextEncoder().encode(JSON.stringify(corpo)); },
  }, ctx);
  const e = (await chamar('POST', '/empresas', { nome: 'Lim' })).corpo;
  await chamar('POST', `/empresas/${e.id}/conhecimento`, { tipo: 'texto', titulo: 't', texto: 'x' });
  assert.deepStrictEqual(limites, [512 * 1024, 6 * 1024 * 1024]);
});

test('corpo HTTP: 413 com JSON no limite certo; sem token a resposta é 401 mesmo com corpo enorme', async () => {
  const { f, fechar } = await subir();
  const grande = (n) => ({ nome: 'x'.repeat(n) });
  const a = await f('/empresas', { token: T.cliente, method: 'POST', body: grande(600 * 1024) });
  assert.strictEqual(a.status, 413);
  assert.deepStrictEqual(await a.json(), { erro: 'corpo grande demais' });
  if (WORKER) {
    const unicode = await f('/empresas', { token: T.cliente, method: 'POST', body: { nome: 'á'.repeat(300 * 1024) } });
    assert.strictEqual(unicode.status, 413);
    const arquivoExcessivo = await f('/empresas/empresa_1/conhecimento', {
      token: T.cliente, method: 'POST', body: { titulo: 'x'.repeat(6 * 1024 * 1024) },
    });
    assert.strictEqual(arquivoExcessivo.status, 413);
  }
  const b = await f('/empresas', { method: 'POST', body: grande(2 * 1024 * 1024) });
  assert.strictEqual(b.status, 401);
  // documento de 5 MB em base64 passa do limite comum, mas cabe no de conhecimento
  const txt = Buffer.concat([Buffer.from('PK', 'latin1'), Buffer.alloc(3 * 1024 * 1024, 1)]).toString('base64');
  const c = await f('/empresas/empresa_1/conhecimento', { token: T.cliente, method: 'POST', body: { tipo: 'documento', titulo: 'grande', arquivo: { nome: 'g.docx', base64: txt } } });
  assert.strictEqual(c.status, 201);
  // o servidor continua atendendo depois de derrubar a conexão do corpo grande
  assert.strictEqual((await f('/saude')).status, 200);
  fechar();
});

// ---- TASK-009: idempotência com validade e teto (a memória não cresce sem limite) ----

// Plataforma do Node com relógio controlado pelo teste
function plataformaRelogio(relogio) {
  return { ...plataformaNode(), agora: () => relogio.t };
}

testeRepositorio('idempotência: a resposta expirada some e a chave é esquecida', async (abrir) => {
  const relogio = { t: 1_000_000 };
  const s = abrir({ plat: plataformaRelogio(relogio), idempotenciaTtlMs: 60_000 });
  await addEmpresa(s, { id: 'e1', nome: 'Empresa 1', ambientes: [], agente: {} });
  await s.idempotenciaGravar('e1', 'k1', { status: 'indisponivel', n: 1 });
  relogio.t += 59_999;
  assert.deepStrictEqual(await s.idempotenciaObter('e1', 'k1'), { status: 'indisponivel', n: 1 }, 'ainda vale 1 ms antes de vencer');
  relogio.t += 1; // 60 s depois da gravação
  assert.strictEqual(await s.idempotenciaObter('e1', 'k1'), null);
  assert.strictEqual(await s.idempotenciaTamanho('e1'), 0, 'a entrada vencida foi apagada');
});

testeRepositorio('idempotência: gravar varre o que já venceu, sem esperar alguém consultar', async (abrir) => {
  const relogio = { t: 5_000_000 };
  const s = abrir({ plat: plataformaRelogio(relogio), idempotenciaTtlMs: 1000 });
  await addEmpresa(s, { id: 'e1', nome: 'Empresa 1', ambientes: [], agente: {} });
  for (let i = 0; i < 50; i++) await s.idempotenciaGravar('e1', `k${i}`, { i });
  relogio.t += 1000;
  await s.idempotenciaGravar('e1', 'nova', { i: 'nova' });
  assert.strictEqual(await s.idempotenciaTamanho('e1'), 1, 'só a nova ficou');
});

testeRepositorio('idempotência: o teto por empresa é respeitado e as mais antigas saem primeiro', async (abrir) => {
  const relogio = { t: 1 };
  const s = abrir({ plat: plataformaRelogio(relogio), idempotenciaMax: 3 });
  await addEmpresa(s, { id: 'e1', nome: 'Empresa 1', ambientes: [], agente: {} });
  await addEmpresa(s, { id: 'e2', nome: 'Empresa 2', ambientes: [], agente: {} });
  for (let i = 1; i <= 5; i++) { relogio.t += 10; await s.idempotenciaGravar('e1', `k${i}`, { i }); }
  await s.idempotenciaGravar('e2', 'x', { x: 1 });
  assert.strictEqual(await s.idempotenciaTamanho('e1'), 3);
  assert.strictEqual(await s.idempotenciaObter('e1', 'k1'), null);
  assert.strictEqual(await s.idempotenciaObter('e1', 'k2'), null);
  for (const i of [3, 4, 5]) assert.deepStrictEqual(await s.idempotenciaObter('e1', `k${i}`), { i });
  assert.deepStrictEqual(await s.idempotenciaObter('e2', 'x'), { x: 1 }, 'o teto é por empresa: a outra não perde nada');
  // regravar a chave a torna a mais nova
  await s.idempotenciaGravar('e1', 'k3', { i: '3b' });
  await s.idempotenciaGravar('e1', 'k6', { i: 6 });
  assert.deepStrictEqual(await s.idempotenciaObter('e1', 'k3'), { i: '3b' });
  assert.strictEqual(await s.idempotenciaObter('e1', 'k4'), null);
});

testeRepositorio('idempotência: excluir a empresa apaga as respostas guardadas dela', async (abrir) => {
  const s = abrir();
  await addEmpresa(s, { id: 'e1', nome: 'E', ambientes: [], agente: {} });
  await s.idempotenciaGravar('e1', 'k', { a: 1 });
  await s.empresaExcluir('e1', { empresaId: 'e1', entidade: 'empresa', entidadeId: 'e1', acao: 'excluida', antes: {}, depois: {} });
  assert.strictEqual(await s.idempotenciaTamanho('e1'), 0);
});

testeRepositorio('idempotência via HTTP: mesma chave dentro da validade devolve a resposta idêntica; vencida, a chave é esquecida', async (abrir) => {
  const relogio = { t: 2_000_000 };
  const s = abrir({ plat: plataformaRelogio(relogio), idempotenciaTtlMs: 3_600_000 });
  await addEmpresa(s, { id: 'empresa_1', nome: 'e', ambientes: [{ nome: 'salao', mesas: [{ id: 'S1', capacidade: 4, reservavel: true }] }], agente: {} });
  const srv = criarServidor(s, T, { agora: () => relogio.t });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const reservar = (chave, extra = {}) => fetch(`${base}/empresas/empresa_1/reservas`, {
    method: 'POST', headers: { Authorization: `Bearer ${T.chat}`, 'Content-Type': 'application/json', 'Idempotency-Key': chave },
    body: JSON.stringify({ data: '2026-11-20', horario: '20:00', pessoas: 2, ambiente: 'salao', ...extra }),
  }).then(async (r) => ({ status: r.status, corpo: await r.json() }));

  const a = await reservar('k1');
  assert.strictEqual(a.status, 201);
  relogio.t += 3_599_999;
  assert.deepStrictEqual(await reservar('k1'), a, 'dentro da validade a resposta é idêntica (mesma reserva, sem duplicar)');
  assert.strictEqual((await s.reservaListar('empresa_1')).length, 1);
  // a "indisponivel" também fica guardada e também vence
  const b = await reservar('k2');
  assert.strictEqual(b.corpo.status, 'indisponivel');
  assert.deepStrictEqual(await reservar('k2'), b);
  relogio.t += 3_600_000;
  const c = await reservar('k1');
  assert.strictEqual(c.corpo.status, 'indisponivel', 'vencida, a chave k1 não repete mais a confirmação antiga: o pedido é tratado de novo');
  assert.strictEqual((await s.reservaListar('empresa_1')).length, 1, 'e a mesa continua ocupada pela reserva original');
  srv.close();
});

test('descrição do local da mesa: valida uma linha até 150 caracteres e aparece em estrutura, mapa, disponibilidade e histórico', async () => {
  const { f, fechar } = await subir();
  const base = '/empresas/empresa_1';
  const editar = (body) => f(`${base}/mesas/S1`, { token: T.cliente, method: 'PATCH', body });
  const daEstrutura = async () => (await (await f(`${base}/estrutura`, { token: T.cliente })).json()).ambientes[0].mesas;
  const doMapa = async () => (await (await f(`${base}/mapa?data=2026-11-20&horario=20:00`, { token: T.cliente })).json())[0].mesas[0];
  const livre = async () => (await (await f(`${base}/disponibilidade?data=2026-11-20&horario=20:00&pessoas=2`, { token: T.chat })).json()).ambientes[0].mesas[0];

  // sem descrição, o formato das respostas não muda
  assert.ok(!('descricao' in (await daEstrutura())[0]));
  assert.ok(!('descricao' in (await doMapa())));
  assert.ok(!('descricao' in (await livre())));

  // 150 caracteres acentuados passam (contagem por caractere, não por byte); 151 não
  const cheio = 'á'.repeat(150);
  assert.strictEqual((await editar({ descricao: cheio })).status, 200);
  for (const ruim of ['á'.repeat(151), 'primeira\nsegunda', 'com\ttabulação', 10, null, ['x']]) {
    const r = await editar({ descricao: ruim });
    assert.strictEqual(r.status, 400, JSON.stringify(ruim));
  }
  assert.strictEqual((await daEstrutura())[0].descricao, cheio);

  const texto = 'Encostada na parede do bar, com visão para a entrada';
  const r = await editar({ descricao: `  ${texto}  ` });
  assert.strictEqual((await r.json()).descricao, texto);
  assert.strictEqual((await daEstrutura())[0].descricao, texto);
  assert.strictEqual((await doMapa()).descricao, texto);
  assert.strictEqual((await livre()).descricao, texto);

  // editar outro campo preserva a descrição
  await editar({ capacidade: 6 });
  assert.strictEqual((await daEstrutura())[0].descricao, texto);

  // mesa nova com descrição; inválida não cria
  const criar = (body) => f(`${base}/mesas`, { token: T.cliente, method: 'POST', body: { ambiente: 'salao', capacidade: 2, ...body } });
  assert.strictEqual((await criar({ descricao: 'x'.repeat(151) })).status, 400);
  assert.strictEqual((await daEstrutura()).length, 1);
  const nova = await (await criar({ descricao: 'Perto da área verde' })).json();
  assert.strictEqual(nova.descricao, 'Perto da área verde');
  assert.strictEqual((await daEstrutura())[1].descricao, 'Perto da área verde');

  // vazio apaga
  assert.strictEqual((await editar({ descricao: '   ' })).status, 200);
  assert.ok(!('descricao' in (await daEstrutura())[0]));

  const hist = await (await f(`${base}/historico?entidade=mesa&id=S1`, { token: T.cliente })).json();
  const mudancas = hist.filter((e) => e.depois && 'descricao' in e.depois).map((e) => [e.antes.descricao, e.depois.descricao]);
  assert.deepStrictEqual(mudancas.sort((a, b) => a[0].length - b[0].length), [['', cheio], [texto, ''], [cheio, texto]].sort((a, b) => a[0].length - b[0].length));
  fechar();
});
