import { readFileSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { plataformaWeb } from '../plataforma.js';
import { IDEMPOTENCIA_MAX_PADRAO, IDEMPOTENCIA_TTL_PADRAO_MS } from '../repositorio.js';
import { limparIdempotencia } from './idempotencia-limpeza.js';

const MIGRACAO = new URL('../../db/migrations/0001_inicial.sql', import.meta.url);
const MODULOS_PADRAO = { reservas: true, conhecimento: true };
const CONFLITO = { ok: false, motivo: 'conflito' };
const COLUNAS_RESERVA = 'id, empresa_id AS empresaId, mesa_id AS mesaId, ambiente, data, horario, pessoas, inicio, fim, status, nome_cliente AS nomeCliente, contato';

// O DatabaseSync pode bloquear esperando outra conexão. A fila compartilhada permite que
// uma transação assíncrona termine antes de outra conexão local tentar obter o mesmo lock.
const filas = new Map();
function enfileirar(chave, executar) {
  const anterior = filas.get(chave) || Promise.resolve();
  const resultado = anterior.then(executar);
  const liberar = () => { if (filas.get(chave) === cauda) filas.delete(chave); };
  const cauda = resultado.then(liberar, liberar);
  filas.set(chave, cauda);
  return resultado;
}

function lerReserva(linha) {
  if (!linha) return null;
  const { nomeCliente, contato, ...reserva } = linha;
  if (nomeCliente !== null) reserva.nomeCliente = nomeCliente;
  if (contato !== null) reserva.contato = contato;
  return reserva;
}

function congelar(objeto) {
  if (objeto && typeof objeto === 'object') {
    Object.values(objeto).forEach(congelar);
    Object.freeze(objeto);
  }
  return objeto;
}

export function criarRepositorioSqlite({ plat, sink, caminho = ':memory:', idempotenciaTtlMs, idempotenciaMax } = {}) {
  const p = plat || plataformaWeb();
  const ttlMs = idempotenciaTtlMs > 0 ? Math.ceil(idempotenciaTtlMs) : IDEMPOTENCIA_TTL_PADRAO_MS;
  const max = idempotenciaMax > 0 ? Math.floor(idempotenciaMax) : IDEMPOTENCIA_MAX_PADRAO;
  const boot = p.uuid();
  const db = new DatabaseSync(caminho);
  let chaveFila;
  try {
    chaveFila = caminho === ':memory:' ? db : realpathSync.native(caminho);
    db.exec('PRAGMA busy_timeout = 5000');
    if (db.prepare('PRAGMA user_version').get().user_version === 0) {
      const sql = readFileSync(MIGRACAO, 'utf8');
      db.exec('BEGIN IMMEDIATE');
      db.exec(sql);
      db.exec('PRAGMA user_version = 1; COMMIT');
    }
  } catch (erro) {
    db.close();
    throw erro;
  }

  const obter = (sql, ...params) => db.prepare(sql).get(...params);
  const listar = (sql, ...params) => db.prepare(sql).all(...params);
  const gravar = (sql, ...params) => db.prepare(sql).run(...params);
  let eventosPendentes = null;

  async function transacionar(executar) {
    if (eventosPendentes) return executar();
    db.exec('BEGIN IMMEDIATE');
    const eventos = [];
    eventosPendentes = eventos;
    let resultado;
    try {
      resultado = await executar();
      db.exec('COMMIT');
    } catch (erro) {
      db.exec('ROLLBACK');
      throw erro;
    } finally {
      eventosPendentes = null;
    }
    if (sink) for (const evento of eventos) sink(evento);
    return resultado;
  }

  const listarConhecimento = (id) =>
    listar('SELECT item FROM conhecimento WHERE empresa_id = ? ORDER BY id', id).map((linha) => JSON.parse(linha.item));
  const obterConhecimento = (empresaId, id) => {
    const linha = obter('SELECT item FROM conhecimento WHERE empresa_id = ? AND id = ?', empresaId, id);
    return linha ? JSON.parse(linha.item) : null;
  };
  const lerMesa = ({ mesa_id, capacidade, reservavel }) => ({ id: mesa_id, capacidade, reservavel: Boolean(reservavel) });
  function lerEmpresa(linha) {
    if (!linha) return null;
    const { id, nome, agente, chave, modulos, prox_conhecimento } = linha;
    const ambientes = listar('SELECT id, nome FROM ambientes WHERE empresa_id = ? ORDER BY id', id).map((a) => ({
      nome: a.nome,
      mesas: listar('SELECT * FROM mesas WHERE empresa_id = ? AND ambiente_id = ? ORDER BY ordem', id, a.id).map(lerMesa),
    }));
    return {
      id, nome, agente: JSON.parse(agente), ambientes, chave: JSON.parse(chave),
      modulos: JSON.parse(modulos), conhecimento: listarConhecimento(id), proxConhecimento: prox_conhecimento,
    };
  }

  function inserirAmbiente(empresaId, nome) {
    return gravar('INSERT INTO ambientes (empresa_id, nome, nome_normalizado) VALUES (?, ?, ?)', empresaId, nome, nome.toLowerCase()).lastInsertRowid;
  }

  function inserirMesa(empresaId, ambienteId, mesa) {
    gravar('INSERT INTO mesas (empresa_id, ambiente_id, mesa_id, capacidade, reservavel) VALUES (?, ?, ?, ?, ?)',
      empresaId, ambienteId, mesa.id, mesa.capacidade, Number(Boolean(mesa.reservavel)));
  }

  const obterReserva = (empresaId, id) =>
    lerReserva(obter(`SELECT ${COLUNAS_RESERVA} FROM reservas WHERE empresa_id = ? AND id = ?`, empresaId, id));
  const ocupada = (empresaId, mesaId, inicio, fim, ignorarId = null) => Boolean(obter(
    `SELECT 1 FROM reservas WHERE empresa_id = ? AND mesa_id = ? AND status = 'confirmada'
      AND id IS NOT ? AND fim > ? AND inicio < ? LIMIT 1`, empresaId, mesaId, ignorarId, inicio, fim,
  ));

  function idemObter(empresaId, chave) {
    const entrada = obter('SELECT resposta, criada_em FROM idempotencia WHERE empresa_id = ? AND chave = ?', empresaId, chave);
    if (!entrada) return null;
    const limite = p.agora() - ttlMs;
    if (entrada.criada_em > limite) return JSON.parse(entrada.resposta);
    gravar('DELETE FROM idempotencia WHERE empresa_id = ? AND chave = ? AND criada_em <= ?', empresaId, chave, limite);
    return null;
  }

  async function idemGravar(empresaId, chave, resposta) {
    const agoraMs = p.agora();
    gravar('DELETE FROM idempotencia WHERE empresa_id = ? AND chave = ?', empresaId, chave);
    gravar('INSERT INTO idempotencia (empresa_id, chave, resposta, criada_em) VALUES (?, ?, ?, ?)',
      empresaId, chave, JSON.stringify(resposta), agoraMs);
    await limparIdempotencia(db, { empresaId, ttlMs, max, agoraMs });
  }

  const lerEvento = (linha) => linha ? congelar({ seq: linha.seq, ...JSON.parse(linha.evento) }) : null;
  function acrescentarEvento(ev) {
    const evento = { boot, quando: new Date(p.agora()).toISOString(), ...JSON.parse(JSON.stringify(ev)) };
    const { empresaId, entidade, entidadeId, acao, refSeq } = evento;
    const { lastInsertRowid: seq } = gravar(
      'INSERT INTO historico (empresa_id, entidade, entidade_id, acao, ref_seq, evento) VALUES (?, ?, ?, ?, ?, ?)',
      empresaId, entidade, entidadeId == null ? null : String(entidadeId), acao, refSeq ?? null, JSON.stringify(evento),
    );
    const e = congelar({ seq, ...evento });
    eventosPendentes.push(e);
    return e;
  }

  // A fachada interna participa da transação existente. A pública espera a fila do arquivo.
  const interno = {
    plat: p,

    async empresaObter(id) { return lerEmpresa(obter('SELECT * FROM empresas WHERE id = ?', id)); },
    async empresaListar() { return listar('SELECT * FROM empresas ORDER BY rowid').map(lerEmpresa); },
    async empresaCriar({ id, nome, agente, ambientes, modulos }) {
      return transacionar(() => {
        const modulosFinais = { ...MODULOS_PADRAO, ...(modulos || {}) };
        gravar(`INSERT INTO empresas (id, nome, agente, modulos) VALUES (?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET nome = excluded.nome, agente = excluded.agente,
          modulos = excluded.modulos, chave = NULL, prox_conhecimento = 1`,
        id, nome, JSON.stringify(agente), JSON.stringify(modulosFinais));
        gravar('DELETE FROM ambientes WHERE empresa_id = ?', id);
        gravar('DELETE FROM conhecimento WHERE empresa_id = ?', id);
        for (const a of ambientes) {
          const ambienteId = inserirAmbiente(id, a.nome);
          for (const mesa of a.mesas) inserirMesa(id, ambienteId, mesa);
        }
        return lerEmpresa(obter('SELECT * FROM empresas WHERE id = ?', id));
      });
    },
    async empresaProximoId() {
      let n = obter('SELECT COUNT(*) AS n FROM empresas').n + 1;
      while (obter('SELECT 1 FROM empresas WHERE id = ? UNION ALL SELECT 1 FROM historico WHERE empresa_id = ? LIMIT 1',
        `empresa_${n}`, `empresa_${n}`)) n++;
      return `empresa_${n}`;
    },
    async empresaNomeEmUso(nome, ignorarId) {
      return listar('SELECT id, nome FROM empresas').some((e) => e.id !== ignorarId && e.nome.toLowerCase() === nome.toLowerCase());
    },
    async empresaRenomear(id, nome) {
      return transacionar(() => {
        const { nome: antes } = obter('SELECT nome FROM empresas WHERE id = ?', id);
        gravar('UPDATE empresas SET nome = ? WHERE id = ?', nome, id);
        return { antes, depois: nome };
      });
    },
    async empresaModulosDefinir(id, modulos) {
      return transacionar(() => {
        const novos = { ...JSON.parse(obter('SELECT modulos FROM empresas WHERE id = ?', id).modulos), ...modulos };
        gravar('UPDATE empresas SET modulos = ? WHERE id = ?', JSON.stringify(novos), id);
        return novos;
      });
    },
    async agenteAtualizar(id, mudancas) {
      return transacionar(() => {
        const agente = { ...JSON.parse(obter('SELECT agente FROM empresas WHERE id = ?', id).agente), ...mudancas };
        gravar('UPDATE empresas SET agente = ? WHERE id = ?', JSON.stringify(agente), id);
      });
    },
    async chaveDefinir(id, chave) { gravar('UPDATE empresas SET chave = ? WHERE id = ?', JSON.stringify(chave), id); },
    async chaveRemover(id) { gravar('UPDATE empresas SET chave = NULL WHERE id = ?', id); },
    async empresaPorChaveHash(hash) {
      for (const e of listar('SELECT id, chave FROM empresas WHERE chave IS NOT NULL ORDER BY rowid')) {
        if (p.iguaisTempoConstante(hash, JSON.parse(e.chave).hash)) return e.id;
      }
      return null;
    },

    async ambienteCriar(empresaId, nome) {
      const resultado = gravar(`INSERT INTO ambientes (empresa_id, nome, nome_normalizado) VALUES (?, ?, ?)
        ON CONFLICT (empresa_id, nome_normalizado) DO NOTHING`, empresaId, nome, nome.toLowerCase());
      return resultado.changes ? { ok: true } : { ok: false, motivo: 'duplicado' };
    },
    async mesaCriar(empresaId, ambienteNome, { capacidade, reservavel }) {
      return transacionar(() => {
        const amb = obter('SELECT id FROM ambientes WHERE empresa_id = ? AND nome = ?', empresaId, ambienteNome);
        if (!amb) return null;
        const base = (ambienteNome.match(/[A-Za-z]/) || ['M'])[0].toUpperCase();
        const existentes = new Set(listar('SELECT mesa_id FROM mesas WHERE empresa_id = ?', empresaId).map((m) => m.mesa_id));
        let n = 1;
        while (existentes.has(`${base}${n}`)) n++;
        const mesa = { id: `${base}${n}`, capacidade, reservavel: reservavel !== false };
        inserirMesa(empresaId, amb.id, mesa);
        return mesa;
      });
    },
    async mesaEditar(empresaId, mesaId, { capacidade, reservavel }) {
      return transacionar(() => {
        const linha = obter('SELECT * FROM mesas WHERE empresa_id = ? AND mesa_id = ?', empresaId, mesaId);
        if (!linha) return null;
        const { id, ...antes } = lerMesa(linha);
        const mesa = { id, capacidade: capacidade ?? antes.capacidade, reservavel: reservavel ?? antes.reservavel };
        gravar('UPDATE mesas SET capacidade = ?, reservavel = ? WHERE ordem = ?', mesa.capacidade, Number(mesa.reservavel), linha.ordem);
        return { antes, mesa };
      });
    },

    async reservaListar(empresaId, { data } = {}) {
      return listar(`SELECT ${COLUNAS_RESERVA} FROM reservas WHERE empresa_id = ?
        AND (? IS NULL OR data = ?) ORDER BY id`, empresaId, data || null, data || null).map(lerReserva);
    },
    async reservaObter(empresaId, id) { return obterReserva(empresaId, id); },
    async reservaConfirmadas(empresaId, ignorarId = null) {
      return listar(`SELECT ${COLUNAS_RESERVA} FROM reservas WHERE empresa_id = ?
        AND status = 'confirmada' AND id IS NOT ? ORDER BY id`, empresaId, ignorarId).map(lerReserva);
    },
    async reservaCriar({ empresaId, chave, candidatas, reserva }) {
      return transacionar(async () => {
        const antiga = chave ? idemObter(empresaId, chave) : null;
        if (antiga) return { criada: false, resposta: antiga };
        const { data, horario, pessoas, inicio, fim, nomeCliente, contato } = reserva;
        const candidata = candidatas.find((c) => !ocupada(empresaId, c.mesaId, inicio, fim));
        if (!candidata) return { conflito: true };
        const { mesaId, ambiente } = candidata;
        const { lastInsertRowid: id } = gravar(`INSERT INTO reservas
          (empresa_id, mesa_id, ambiente, data, horario, pessoas, inicio, fim, status, nome_cliente, contato)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confirmada', ?, ?)`,
        empresaId, mesaId, ambiente, data, horario, pessoas, inicio, fim, nomeCliente ?? null, contato ?? null);
        const resposta = { status: 'confirmada', reservaId: id, mesa: mesaId, ambiente };
        if (chave) await idemGravar(empresaId, chave, resposta);
        return { criada: true, resposta, reserva: obterReserva(empresaId, id) };
      });
    },
    async idempotenciaObter(empresaId, chave) { return idemObter(empresaId, chave); },
    async idempotenciaGravar(empresaId, chave, resposta) { return transacionar(() => idemGravar(empresaId, chave, resposta)); },
    async idempotenciaTamanho(empresaId) { return obter('SELECT COUNT(*) AS n FROM idempotencia WHERE empresa_id = ?', empresaId).n; },

    async reservaEditar({ empresaId, id, dados, cliente }) {
      return transacionar(() => {
        const atual = obterReserva(empresaId, id);
        if (atual?.status !== 'confirmada') return { ...CONFLITO };
        const nova = { ...atual, ...dados, ...cliente };
        if (ocupada(empresaId, nova.mesaId, nova.inicio, nova.fim, id)) return { ...CONFLITO };
        gravar(`UPDATE reservas SET mesa_id = ?, ambiente = ?, data = ?, horario = ?, pessoas = ?,
          inicio = ?, fim = ?, nome_cliente = ?, contato = ? WHERE empresa_id = ? AND id = ?`,
        nova.mesaId, nova.ambiente, nova.data, nova.horario, nova.pessoas, nova.inicio, nova.fim,
        cliente?.nomeCliente === '' ? null : nova.nomeCliente ?? null, cliente?.contato === '' ? null : nova.contato ?? null,
        empresaId, id);
        return { ok: true, reserva: obterReserva(empresaId, id) };
      });
    },
    async reservaCancelar(empresaId, id) {
      return lerReserva(obter(`UPDATE reservas SET status = 'cancelada' WHERE empresa_id = ? AND id = ?
        RETURNING ${COLUNAS_RESERVA}`, empresaId, id));
    },
    async reservaReativar(empresaId, id) {
      return transacionar(() => {
        const atual = obterReserva(empresaId, id);
        if (atual.status === 'confirmada') return { ok: true, reserva: atual };
        if (ocupada(empresaId, atual.mesaId, atual.inicio, atual.fim, id)) return { ...CONFLITO };
        gravar("UPDATE reservas SET status = 'confirmada' WHERE empresa_id = ? AND id = ?", empresaId, id);
        return { ok: true, reserva: { ...atual, status: 'confirmada' } };
      });
    },

    async conhecimentoListar(empresaId) { return listarConhecimento(empresaId); },
    async conhecimentoObter(empresaId, id) { return obterConhecimento(empresaId, id); },
    async conhecimentoCriar(empresaId, item, maxItens) {
      return transacionar(() => {
        if (obter('SELECT COUNT(*) AS n FROM conhecimento WHERE empresa_id = ?', empresaId).n >= maxItens) {
          return { ok: false, motivo: 'limite' };
        }
        const { id } = obter(`UPDATE empresas SET prox_conhecimento = prox_conhecimento + 1 WHERE id = ?
          RETURNING prox_conhecimento - 1 AS id`, empresaId);
        const novo = { id, ...item };
        gravar('INSERT INTO conhecimento (empresa_id, id, item) VALUES (?, ?, ?)', empresaId, id, JSON.stringify(novo));
        return { ok: true, item: novo };
      });
    },
    async conhecimentoEditar(empresaId, id, mudancas) {
      return transacionar(() => {
        const atual = obterConhecimento(empresaId, id);
        if (!atual) return null;
        const novo = { ...atual, ...mudancas };
        for (const k of Object.keys(mudancas)) if (mudancas[k] === undefined) delete novo[k];
        gravar('UPDATE conhecimento SET item = ? WHERE empresa_id = ? AND id = ?', JSON.stringify(novo), empresaId, id);
        return novo;
      });
    },
    async conhecimentoExcluir(empresaId, id) {
      const linha = obter('DELETE FROM conhecimento WHERE empresa_id = ? AND id = ? RETURNING item', empresaId, id);
      return linha ? JSON.parse(linha.item) : null;
    },

    async historicoAcrescentar(ev) { return transacionar(() => acrescentarEvento(ev)); },
    async historicoListar(empresaId, { entidade, entidadeId, limite } = {}) {
      const n = Math.trunc(Math.min(Math.max(Number(limite) || 200, 1), 1000));
      const id = entidadeId ? String(entidadeId) : null;
      return listar(`SELECT seq, evento FROM historico WHERE empresa_id = ? AND (? IS NULL OR entidade = ?)
        AND (? IS NULL OR entidade_id = ?) ORDER BY seq DESC LIMIT ?`, empresaId, entidade || null, entidade || null, id, id, n).map(lerEvento);
    },
    async historicoObter(empresaId, seq) {
      return lerEvento(obter('SELECT seq, evento FROM historico WHERE empresa_id = ? AND seq = ?', empresaId, seq));
    },
    async historicoDesfeito(empresaId, seq) {
      return Boolean(obter("SELECT 1 FROM historico WHERE empresa_id = ? AND ref_seq = ? AND acao = 'desfeita'", empresaId, seq));
    },
    async historicoExcluidas() {
      return listar("SELECT seq, evento FROM historico WHERE acao = 'excluida' AND entidade = 'empresa' ORDER BY seq DESC").map(lerEvento);
    },

    async empresaExcluir(id, evento) {
      return transacionar(() => {
        gravar('DELETE FROM empresas WHERE id = ?', id);
        gravar('DELETE FROM idempotencia WHERE empresa_id = ?', id);
        return acrescentarEvento(evento);
      });
    },
    async tentativasAdminObter() { return { ...(obter('SELECT n, ate FROM tentativas_admin WHERE id = 1') || { n: 0, ate: 0 }) }; },
    async tentativasAdminGravar({ n, ate }) {
      gravar('INSERT INTO tentativas_admin (id, n, ate) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET n = excluded.n, ate = excluded.ate', n, ate);
    },
  };

  const repositorio = { plat: p };
  for (const [nome, operacao] of Object.entries(interno)) {
    if (nome !== 'plat') repositorio[nome] = (...args) => enfileirar(chaveFila, () => operacao(...args));
  }
  repositorio.transacao = (executar) => enfileirar(chaveFila, () => transacionar(() => executar(interno)));
  repositorio.fechar = () => enfileirar(chaveFila, () => db.close());
  return repositorio;
}
