import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gerarCodigoReserva, plataformaWeb } from '../plataforma.js';
import { IDEMPOTENCIA_MAX_PADRAO, IDEMPOTENCIA_TTL_PADRAO_MS } from '../repositorio.js';
import { prepararReservaSemeada } from '../reservas.js';
import { limparIdempotencia } from './idempotencia-limpeza.js';

const MIGRACAO = new URL('../../db/migrations/0001_inicial.sql', import.meta.url);
const MODULOS_PADRAO = { reservas: true, conhecimento: true };
const CONFLITO = { ok: false, motivo: 'conflito' };
const COLUNAS_RESERVA = 'codigo AS id, empresa_id AS empresaId, mesa_id AS mesaId, ambiente, data, horario, pessoas, inicio, fim, status, nome_cliente AS nomeCliente, contato';

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
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON');
    try {
      const diagnosticos = db.prepare('PRAGMA integrity_check').all().map((linha) => linha.integrity_check);
      if (diagnosticos.length !== 1 || diagnosticos[0] !== 'ok') throw new Error(diagnosticos.join('; ') || 'resultado vazio');
    } catch (erro) {
      throw new Error(`Integridade do SQLite falhou em "${caminho}": ${erro.message}`, { cause: erro });
    }
    if (caminho !== ':memory:' && db.prepare('PRAGMA journal_mode = WAL').get().journal_mode !== 'wal') {
      throw new Error(`Não foi possível ativar WAL no SQLite em "${caminho}"`);
    }
    // FULL sincroniza cada commit do WAL, inclusive em caso de perda de energia.
    db.exec('PRAGMA synchronous = FULL');
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
  // O backup precisa copiar também este diretório de anexos ao lado do arquivo SQLite.
  const pastaArquivos = caminho === ':memory:' ? null : `${chaveFila}.arquivos`;
  const arquivosEmMemoria = pastaArquivos ? null : new Map();
  let transacaoAtual = null;
  // Em WAL um leitor comum não bloqueia o escritor. Protege a leitura do anexo local
  // contra a remoção da versão anterior por outra conexão após o commit.
  const inicioLeitura = (comArquivos) => comArquivos && pastaArquivos ? 'BEGIN IMMEDIATE' : 'BEGIN';

  function caminhoDoArquivo(chave) {
    const nome = chave.split('/').at(-1);
    if (!/^[a-f0-9-]{36}$/.test(nome)) throw new Error('chave de arquivo inválida');
    return join(pastaArquivos, nome);
  }

  function removerArquivo(chave) {
    if (arquivosEmMemoria) arquivosEmMemoria.delete(chave);
    else {
      // A limpeza pode deixar um arquivo órfão, sem afetar a linha já confirmada ou revertida.
      try { rmSync(caminhoDoArquivo(chave), { force: true }); } catch { /* limpeza posterior */ }
    }
  }

  async function transacionar(executar, inicio = 'BEGIN IMMEDIATE') {
    if (transacaoAtual) return executar();
    db.exec(inicio);
    const tx = { eventos: [], arquivosCriados: [], arquivosDescartar: [] };
    transacaoAtual = tx;
    let resultado;
    try {
      resultado = await executar();
      db.exec('COMMIT');
    } catch (erro) {
      db.exec('ROLLBACK');
      for (const chave of tx.arquivosCriados) removerArquivo(chave);
      throw erro;
    } finally {
      transacaoAtual = null;
    }
    for (const chave of tx.arquivosDescartar) removerArquivo(chave);
    if (sink) for (const evento of tx.eventos) sink(evento);
    return resultado;
  }

  function guardarArquivo(empresaId, item) {
    if (typeof item.arquivo?.base64 !== 'string') return item;
    const { base64, ...arquivo } = item.arquivo;
    const bytes = p.base64Decodificar(base64);
    const chave = `empresas/${encodeURIComponent(empresaId)}/conhecimento/${randomUUID()}`;
    if (arquivosEmMemoria) {
      arquivosEmMemoria.set(chave, bytes);
      transacaoAtual.arquivosCriados.push(chave);
    } else {
      mkdirSync(pastaArquivos, { recursive: true, mode: 0o700 });
      const fd = openSync(caminhoDoArquivo(chave), 'wx', 0o600);
      transacaoAtual.arquivosCriados.push(chave);
      try { writeFileSync(fd, bytes, { flush: true }); } finally { closeSync(fd); }
    }
    return { ...item, arquivo, arquivoChave: chave };
  }

  function carregarItem({ arquivoChave, ...item }, incluirArquivo) {
    if (arquivoChave && incluirArquivo) {
      const bytes = arquivosEmMemoria ? arquivosEmMemoria.get(arquivoChave) : readFileSync(caminhoDoArquivo(arquivoChave));
      item.arquivo.base64 = p.base64Codificar(bytes);
    }
    return item;
  }

  const linhasConhecimento = (empresaId) =>
    listar('SELECT item FROM conhecimento WHERE empresa_id = ? ORDER BY id', empresaId).map((linha) => JSON.parse(linha.item));
  const listarConhecimento = (empresaId, incluirArquivo) =>
    linhasConhecimento(empresaId).map((item) => carregarItem(item, incluirArquivo));
  const obterItemGuardado = (empresaId, id) => {
    const linha = obter('SELECT item FROM conhecimento WHERE empresa_id = ? AND id = ?', empresaId, id);
    return linha ? JSON.parse(linha.item) : null;
  };
  function descartarArquivosDaEmpresa(empresaId) {
    for (const { arquivoChave } of linhasConhecimento(empresaId)) {
      if (arquivoChave) transacaoAtual.arquivosDescartar.push(arquivoChave);
    }
  }
  const lerMesa = ({ mesa_id, capacidade, reservavel }) => ({ id: mesa_id, capacidade, reservavel: Boolean(reservavel) });
  function lerEmpresa(linha, incluirConhecimento) {
    if (!linha) return null;
    const { id, nome, agente, chave, modulos, prox_conhecimento } = linha;
    const ambientes = listar('SELECT id, nome FROM ambientes WHERE empresa_id = ? ORDER BY id', id).map((a) => ({
      nome: a.nome,
      mesas: listar('SELECT * FROM mesas WHERE empresa_id = ? AND ambiente_id = ? ORDER BY ordem', id, a.id).map(lerMesa),
    }));
    return {
      id, nome, agente: JSON.parse(agente), ambientes, chave: JSON.parse(chave),
      modulos: JSON.parse(modulos), conhecimento: incluirConhecimento ? listarConhecimento(id, true) : [], proxConhecimento: prox_conhecimento,
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
    lerReserva(obter(`SELECT ${COLUNAS_RESERVA} FROM reservas WHERE empresa_id = ? AND codigo = ?`, empresaId, id));
  const ocupada = (empresaId, mesaId, inicio, fim, ignorarId = null) => Boolean(obter(
    `SELECT 1 FROM reservas WHERE empresa_id = ? AND mesa_id = ? AND status = 'confirmada'
      AND codigo IS NOT ? AND fim > ? AND inicio < ? LIMIT 1`, empresaId, mesaId, ignorarId, inicio, fim,
  ));

  function inserirReserva(empresaId, reserva) {
    const { mesaId, ambiente, data, horario, pessoas, inicio, fim, status, nomeCliente, contato } = reserva;
    const codigo = gerarCodigoReserva(p, (c) => Boolean(obter('SELECT 1 FROM reservas_codigos WHERE empresa_id = ? AND codigo = ?', empresaId, c)));
    gravar(`INSERT INTO reservas
      (id, empresa_id, codigo, mesa_id, ambiente, data, horario, pessoas, inicio, fim, status, nome_cliente, contato)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    p.uuid(), empresaId, codigo, mesaId, ambiente, data, horario, pessoas, inicio, fim, status, nomeCliente ?? null, contato ?? null);
    return codigo;
  }

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
    transacaoAtual.eventos.push(e);
    return e;
  }

  // A fachada interna participa da transação existente. A pública espera a fila do arquivo.
  const interno = {
    plat: p,

    async empresaObter(id, { incluirConhecimento = true } = {}) {
      return transacionar(() => lerEmpresa(obter('SELECT * FROM empresas WHERE id = ?', id), incluirConhecimento), inicioLeitura(incluirConhecimento));
    },
    async empresaListar({ incluirConhecimento = true } = {}) {
      return transacionar(() => listar('SELECT * FROM empresas ORDER BY rowid').map((e) => lerEmpresa(e, incluirConhecimento)), inicioLeitura(incluirConhecimento));
    },
    async empresaCriar({ id, nome, agente, ambientes, modulos, reservas: sementes = [] }) {
      return transacionar(() => {
        const modulosFinais = { ...MODULOS_PADRAO, ...(modulos || {}) };
        gravar(`INSERT INTO empresas (id, nome, nome_normalizado, agente, modulos) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET nome = excluded.nome, nome_normalizado = excluded.nome_normalizado, agente = excluded.agente,
          modulos = excluded.modulos, chave = NULL, prox_conhecimento = 1`,
        id, nome, nome.toLowerCase(), JSON.stringify(agente), JSON.stringify(modulosFinais));
        gravar('DELETE FROM ambientes WHERE empresa_id = ?', id);
        descartarArquivosDaEmpresa(id);
        gravar('DELETE FROM conhecimento WHERE empresa_id = ?', id);
        for (const a of ambientes) {
          const ambienteId = inserirAmbiente(id, a.nome);
          for (const mesa of a.mesas) inserirMesa(id, ambienteId, mesa);
        }
        for (const semente of sementes) inserirReserva(id, prepararReservaSemeada(semente, ambientes));
        return lerEmpresa(obter('SELECT * FROM empresas WHERE id = ?', id), false);
      });
    },
    async empresaProximoId() {
      let n = obter('SELECT COUNT(*) AS n FROM empresas').n + 1;
      while (obter('SELECT 1 FROM empresas WHERE id = ? UNION ALL SELECT 1 FROM historico WHERE empresa_id = ? LIMIT 1',
        `empresa_${n}`, `empresa_${n}`)) n++;
      return `empresa_${n}`;
    },
    async empresaNomeEmUso(nome, ignorarId) {
      return Boolean(obter(`SELECT 1 FROM empresas WHERE nome_normalizado = ? AND id IS NOT ?
        UNION ALL SELECT 1 FROM empresas WHERE nome = ? AND id IS NOT ? LIMIT 1`,
      nome.toLowerCase(), ignorarId ?? null, nome, ignorarId ?? null));
    },
    async empresaRenomear(id, nome) {
      return transacionar(() => {
        const { nome: antes } = obter('SELECT nome FROM empresas WHERE id = ?', id);
        gravar('UPDATE empresas SET nome = ?, nome_normalizado = ? WHERE id = ?', nome, nome.toLowerCase(), id);
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
      const e = obter('SELECT id, chave_hash FROM empresas WHERE chave_hash = ? ORDER BY rowid LIMIT 1', hash);
      return e && p.iguaisTempoConstante(hash, e.chave_hash) ? e.id : null;
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
        AND (? IS NULL OR data = ?) ORDER BY rowid`, empresaId, data || null, data || null).map(lerReserva);
    },
    async reservaObter(empresaId, id) { return obterReserva(empresaId, id); },
    async reservaConfirmadas(empresaId, ignorarId = null) {
      return listar(`SELECT ${COLUNAS_RESERVA} FROM reservas WHERE empresa_id = ?
        AND status = 'confirmada' AND codigo IS NOT ? ORDER BY rowid`, empresaId, ignorarId).map(lerReserva);
    },
    async reservaCriar({ empresaId, chave, candidatas, reserva }) {
      return transacionar(async () => {
        const antiga = chave ? idemObter(empresaId, chave) : null;
        if (antiga) return { criada: false, resposta: antiga };
        const { inicio, fim } = reserva;
        const candidata = candidatas.find((c) => !ocupada(empresaId, c.mesaId, inicio, fim));
        if (!candidata) return { conflito: true };
        const { mesaId, ambiente } = candidata;
        const id = inserirReserva(empresaId, { ...reserva, mesaId, ambiente, status: 'confirmada' });
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
          inicio = ?, fim = ?, nome_cliente = ?, contato = ? WHERE empresa_id = ? AND codigo = ?`,
        nova.mesaId, nova.ambiente, nova.data, nova.horario, nova.pessoas, nova.inicio, nova.fim,
        cliente?.nomeCliente === '' ? null : nova.nomeCliente ?? null, cliente?.contato === '' ? null : nova.contato ?? null,
        empresaId, id);
        return { ok: true, reserva: obterReserva(empresaId, id) };
      });
    },
    async reservaCancelar(empresaId, id) {
      return lerReserva(obter(`UPDATE reservas SET status = 'cancelada' WHERE empresa_id = ? AND codigo = ?
        RETURNING ${COLUNAS_RESERVA}`, empresaId, id));
    },
    async reservaReativar(empresaId, id) {
      return transacionar(() => {
        const atual = obterReserva(empresaId, id);
        if (atual.status === 'confirmada') return { ok: true, reserva: atual };
        if (ocupada(empresaId, atual.mesaId, atual.inicio, atual.fim, id)) return { ...CONFLITO };
        gravar("UPDATE reservas SET status = 'confirmada' WHERE empresa_id = ? AND codigo = ?", empresaId, id);
        return { ok: true, reserva: { ...atual, status: 'confirmada' } };
      });
    },

    async conhecimentoListar(empresaId, { incluirArquivo = true } = {}) {
      return transacionar(() => listarConhecimento(empresaId, incluirArquivo), inicioLeitura(incluirArquivo));
    },
    async conhecimentoObter(empresaId, id, { incluirArquivo = true } = {}) {
      return transacionar(() => {
        const item = obterItemGuardado(empresaId, id);
        return item ? carregarItem(item, incluirArquivo) : null;
      }, inicioLeitura(incluirArquivo));
    },
    async conhecimentoCriar(empresaId, item, maxItens) {
      return transacionar(() => {
        if (obter('SELECT COUNT(*) AS n FROM conhecimento WHERE empresa_id = ?', empresaId).n >= maxItens) {
          return { ok: false, motivo: 'limite' };
        }
        const { id } = obter(`UPDATE empresas SET prox_conhecimento = prox_conhecimento + 1 WHERE id = ?
          RETURNING prox_conhecimento - 1 AS id`, empresaId);
        const novo = { id, ...item };
        gravar('INSERT INTO conhecimento (empresa_id, id, item) VALUES (?, ?, ?)', empresaId, id, JSON.stringify(guardarArquivo(empresaId, novo)));
        return { ok: true, item: novo };
      });
    },
    async conhecimentoEditar(empresaId, id, mudancas) {
      return transacionar(() => {
        const atual = obterItemGuardado(empresaId, id);
        if (!atual) return null;
        const novo = { ...atual, ...mudancas };
        for (const k of Object.keys(mudancas)) if (mudancas[k] === undefined) delete novo[k];
        if (Object.hasOwn(mudancas, 'arquivo')) delete novo.arquivoChave;
        const guardado = guardarArquivo(empresaId, novo);
        gravar('UPDATE conhecimento SET item = ? WHERE empresa_id = ? AND id = ?', JSON.stringify(guardado), empresaId, id);
        if (atual.arquivoChave && atual.arquivoChave !== guardado.arquivoChave) transacaoAtual.arquivosDescartar.push(atual.arquivoChave);
        return carregarItem(guardado, true);
      });
    },
    async conhecimentoExcluir(empresaId, id) {
      return transacionar(() => {
        const linha = obter('DELETE FROM conhecimento WHERE empresa_id = ? AND id = ? RETURNING item', empresaId, id);
        if (!linha) return null;
        const item = JSON.parse(linha.item);
        if (item.arquivoChave) transacaoAtual.arquivosDescartar.push(item.arquivoChave);
        return carregarItem(item, true);
      });
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
        descartarArquivosDaEmpresa(id);
        gravar('DELETE FROM empresas WHERE id = ?', id);
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
