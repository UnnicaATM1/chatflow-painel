'use strict';

// Contrato E (docs/plano-usuarios.md): usuários e sessões com o mesmo comportamento em memória, SQLite e D1.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { criarRepositorioSqlite } = require('../src/sqlite/repositorio');
const { criarRepositorioMemoria } = require('../src/repositorio');
const { plataformaWeb } = require('../src/plataforma');
const { abrirD1 } = require('./auxiliar/d1.cjs');

const plat = plataformaWeb();
const cred = { senhaHash: 'a'.repeat(64), salt: 'b'.repeat(32), iteracoes: 100000 };
const novo = (extra = {}) => ({ nome: 'Ana', email: 'ana@x.com', papel: 'equipe', empresas: ['empresa_1'], criadoEm: '2026-11-25T10:00:00.000Z', ...cred, ...extra });
const base = (id) => ({ id, nome: 'Emp ' + id, agente: {}, ambientes: [], reservas: [] });

async function criar(modo, t) {
  let store;
  if (modo === 'd1') store = (await abrirD1(t)).abrir({ plat });
  else if (modo === 'memoria') store = criarRepositorioMemoria({ plat });
  else {
    const pasta = mkdtempSync(join(tmpdir(), 'chatflow-usr-'));
    store = criarRepositorioSqlite({ plat, caminho: join(pasta, 'a.sqlite') });
    t.after(async () => { try { await store.fechar?.(); } catch { /* já fechado */ } rmSync(pasta, { recursive: true, force: true }); });
  }
  await store.empresaCriar(base('empresa_1'));
  await store.empresaCriar(base('empresa_2'));
  return store;
}

for (const modo of ['memoria', 'sqlite', 'd1']) {
  test(`usuários: criar, ler, listar e e-mail único (${modo})`, async (t) => {
    const s = await criar(modo, t);
    const u = await s.usuarioCriar(novo());
    assert.equal(u.email, 'ana@x.com');
    assert.deepEqual(u.empresas, ['empresa_1']);
    assert.equal(u.ativo, true);
    assert.equal(u.senhaHash, undefined, 'a resposta pública não traz o hash');
    assert.deepEqual(await s.usuarioCriar(novo({ nome: 'Outra' })), { erro: 'email_duplicado' });
    const cheio = await s.usuarioPorEmail('ana@x.com');
    assert.equal(cheio.id, u.id);
    assert.equal(cheio.senhaHash, cred.senhaHash);
    assert.equal((await s.usuarioObter(u.id)).salt, cred.salt);
    assert.equal(await s.usuarioPorEmail('nao@x.com'), null);
    assert.equal(await s.usuarioObter('inexistente'), null);
    const lista = await s.usuarioListar();
    assert.equal(lista.length, 1);
    assert.equal(lista[0].senhaHash, undefined);
  });

  test(`usuários: atualizar nome, papel, ativo e empresas; ignorar empresa inexistente (${modo})`, async (t) => {
    const s = await criar(modo, t);
    const u = await s.usuarioCriar(novo());
    const a = await s.usuarioAtualizar(u.id, { nome: 'Ana B', papel: 'admin', ativo: false, empresas: ['empresa_2', 'empresa_inexistente'] });
    assert.equal(a.nome, 'Ana B');
    assert.equal(a.papel, 'admin');
    assert.equal(a.ativo, false);
    assert.deepEqual(a.empresas, ['empresa_2']);
    assert.equal(await s.usuarioAtualizar('nada', { nome: 'x' }), null);
    assert.deepEqual((await s.usuarioAtualizar(u.id, {})).empresas, ['empresa_2'], 'sem campos, nada muda');
  });

  test(`usuários: senha, login e superadmins ativos (${modo})`, async (t) => {
    const s = await criar(modo, t);
    const u = await s.usuarioCriar(novo({ papel: 'superadmin' }));
    assert.equal(await s.usuarioSenhaDefinir(u.id, { senhaHash: 'c'.repeat(64), salt: 'd'.repeat(32), iteracoes: 100000 }), true);
    assert.equal((await s.usuarioObter(u.id)).senhaHash, 'c'.repeat(64));
    assert.equal(await s.usuarioSenhaDefinir('nada', cred), false);
    await s.usuarioLoginMarcar(u.id, '2026-11-25T11:00:00.000Z');
    assert.equal((await s.usuarioObter(u.id)).ultimoLogin, '2026-11-25T11:00:00.000Z');
    assert.deepEqual(await s.usuarioSuperadminsAtivos(), [u.id]);
    await s.usuarioAtualizar(u.id, { ativo: false });
    assert.deepEqual(await s.usuarioSuperadminsAtivos(), []);
  });

  test(`sessões: criar, buscar, reautenticar, remover e expirar (${modo})`, async (t) => {
    const s = await criar(modo, t);
    const u = await s.usuarioCriar(novo());
    await s.sessaoCriar({ tokenHash: 'h1', usuarioId: u.id, criadaEm: '2026-11-25T10:00:00.000Z', expiraEm: '2026-11-25T22:00:00.000Z' });
    await s.sessaoCriar({ tokenHash: 'h2', usuarioId: u.id, criadaEm: '2026-11-25T10:00:00.000Z', expiraEm: '2026-11-25T10:30:00.000Z' });
    assert.deepEqual(await s.sessaoPorHash('h1'), { usuarioId: u.id, criadaEm: '2026-11-25T10:00:00.000Z', expiraEm: '2026-11-25T22:00:00.000Z', reautenticadoEm: null });
    assert.equal(await s.sessaoPorHash('nada'), null);
    await s.sessaoReautenticar('h1', '2026-11-25T10:05:00.000Z');
    assert.equal((await s.sessaoPorHash('h1')).reautenticadoEm, '2026-11-25T10:05:00.000Z');
    await s.sessoesExpiradasRemover('2026-11-25T11:00:00.000Z');
    assert.equal(await s.sessaoPorHash('h2'), null);
    assert.notEqual(await s.sessaoPorHash('h1'), null);
    await s.sessaoCriar({ tokenHash: 'h3', usuarioId: u.id, criadaEm: '2026-11-25T10:00:00.000Z', expiraEm: '2026-11-25T22:00:00.000Z' });
    await s.sessoesRemoverDoUsuario(u.id, 'h3');
    assert.equal(await s.sessaoPorHash('h1'), null);
    assert.notEqual(await s.sessaoPorHash('h3'), null);
    await s.sessaoRemover('h3');
    assert.equal(await s.sessaoPorHash('h3'), null);
  });

  test(`excluir empresa tira o vínculo do usuário (${modo})`, async (t) => {
    const s = await criar(modo, t);
    const u = await s.usuarioCriar(novo({ empresas: ['empresa_1', 'empresa_2'] }));
    await s.empresaExcluir('empresa_2', { empresaId: 'empresa_2', entidade: 'empresa', acao: 'excluida', antes: { nome: 'x', reservas: [], ambientes: [] }, depois: {} });
    assert.deepEqual((await s.usuarioObter(u.id)).empresas, ['empresa_1']);
  });
}
