'use strict';

// Usuários por camada (docs/plano-usuarios.md, Contrato F): login, sessão, camadas, empresas liberadas,
// reautenticação, histórico com o nome real e exclusão com a própria senha. Núcleo chamado direto.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { criarContexto, tratar } = require('../src/nucleo');
const { criarRepositorioMemoria } = require('../src/repositorio');
const { criarRepositorioSqlite } = require('../src/sqlite/repositorio');
const { plataformaWeb } = require('../src/plataforma');
const { abrirD1 } = require('./auxiliar/d1.cjs');

const SENHA = 'senha-forte-123';

async function preparar(modo, t, extra = {}) {
  const relogio = { agora: Date.parse('2026-11-25T12:00:00Z') };
  const plat = { ...plataformaWeb(), agora: () => relogio.agora };
  let store;
  if (modo === 'd1') store = (await abrirD1(t)).abrir({ plat });
  else if (modo === 'memoria') store = criarRepositorioMemoria({ plat });
  else {
    const pasta = mkdtempSync(join(tmpdir(), 'chatflow-uapi-'));
    store = criarRepositorioSqlite({ plat, caminho: join(pasta, 'a.sqlite') });
    t.after(async () => { try { await store.fechar?.(); } catch { /* já fechado */ } rmSync(pasta, { recursive: true, force: true }); });
  }
  const ctx = criarContexto({ store, plat, tokens: { cliente: 'tcl', integracao: 'ti' }, adminSenha: 'admin-env', ...extra });
  const chamar = async (metodo, caminho, { token, corpo, headers } = {}) => {
    const bytes = corpo === undefined ? null : new TextEncoder().encode(JSON.stringify(corpo));
    const r = await tratar({ metodo, url: caminho, ip: '127.0.0.1', corpo: bytes,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers || {}) } }, ctx);
    return { status: r.status, corpo: r.corpo };
  };
  const su = { token: 'ti' };
  const e1 = (await chamar('POST', '/empresas', { ...su, corpo: { nome: 'Alfa' } })).corpo.id;
  const e2 = (await chamar('POST', '/empresas', { ...su, corpo: { nome: 'Beta' } })).corpo.id;
  const criarUsuario = async (nome, papel, empresas) => {
    const r = await chamar('POST', '/usuarios', { ...su, corpo: { nome, email: `${nome.toLowerCase()}@x.com`, papel, senha: SENHA, empresas } });
    assert.equal(r.status, 201, JSON.stringify(r.corpo));
    return r.corpo;
  };
  const entrar = async (nome, senha = SENHA) => (await chamar('POST', '/login', { corpo: { email: `${nome.toLowerCase()}@x.com`, senha } }));
  return { chamar, relogio, e1, e2, su, criarUsuario, entrar, store };
}

for (const modo of ['memoria', 'sqlite', 'd1']) {
  test(`login: sucesso, falha genérica e limite de tentativas (${modo})`, async (t) => {
    const { chamar, criarUsuario, entrar } = await preparar(modo, t, { limiteLoginPorMinuto: 6 });
    await criarUsuario('Ana', 'equipe', []);
    const ok = await entrar('Ana');
    assert.equal(ok.status, 200);
    assert.ok(ok.corpo.token.startsWith('s1_'));
    assert.equal(ok.corpo.usuario.papel, 'equipe');
    assert.equal(ok.corpo.usuario.senhaHash, undefined);
    const errada = await entrar('Ana', 'outra-senha-qualquer');
    const inexistente = await chamar('POST', '/login', { corpo: { email: 'ninguem@x.com', senha: SENHA } });
    assert.equal(errada.status, 401);
    assert.deepEqual(errada.corpo, inexistente.corpo, 'mesma resposta para e-mail inexistente e senha errada');
    assert.equal(inexistente.status, 401);
    let ultimo;
    for (let i = 0; i < 6; i++) ultimo = await entrar('Ana', 'x' + i);
    assert.equal(ultimo.status, 429);
  });

  test(`equipe: só vê a empresa liberada e não acessa API, Histórico, usuários nem criar empresa (${modo})`, async (t) => {
    const { chamar, e1, e2, criarUsuario, entrar } = await preparar(modo, t);
    await criarUsuario('Ana', 'equipe', [e1]);
    const token = (await entrar('Ana')).corpo.token;
    const lista = await chamar('GET', '/empresas', { token });
    assert.deepEqual(lista.corpo.map((e) => e.id), [e1]);
    assert.equal((await chamar('GET', `/empresas/${e1}/agente`, { token })).status, 200);
    const fora = await chamar('GET', `/empresas/${e2}/agente`, { token });
    assert.equal(fora.status, 403);
    assert.deepEqual(fora.corpo, { erro: 'empresa não liberada' });
    assert.equal((await chamar('GET', `/empresas/${e1}/historico`, { token })).status, 403);
    assert.equal((await chamar('GET', `/empresas/${e1}/api`, { token })).status, 403);
    assert.equal((await chamar('GET', '/usuarios', { token })).status, 403);
    assert.equal((await chamar('POST', '/empresas', { token, corpo: { nome: 'Nova' } })).status, 403);
    assert.equal((await chamar('GET', '/historico/excluidas', { token })).status, 403);
    const eu = await chamar('GET', '/eu', { token });
    assert.equal(eu.corpo.papel, 'equipe');
    assert.deepEqual(eu.corpo.empresas, [e1]);
  });

  test(`Configuração pede a senha de novo para equipe e admin; superadmin não (${modo})`, async (t) => {
    const { chamar, e1, relogio, criarUsuario, entrar } = await preparar(modo, t);
    await criarUsuario('Ana', 'equipe', [e1]);
    await criarUsuario('Cris', 'superadmin', []);
    const ana = (await entrar('Ana')).corpo.token;
    const antes = await chamar('PATCH', `/empresas/${e1}`, { token: ana, corpo: { nome: 'Alfa 2' } });
    assert.equal(antes.status, 403);
    assert.equal(antes.corpo.reautenticar, true);
    assert.equal((await chamar('POST', '/eu/reautenticar', { token: ana, corpo: { senha: 'errada-errada' } })).status, 403);
    assert.equal((await chamar('POST', '/eu/reautenticar', { token: ana, corpo: { senha: SENHA } })).status, 200);
    assert.equal((await chamar('PATCH', `/empresas/${e1}`, { token: ana, corpo: { nome: 'Alfa 2' } })).status, 200);
    relogio.agora += 6 * 60 * 1000; // passou a janela de 5 minutos
    assert.equal((await chamar('PATCH', `/empresas/${e1}`, { token: ana, corpo: { nome: 'Alfa 3' } })).status, 403);
    const cris = (await entrar('Cris')).corpo.token;
    assert.equal((await chamar('PATCH', `/empresas/${e1}`, { token: cris, corpo: { nome: 'Alfa 4' } })).status, 200);
  });

  test(`histórico grava o nome real e ignora X-Operador (${modo})`, async (t) => {
    const { chamar, e1, criarUsuario, entrar } = await preparar(modo, t);
    await criarUsuario('Bia', 'admin', [e1]);
    const bia = (await entrar('Bia')).corpo.token;
    await chamar('POST', '/eu/reautenticar', { token: bia, corpo: { senha: SENHA } });
    const r = await chamar('PATCH', `/empresas/${e1}`, { token: bia, corpo: { nome: 'Alfa Bia' }, headers: { 'x-operador': 'Cris' } });
    assert.equal(r.status, 200);
    const hist = await chamar('GET', `/empresas/${e1}/historico`, { token: bia });
    assert.equal(hist.status, 200);
    const ev = hist.corpo.find((e) => e.acao === 'editada');
    assert.equal(ev.operador, 'Bia');
    assert.equal(ev.usuarioNome, 'Bia');
    assert.equal(ev.papel, 'admin');
    assert.ok(ev.usuarioId);
  });

  test(`desativar usuário derruba a sessão na hora e o último superadmin não sai (${modo})`, async (t) => {
    const { chamar, e1, su, criarUsuario, entrar } = await preparar(modo, t);
    const ana = await criarUsuario('Ana', 'equipe', [e1]);
    const cris = await criarUsuario('Cris', 'superadmin', []);
    const token = (await entrar('Ana')).corpo.token;
    assert.equal((await chamar('GET', '/eu', { token })).status, 200);
    assert.equal((await chamar('PATCH', `/usuarios/${ana.id}`, { ...su, corpo: { ativo: false } })).status, 200);
    assert.equal((await chamar('GET', '/eu', { token })).status, 401);
    assert.equal((await entrar('Ana')).status, 401, 'usuário inativo não entra');
    const bloqueio = await chamar('PATCH', `/usuarios/${cris.id}`, { ...su, corpo: { ativo: false } });
    assert.equal(bloqueio.status, 409);
    const rebaixar = await chamar('PATCH', `/usuarios/${cris.id}`, { ...su, corpo: { papel: 'admin' } });
    assert.equal(rebaixar.status, 409);
  });

  test(`trocar a própria senha derruba as outras sessões; logout encerra (${modo})`, async (t) => {
    const { chamar, criarUsuario, entrar } = await preparar(modo, t);
    await criarUsuario('Ana', 'equipe', []);
    const a = (await entrar('Ana')).corpo.token;
    const b = (await entrar('Ana')).corpo.token;
    assert.equal((await chamar('POST', '/eu/senha', { token: a, corpo: { atual: 'errada-errada', nova: 'nova-senha-123' } })).status, 403);
    assert.equal((await chamar('POST', '/eu/senha', { token: a, corpo: { atual: SENHA, nova: 'curta' } })).status, 400);
    assert.equal((await chamar('POST', '/eu/senha', { token: a, corpo: { atual: SENHA, nova: 'nova-senha-123' } })).status, 200);
    assert.equal((await chamar('GET', '/eu', { token: a })).status, 200);
    assert.equal((await chamar('GET', '/eu', { token: b })).status, 401);
    assert.equal((await entrar('Ana')).status, 401, 'senha antiga não vale');
    assert.equal((await entrar('Ana', 'nova-senha-123')).status, 200);
    assert.equal((await chamar('POST', '/logout', { token: a })).status, 200);
    assert.equal((await chamar('GET', '/eu', { token: a })).status, 401);
  });

  test(`excluir empresa: admin confirma com a própria senha; equipe não pode (${modo})`, async (t) => {
    const { chamar, e1, criarUsuario, entrar } = await preparar(modo, t);
    await criarUsuario('Ana', 'equipe', [e1]);
    await criarUsuario('Bia', 'admin', [e1]);
    const ana = (await entrar('Ana')).corpo.token;
    const bia = (await entrar('Bia')).corpo.token;
    assert.equal((await chamar('POST', `/empresas/${e1}/excluir`, { token: ana, corpo: { senha: SENHA, confirmarNome: 'Alfa' } })).status, 403);
    assert.equal((await chamar('POST', `/empresas/${e1}/excluir`, { token: bia, corpo: { senha: 'admin-env', confirmarNome: 'Alfa' } })).status, 403, 'a senha global não vale para usuário logado');
    const ok = await chamar('POST', `/empresas/${e1}/excluir`, { token: bia, corpo: { senha: SENHA, confirmarNome: 'Alfa' } });
    assert.equal(ok.status, 200);
  });

  test(`usuários: validação, e-mail repetido, empresa inexistente e redefinir senha (${modo})`, async (t) => {
    const { chamar, e1, su, criarUsuario, entrar } = await preparar(modo, t);
    const ana = await criarUsuario('Ana', 'equipe', [e1]);
    const base = { nome: 'Zé', email: 'ze@x.com', papel: 'equipe', senha: SENHA, empresas: [] };
    assert.equal((await chamar('POST', '/usuarios', { ...su, corpo: { ...base, email: 'ana@x.com' } })).status, 409);
    assert.equal((await chamar('POST', '/usuarios', { ...su, corpo: { ...base, senha: 'curta' } })).status, 400);
    assert.equal((await chamar('POST', '/usuarios', { ...su, corpo: { ...base, papel: 'dono' } })).status, 400);
    assert.equal((await chamar('POST', '/usuarios', { ...su, corpo: { ...base, empresas: ['nao_existe'] } })).status, 400);
    assert.equal((await chamar('POST', '/usuarios', { token: 'tcl', corpo: base })).status, 403, 'token de equipe do env não cria usuário');
    const token = (await entrar('Ana')).corpo.token;
    assert.equal((await chamar('POST', `/usuarios/${ana.id}/senha`, { ...su, corpo: { senha: 'redefinida-123' } })).status, 200);
    assert.equal((await chamar('GET', '/eu', { token })).status, 401, 'redefinir derruba as sessões');
    assert.equal((await entrar('Ana', 'redefinida-123')).status, 200);
    const lista = await chamar('GET', '/usuarios', su);
    assert.ok(lista.corpo.every((u) => u.senhaHash === undefined && u.salt === undefined));
  });

  test(`tokens do env e chave da empresa continuam valendo (${modo})`, async (t) => {
    const { chamar, e1 } = await preparar(modo, t);
    assert.equal((await chamar('GET', '/empresas', { token: 'tcl' })).status, 200);
    assert.equal((await chamar('GET', `/empresas/${e1}/historico`, { token: 'tcl' })).status, 200);
    const eu = await chamar('GET', '/eu', { token: 'ti' });
    assert.deepEqual(eu.corpo, { id: null, nome: null, email: null, papel: 'integracao', empresas: null, reautenticadoEm: null });
    const k = await chamar('POST', `/empresas/${e1}/api/chave`, { token: 'ti' });
    assert.equal(k.status, 201);
    assert.equal((await chamar('GET', `/empresas/${e1}/agente`, { token: k.corpo.chave })).status, 200);
    assert.equal((await chamar('GET', '/eu', { token: k.corpo.chave })).status, 403);
  });
}
