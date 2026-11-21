// Repositório: a única camada que enxerga como os dados são guardados. Hoje, memória.
// Amanhã, D1 (registros) e R2 (arquivos): troca só este arquivo; o núcleo e os serviços não mudam.
//
// Regras do contrato:
//  - Toda função é async (D1 é assíncrono). O que devolve é para LEITURA: quem precisa mudar algo chama uma operação nomeada.
//  - As operações marcadas ATÔMICA fazem tudo-ou-nada (no D1: uma transação ou `batch`). Ver docs/atomicidade.md.
//  - O repositório não conhece HTTP, papéis nem permissões; só dados e invariantes (sobreposição de mesa, id único, limites).

import { gerarCodigoReserva, plataformaWeb } from './plataforma.js';
import { prepararReservaSemeada } from './reservas.js';

function congelar(o) {
  if (o && typeof o === 'object') { Object.values(o).forEach(congelar); Object.freeze(o); }
  return o;
}

const MODULOS_PADRAO = { reservas: true, conhecimento: true };

// Idempotência: as respostas guardadas por chave expiram e têm teto por empresa, para a memória não crescer sem limite.
export const IDEMPOTENCIA_TTL_PADRAO_MS = 24 * 60 * 60 * 1000; // 24 h
export const IDEMPOTENCIA_MAX_PADRAO = 10000; // entradas por empresa (as mais antigas saem primeiro)

// opcoes.plat: plataforma (padrão: Web API). opcoes.sink: função chamada com cada evento de histórico gravado
// (o adaptador Node usa para gravar em arquivo); o núcleo só chama sink(evento).
// opcoes.idempotenciaTtlMs / opcoes.idempotenciaMax: validade e teto por empresa das respostas de idempotência.
export function criarRepositorioMemoria({ plat, sink, idempotenciaTtlMs, idempotenciaMax } = {}) {
  const p = plat || plataformaWeb();
  const empresas = new Map(); // id -> { id, nome, agente, ambientes, modulos, chave, conhecimento: [], proxConhecimento }
  const reservas = new Map(); // UUID interno -> reserva com o código público em id
  const codigosPorEmpresa = new Map(); // empresa -> código já emitido -> UUID; preservado na exclusão
  const ttlIdem = idempotenciaTtlMs > 0 ? idempotenciaTtlMs : IDEMPOTENCIA_TTL_PADRAO_MS;
  const maxIdem = idempotenciaMax > 0 ? idempotenciaMax : IDEMPOTENCIA_MAX_PADRAO;
  const idempotencia = new Map(); // empresaId -> Map(chave -> { resposta, quando }), na ordem em que foram gravadas
  // Resposta guardada para a chave, ou null se não existe ou já passou da validade (e então é esquecida).
  const idemObter = (empresaId, chave) => {
    const m = idempotencia.get(empresaId);
    const e = m && m.get(chave);
    if (!e) return null;
    if (p.agora() - e.quando >= ttlIdem) { m.delete(chave); return null; }
    return e.resposta;
  };
  // Guarda a resposta; descarta o que já expirou e, passando do teto, as entradas mais antigas.
  const idemGravar = (empresaId, chave, resposta) => {
    let m = idempotencia.get(empresaId);
    if (!m) { m = new Map(); idempotencia.set(empresaId, m); }
    const agora = p.agora();
    m.delete(chave); // regravar a chave a torna a mais nova
    m.set(chave, { resposta, quando: agora });
    for (const [k, e] of m) { if (agora - e.quando >= ttlIdem) m.delete(k); else break; }
    while (m.size > maxIdem) m.delete(m.keys().next().value);
  };
  const historico = [];
  const boot = p.uuid();
  let tentativasAdmin = { n: 0, ate: 0 };

  const sobrepoe = (r, mesaId, ini, fim, ignorarId) =>
    r.id !== ignorarId && r.mesaId === mesaId && r.status === 'confirmada' && ini < r.fim && fim > r.inicio;
  const ocupada = (empresaId, mesaId, ini, fim, ignorarId) =>
    [...reservas.values()].some((r) => r.empresaId === empresaId && sobrepoe(r, mesaId, ini, fim, ignorarId));
  const obterReserva = (empresaId, id) => reservas.get(codigosPorEmpresa.get(empresaId)?.get(id)) || null;

  function inserirReserva(empresaId, dados) {
    const codigos = codigosPorEmpresa.get(empresaId) || new Map();
    const codigo = gerarCodigoReserva(p, (c) => codigos.has(c));
    const uuid = p.uuid();
    if (reservas.has(uuid)) throw new Error('UUID de reserva duplicado');
    const reserva = { id: codigo, empresaId, ...dados };
    reservas.set(uuid, reserva);
    codigos.set(codigo, uuid);
    codigosPorEmpresa.set(empresaId, codigos);
    return reserva;
  }

  return {
    plat: p,

    // ---------- empresas ----------
    async empresaObter(id) { return empresas.get(id) || null; },
    async empresaListar() { return [...empresas.values()]; },
    async empresaCriar({ id, nome, agente, ambientes, modulos, reservas: sementes = [] }) {
      const e = { id, nome, agente, ambientes, chave: null, modulos: { ...MODULOS_PADRAO, ...(modulos || {}) }, conhecimento: [], proxConhecimento: 1 };
      const criadas = [];
      try {
        for (const semente of sementes) {
          const dados = prepararReservaSemeada(semente, ambientes);
          if (dados.status === 'confirmada' && ocupada(id, dados.mesaId, dados.inicio, dados.fim)) throw new Error('sobreposição de reservas na semente');
          criadas.push(inserirReserva(id, dados));
        }
      } catch (erro) {
        const codigos = codigosPorEmpresa.get(id);
        for (const reserva of criadas) {
          reservas.delete(codigos.get(reserva.id));
          codigos.delete(reserva.id);
        }
        throw erro;
      }
      empresas.set(id, e);
      return e;
    },
    // Próximo id livre. Ids de empresa nunca são reaproveitados: também confere o histórico (empresas excluídas).
    async empresaProximoId() {
      let n = empresas.size + 1;
      while (empresas.has(`empresa_${n}`) || historico.some((e) => e.empresaId === `empresa_${n}`)) n++;
      return `empresa_${n}`;
    },
    async empresaNomeEmUso(nome, ignorarId) {
      return [...empresas.values()].some((x) => x.id !== ignorarId && x.nome.toLowerCase() === nome.toLowerCase());
    },
    async empresaRenomear(id, nome) {
      const e = empresas.get(id);
      const antes = e.nome;
      e.nome = nome;
      return { antes, depois: nome };
    },
    async empresaModulosDefinir(id, modulos) {
      const e = empresas.get(id);
      Object.assign(e.modulos, modulos);
      return { ...e.modulos };
    },
    async agenteAtualizar(id, mudancas) {
      Object.assign(empresas.get(id).agente, mudancas);
    },

    // ---------- chave de API da empresa (só o hash é guardado) ----------
    async chaveDefinir(id, chave) { empresas.get(id).chave = chave; },
    async chaveRemover(id) { empresas.get(id).chave = null; },
    // Autenticação: acha a empresa dona do hash (comparação em tempo constante).
    async empresaPorChaveHash(hash) {
      for (const e of empresas.values()) if (e.chave && p.iguaisTempoConstante(hash, e.chave.hash)) return e.id;
      return null;
    },

    // ---------- ambientes e mesas ----------
    // { ok: true } | { ok: false, motivo: 'duplicado' }
    async ambienteCriar(empresaId, nome) {
      const e = empresas.get(empresaId);
      if (e.ambientes.some((a) => a.nome.toLowerCase() === nome.toLowerCase())) return { ok: false, motivo: 'duplicado' };
      e.ambientes.push({ nome, mesas: [] });
      return { ok: true };
    },
    // Cria a mesa com o próximo id livre (letra do ambiente + número). Devolve a mesa ou null se o ambiente não existe.
    async mesaCriar(empresaId, ambienteNome, { capacidade, reservavel }) {
      const e = empresas.get(empresaId);
      const amb = e.ambientes.find((a) => a.nome === ambienteNome);
      if (!amb) return null;
      const base = (amb.nome.match(/[A-Za-z]/) || ['M'])[0].toUpperCase();
      const existentes = new Set(e.ambientes.flatMap((a) => a.mesas.map((m) => m.id)));
      let n = 1;
      while (existentes.has(`${base}${n}`)) n++;
      const mesa = { id: `${base}${n}`, capacidade, reservavel: reservavel !== false };
      amb.mesas.push(mesa);
      return mesa;
    },
    // Devolve { antes, mesa } ou null se a mesa não existe.
    async mesaEditar(empresaId, mesaId, { capacidade, reservavel }) {
      const mesa = empresas.get(empresaId).ambientes.flatMap((a) => a.mesas).find((m) => m.id === mesaId);
      if (!mesa) return null;
      const antes = { capacidade: mesa.capacidade, reservavel: mesa.reservavel };
      if (capacidade !== undefined) mesa.capacidade = capacidade;
      if (reservavel !== undefined) mesa.reservavel = reservavel;
      return { antes, mesa };
    },

    // ---------- reservas ----------
    async reservaListar(empresaId, { data } = {}) {
      return [...reservas.values()].filter((r) => r.empresaId === empresaId && (!data || r.data === data));
    },
    async reservaObter(empresaId, id) { return obterReserva(empresaId, id); },
    // Reservas confirmadas da empresa (menos `ignorarId`): base para calcular mesas livres e o mapa.
    async reservaConfirmadas(empresaId, ignorarId) {
      return [...reservas.values()].filter((r) => r.empresaId === empresaId && r.status === 'confirmada' && r.id !== ignorarId);
    },
    // ATÔMICA. Reserva a primeira mesa livre da lista `candidatas` ([{ mesaId, ambiente }], em ordem de preferência):
    //   1) se a chave de idempotência já tem resposta, devolve { criada: false, resposta };
    //   2) rechecando a sobreposição agora, insere a reserva na primeira candidata livre e guarda a resposta da chave;
    //   3) se todas foram tomadas nesse meio-tempo, devolve { conflito: true } (nada gravado).
    async reservaCriar({ empresaId, chave, candidatas, reserva }) {
      const antiga = chave ? idemObter(empresaId, chave) : null;
      if (antiga) return { criada: false, resposta: antiga };
      for (const c of candidatas) {
        if (ocupada(empresaId, c.mesaId, reserva.inicio, reserva.fim)) continue;
        const r = inserirReserva(empresaId, { mesaId: c.mesaId, ambiente: c.ambiente, ...reserva, status: 'confirmada' });
        const resposta = { status: 'confirmada', reservaId: r.id, mesa: r.mesaId, ambiente: r.ambiente };
        if (chave) idemGravar(empresaId, chave, resposta);
        return { criada: true, resposta, reserva: r };
      }
      return { conflito: true };
    },
    // Guarda a resposta de uma chave de idempotência (usada para a resposta "indisponivel", que não grava reserva).
    async idempotenciaObter(empresaId, chave) { return idemObter(empresaId, chave); },
    async idempotenciaGravar(empresaId, chave, resposta) { idemGravar(empresaId, chave, resposta); },
    // Quantas respostas de idempotência a empresa guarda agora (inclui as ainda não varridas por expiração).
    async idempotenciaTamanho(empresaId) { const m = idempotencia.get(empresaId); return m ? m.size : 0; },
    // ATÔMICA. Muda pessoas/data/horário/mesa de uma reserva confirmada, rechecando a sobreposição. cliente: campos de nome/contato
    // ('' apaga o campo). { ok: true, reserva } | { ok: false, motivo: 'conflito' }
    async reservaEditar({ empresaId, id, dados, cliente }) {
      const r = obterReserva(empresaId, id);
      if (ocupada(empresaId, dados.mesaId, dados.inicio, dados.fim, id)) return { ok: false, motivo: 'conflito' };
      Object.assign(r, dados, cliente || {});
      for (const k of Object.keys(cliente || {})) if (cliente[k] === '') delete r[k];
      return { ok: true, reserva: r };
    },
    // ATÔMICA. Cancela (libera a mesa). Devolve a reserva.
    async reservaCancelar(empresaId, id) {
      const r = obterReserva(empresaId, id);
      r.status = 'cancelada';
      return r;
    },
    // ATÔMICA. Reativa rechecando a sobreposição. { ok: true, reserva } | { ok: false, motivo: 'conflito' }
    async reservaReativar(empresaId, id) {
      const r = obterReserva(empresaId, id);
      if (r.status === 'confirmada') return { ok: true, reserva: r };
      if (ocupada(empresaId, r.mesaId, r.inicio, r.fim, id)) return { ok: false, motivo: 'conflito' };
      r.status = 'confirmada';
      return { ok: true, reserva: r };
    },

    // ---------- base de conhecimento ----------
    async conhecimentoListar(empresaId) { return empresas.get(empresaId).conhecimento; },
    async conhecimentoObter(empresaId, id) { return empresas.get(empresaId).conhecimento.find((x) => x.id === id) || null; },
    // ATÔMICA (id sequencial + limite). { ok: true, item } | { ok: false, motivo: 'limite' }
    async conhecimentoCriar(empresaId, item, maxItens) {
      const e = empresas.get(empresaId);
      if (e.conhecimento.length >= maxItens) return { ok: false, motivo: 'limite' };
      const novo = { id: e.proxConhecimento, ...item };
      e.proxConhecimento += 1;
      e.conhecimento.push(novo);
      return { ok: true, item: novo };
    },
    // `mudancas` entram por cima do item; chave com valor undefined é removida. Devolve o item ou null.
    async conhecimentoEditar(empresaId, id, mudancas) {
      const item = empresas.get(empresaId).conhecimento.find((x) => x.id === id);
      if (!item) return null;
      for (const [k, v] of Object.entries(mudancas)) { if (v === undefined) delete item[k]; else item[k] = v; }
      return item;
    },
    async conhecimentoExcluir(empresaId, id) {
      const e = empresas.get(empresaId);
      const item = e.conhecimento.find((x) => x.id === id) || null;
      if (item) e.conhecimento = e.conhecimento.filter((x) => x.id !== id);
      return item;
    },

    // ---------- histórico (só acrescenta; não existe operação para alterar ou apagar eventos) ----------
    async historicoAcrescentar(ev) {
      const e = congelar({ seq: historico.length + 1, boot, quando: new Date(p.agora()).toISOString(), ...JSON.parse(JSON.stringify(ev)) });
      historico.push(e);
      if (sink) sink(e); // sumidouro de auditoria injetado pelo adaptador (arquivo, fila...); o núcleo só chama sink(evento)
      return e;
    },
    async historicoListar(empresaId, { entidade, entidadeId, limite } = {}) {
      const n = Math.min(Math.max(Number(limite) || 200, 1), 1000);
      return historico
        .filter((e) => e.empresaId === empresaId && (!entidade || e.entidade === entidade) && (!entidadeId || String(e.entidadeId) === String(entidadeId)))
        .slice(-n)
        .reverse();
    },
    async historicoObter(empresaId, seq) { return historico.find((e) => e.seq === seq && e.empresaId === empresaId) || null; },
    async historicoDesfeito(empresaId, seq) { return historico.some((e) => e.empresaId === empresaId && e.acao === 'desfeita' && e.refSeq === seq); },
    async historicoExcluidas() { return historico.filter((e) => e.acao === 'excluida' && e.entidade === 'empresa').reverse(); },

    // ---------- exclusão de empresa ----------
    // ATÔMICA. Apaga a empresa com tudo o que é dela (reservas, chaves de idempotência, conhecimento, chave de API)
    // e grava o evento de auditoria junto. Devolve o evento gravado.
    async empresaExcluir(id, evento) {
      empresas.delete(id);
      const codigos = codigosPorEmpresa.get(id);
      for (const [codigo, uuid] of codigos || []) {
        reservas.delete(uuid);
        codigos.set(codigo, null);
      }
      idempotencia.delete(id);
      return this.historicoAcrescentar(evento);
    },
    // Bloqueio por tentativas erradas da senha do administrador (n erros, bloqueado até `ate` em ms).
    async tentativasAdminObter() { return { ...tentativasAdmin }; },
    async tentativasAdminGravar(t) { tentativasAdmin = { n: t.n, ate: t.ate }; },
  };
}
