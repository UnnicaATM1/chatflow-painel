'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { criarRepositorioSqlite } = require('../src/sqlite/repositorio');
const { criarRepositorioMemoria } = require('../src/repositorio');
const { plataformaWeb } = require('../src/plataforma');
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

for (const modo of ['memoria', 'sqlite']) {
  test(`${modo}: colisões são sorteadas novamente e códigos emitidos ficam reservados por empresa`, async (t) => {
    const sorteios = [0, 0, 0, 1, 0, 2];
    const plat = {
      ...plataformaWeb(),
      aleatorio(tamanho) {
        assert.ok(sorteios.length, 'houve sorteio inesperado');
        return Buffer.alloc(tamanho, sorteios.shift()).toString('base64url');
      },
    };
    const disco = modo === 'sqlite' ? arquivoDeTeste(t) : null;
    let store = disco ? disco.abrir({ plat }) : criarRepositorioMemoria({ plat });
    await store.empresaCriar(empresa);
    await store.empresaCriar({ ...empresa, id: 'empresa_2', nome: 'Outra empresa' });
    const primeira = await store.reservaCriar(pedido('primeira'));
    const paralela = await store.reservaCriar({ ...pedido('outra'), empresaId: 'empresa_2' });
    assert.equal(primeira.resposta.reservaId, '22222222');
    assert.equal(paralela.resposta.reservaId, primeira.resposta.reservaId);
    assert.equal((await store.reservaObter('empresa_2', '22222222')).empresaId, 'empresa_2');
    await store.reservaCancelar(empresa.id, primeira.resposta.reservaId);
    const nova = await store.reservaCriar(pedido('mesma-empresa'));
    assert.equal(nova.resposta.reservaId, '33333333');
    await store.empresaExcluir(empresa.id, { empresaId: empresa.id, entidade: 'empresa', entidadeId: empresa.id, acao: 'excluida' });
    if (disco) {
      await disco.fechar(store);
      store = disco.abrir({ plat });
    }
    await store.empresaCriar(empresa);
    const recriada = await store.reservaCriar(pedido('empresa-recriada'));
    assert.equal(recriada.resposta.reservaId, '44444444');
    assert.equal(await store.reservaObter(empresa.id, '22222222'), null);
    assert.deepEqual(sorteios, []);
  });
}

function arquivoDeTeste(t) {
  const configurado = process.env.CHATFLOW_BANCO_ARQUIVO;
  const pasta = configurado && configurado !== ':memory:' ? dirname(resolve(configurado)) : tmpdir();
  const dir = mkdtempSync(join(pasta, 'chatflow-sqlite-'));
  const abertos = new Set();
  const conexoesSql = [];
  t.after(async () => {
    for (const db of conexoesSql) db.close();
    await Promise.all([...abertos].map((store) => store.fechar()));
    rmSync(dir, { recursive: true, force: true });
  });
  const caminho = join(dir, 'teste.sqlite');
  const abrirSql = () => {
    const db = new DatabaseSync(caminho);
    conexoesSql.push(db);
    return db;
  };
  const abrir = (opcoes) => {
    const store = criarRepositorioSqlite({ ...opcoes, caminho });
    abertos.add(store);
    return store;
  };
  const fechar = async (store) => {
    await store.fechar();
    abertos.delete(store);
  };
  return { caminho, abrir, fechar, abrirSql };
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

test('SQLite: dados, idempotência e código de reserva sobrevivem ao fechar e reabrir o arquivo', async (t) => {
  const { abrir, fechar, abrirSql } = arquivoDeTeste(t);
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
  const linha = abrirSql().prepare('SELECT id, codigo FROM reservas').get();
  assert.match(linha.id, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  assert.equal(linha.codigo, criada.reserva.id);
  assert.ok(!JSON.stringify(criada).includes(linha.id));
  await segunda.reservaCancelar(empresa.id, criada.reserva.id);
  const seguinte = await segunda.reservaCriar(pedido('seguinte'));
  assert.notEqual(seguinte.reserva.id, criada.reserva.id);
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

test('SQLite: gatilhos recusam sobreposição no INSERT e UPDATE de reservas confirmadas', async (t) => {
  const { abrir, abrirSql } = arquivoDeTeste(t);
  const store = abrir();
  await store.empresaCriar(empresa);
  await store.empresaCriar({ ...empresa, id: 'empresa_2', nome: 'Outra empresa' });
  const db = abrirSql();
  const ins = db.prepare(`INSERT INTO reservas
    (id, codigo, empresa_id, mesa_id, ambiente, data, horario, pessoas, inicio, fim, status)
    VALUES (?, ?, ?, ?, 'salão', '2026-11-20', '20:00', 2, ?, ?, ?)`);
  const inserir = (...params) => {
    const id = randomUUID();
    ins.run(id, ...params);
    return id;
  };
  const primeira = inserir('22222222', empresa.id, 'S1', 100, 190, 'confirmada');
  assert.throws(() => inserir('33333333', empresa.id, 'S1', 150, 240, 'confirmada'), /sobreposicao/);
  const cancelada = inserir('44444444', empresa.id, 'S1', 150, 240, 'cancelada');
  const adjacente = inserir('55555555', empresa.id, 'S1', 190, 280, 'confirmada');
  const outraMesa = inserir('66666666', empresa.id, 'S2', 150, 240, 'confirmada');
  const outraEmpresa = inserir('77777777', 'empresa_2', 'S1', 150, 240, 'confirmada');
  assert.throws(() => db.prepare("UPDATE reservas SET status = 'confirmada' WHERE id = ?").run(cancelada), /sobreposicao/);
  assert.throws(() => db.prepare('UPDATE reservas SET inicio = 189 WHERE id = ?').run(adjacente), /sobreposicao/);
  assert.throws(() => db.prepare('UPDATE reservas SET fim = 191 WHERE id = ?').run(primeira), /sobreposicao/);
  assert.throws(() => db.prepare("UPDATE reservas SET mesa_id = 'S1' WHERE id = ?").run(outraMesa), /sobreposicao/);
  assert.throws(() => db.prepare('UPDATE reservas SET empresa_id = ? WHERE id = ?').run(empresa.id, outraEmpresa), /sobreposicao/);
  db.prepare('UPDATE reservas SET fim = 290 WHERE id = ?').run(adjacente);
  assert.equal((await store.reservaObter(empresa.id, '55555555')).fim, 290);
});

test('SQLite: a FK recusa idempotência órfã e o DELETE da empresa limpa apenas suas chaves', async (t) => {
  const { abrir, abrirSql } = arquivoDeTeste(t);
  const store = abrir();
  await store.empresaCriar(empresa);
  await store.empresaCriar({ ...empresa, id: 'empresa_2', nome: 'Outra empresa' });
  const db = abrirSql();
  const ins = db.prepare("INSERT INTO idempotencia (empresa_id, chave, resposta, criada_em) VALUES (?, 'mesma-chave', '{}', 1000)");
  assert.throws(() => ins.run('inexistente'), /FOREIGN KEY/);
  ins.run(empresa.id);
  ins.run('empresa_2');
  db.prepare('DELETE FROM empresas WHERE id = ?').run(empresa.id);
  assert.equal(await store.idempotenciaTamanho(empresa.id), 0);
  assert.equal(await store.idempotenciaTamanho('empresa_2'), 1);
});

test('SQLite: busca por hash usa índice e acompanha rotação e revogação da chave', async (t) => {
  const { abrir, abrirSql } = arquivoDeTeste(t);
  let comparacoes = 0;
  const plat = {
    ...plataformaWeb(),
    iguaisTempoConstante(a, b) { comparacoes++; return a === b; },
  };
  const store = abrir({ plat });
  await store.empresaCriar(empresa);
  const hash = 'a'.repeat(64);
  const novo = 'b'.repeat(64);
  await store.chaveDefinir(empresa.id, { hash });
  assert.equal(await store.empresaPorChaveHash(novo), null);
  assert.equal(comparacoes, 0);
  assert.equal(await store.empresaPorChaveHash(hash), empresa.id);
  assert.equal(comparacoes, 1);

  const plano = abrirSql().prepare(`EXPLAIN QUERY PLAN
    SELECT id, chave_hash FROM empresas WHERE chave_hash = ? ORDER BY rowid LIMIT 1`).all(hash);
  assert.match(plano.map((linha) => linha.detail).join('\n'), /SEARCH .*empresas_por_chave_hash/);
  await store.chaveDefinir(empresa.id, { hash: novo });
  assert.equal(await store.empresaPorChaveHash(hash), null);
  assert.equal(await store.empresaPorChaveHash(novo), empresa.id);
  await store.chaveRemover(empresa.id);
  assert.equal(await store.empresaPorChaveHash(novo), null);
});

test('SQLite: nome da empresa é único sem diferenciar maiúsculas na criação e renomeação', async (t) => {
  const { abrir, abrirSql } = arquivoDeTeste(t);
  const store = abrir();
  await store.empresaCriar({ ...empresa, nome: 'Árvore' });
  await store.empresaCriar({ ...empresa, id: 'empresa_2', nome: 'Cantina' });
  assert.equal(await store.empresaNomeEmUso('ÁRVORE'), true);
  assert.equal(await store.empresaNomeEmUso('ÁRVORE', empresa.id), false);
  await assert.rejects(store.empresaCriar({ ...empresa, id: 'empresa_3', nome: 'árvore' }), /UNIQUE constraint/);
  await assert.rejects(store.empresaRenomear('empresa_2', 'ÁRVORE'), /UNIQUE constraint/);
  assert.equal((await store.empresaObter('empresa_2')).nome, 'Cantina');
  const db = abrirSql();
  assert.throws(() => db.exec("INSERT INTO empresas (id, nome, agente, modulos) VALUES ('empresa_4', 'CANTINA', '{}', '{}')"), /UNIQUE constraint/);
});

test('SQLite: JSON do histórico mantém a ordem das chaves do repositório em memória', async (t) => {
  const { abrir, fechar } = arquivoDeTeste(t);
  const plat = { ...plataformaWeb(), agora: () => 1_000_000, uuid: () => 'boot-de-teste' };
  const memoria = criarRepositorioMemoria({ plat });
  const store = abrir({ plat });
  const evento = {
    empresaId: empresa.id, entidade: 'reserva', entidadeId: '22222222', acao: 'editada',
    antes: { pessoas: 2, status: 'confirmada' }, depois: { pessoas: 3, status: 'confirmada' },
  };
  const esperado = JSON.stringify(await memoria.historicoAcrescentar(evento));
  const gravado = await store.historicoAcrescentar(evento);
  assert.equal(JSON.stringify(gravado), esperado);
  await fechar(store);
  const reaberto = abrir({ plat });
  assert.equal(JSON.stringify(await reaberto.historicoObter(empresa.id, gravado.seq)), esperado);
  assert.equal(JSON.stringify((await reaberto.historicoListar(empresa.id))[0]), esperado);
});

test('SQLite: tentativas administrativas começam em zero e a primeira gravação cria a linha global', async (t) => {
  const { abrir, abrirSql } = arquivoDeTeste(t);
  const store = abrir();
  const db = abrirSql();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tentativas_admin').get().n, 0);
  assert.deepEqual(await store.tentativasAdminObter(), { n: 0, ate: 0 });
  await store.tentativasAdminGravar({ n: 1, ate: 0 });
  await store.tentativasAdminGravar({ n: 5, ate: 1000 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tentativas_admin').get().n, 1);
  assert.deepEqual(await store.tentativasAdminObter(), { n: 5, ate: 1000 });
});

test('SQLite: documento de 4 MiB fica fora da linha e sobrevive à reabertura do banco', async (t) => {
  const { caminho, abrir, fechar, abrirSql } = arquivoDeTeste(t);
  const primeira = abrir();
  await primeira.empresaCriar(empresa);
  const bytes = Buffer.alloc(4 * 1024 * 1024, 42);
  const arquivo = { nome: 'menu.pdf', mime: 'application/pdf', tamanho: bytes.length, base64: bytes.toString('base64') };
  const entrada = { tipo: 'documento', titulo: 'Menu', arquivo };
  const { item } = await primeira.conhecimentoCriar(empresa.id, entrada, 10);
  assert.deepEqual(item.arquivo, arquivo);

  const db = abrirSql();
  const linha = db.prepare('SELECT item FROM conhecimento WHERE empresa_id = ? AND id = ?');
  const json = linha.get(empresa.id, item.id).item;
  assert.ok(json.length < 1024);
  const guardado = JSON.parse(json);
  assert.match(guardado.arquivoChave, /^empresas\/empresa_1\/conhecimento\/[a-f0-9-]{36}$/);
  assert.equal(Object.hasOwn(guardado.arquivo, 'base64'), false);
  const pasta = `${caminho}.arquivos`;
  const nome = guardado.arquivoChave.split('/').at(-1);
  assert.ok(readFileSync(join(pasta, nome)).equals(bytes));
  assert.throws(() => db.prepare('UPDATE conhecimento SET item = ?').run(JSON.stringify(item)), /CHECK constraint/);
  await fechar(primeira);

  const segunda = abrir();
  assert.deepEqual(await segunda.conhecimentoObter(empresa.id, item.id), item);
  assert.deepEqual((await segunda.conhecimentoListar(empresa.id))[0], item);
  const [metadados] = await segunda.conhecimentoListar(empresa.id, { incluirArquivo: false });
  assert.equal(Object.hasOwn(metadados.arquivo, 'base64'), false);
  assert.equal(Object.hasOwn(metadados, 'arquivoChave'), false);
  assert.deepEqual(await segunda.conhecimentoExcluir(empresa.id, item.id), item);
  assert.deepEqual(readdirSync(pasta), []);
});

test('SQLite: troca de anexo mantém a versão antiga até o commit e exclusão da empresa limpa os arquivos', async (t) => {
  const { caminho, abrir, abrirSql } = arquivoDeTeste(t);
  const store = abrir();
  await store.empresaCriar(empresa);
  const documento = (texto) => ({
    nome: 'menu.txt', mime: 'text/plain', tamanho: texto.length, base64: Buffer.from(texto).toString('base64'),
  });
  const antigo = documento('original');
  const novo = documento('revisado');
  const { item } = await store.conhecimentoCriar(empresa.id, { tipo: 'documento', titulo: 'Menu', arquivo: antigo }, 10);
  const pasta = `${caminho}.arquivos`;
  const [nomeAntigo] = readdirSync(pasta);
  await store.conhecimentoEditar(empresa.id, item.id, { titulo: 'Novo título' });
  assert.deepEqual(readdirSync(pasta), [nomeAntigo]);

  const db = abrirSql();
  db.exec(`CREATE TRIGGER falhar_anexo BEFORE UPDATE OF item ON conhecimento
    BEGIN SELECT RAISE(ABORT, 'falha de teste'); END`);
  await assert.rejects(store.conhecimentoEditar(empresa.id, item.id, { arquivo: novo }), /falha de teste/);
  assert.deepEqual(readdirSync(pasta), [nomeAntigo]);
  assert.deepEqual((await store.conhecimentoObter(empresa.id, item.id)).arquivo, antigo);
  db.exec('DROP TRIGGER falhar_anexo');

  await store.conhecimentoEditar(empresa.id, item.id, { arquivo: novo });
  const nomesFinais = readdirSync(pasta);
  assert.equal(nomesFinais.length, 1);
  assert.notEqual(nomesFinais[0], nomeAntigo);
  assert.deepEqual((await store.conhecimentoObter(empresa.id, item.id)).arquivo, novo);
  await store.empresaExcluir(empresa.id, { empresaId: empresa.id, entidade: 'empresa', entidadeId: empresa.id, acao: 'excluida' });
  assert.deepEqual(readdirSync(pasta), []);
});

test('SQLite: banco em disco usa WAL e recusa abertura com mensagem de integridade quando corrompido', async (t) => {
  const { caminho, abrir, fechar, abrirSql } = arquivoDeTeste(t);
  const store = abrir();
  await store.empresaCriar(empresa);
  const db = abrirSql();
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  await fechar(store);
  const corrompido = join(dirname(caminho), 'corrompido.sqlite');
  writeFileSync(corrompido, Buffer.alloc(4096, 0xff));
  assert.throws(() => criarRepositorioSqlite({ caminho: corrompido }), /Integridade do SQLite falhou.*corrompido\.sqlite/);
});
