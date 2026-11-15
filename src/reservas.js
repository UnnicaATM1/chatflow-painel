'use strict';

const { empresa } = require('./agentes');

const DURACAO_MIN = 90;
const DURACAO_MS = DURACAO_MIN * 60000;

function inicio(data, horario) {
  return new Date(`${data}T${horario}:00`).getTime();
}

function livres(store, l, data, horario, pessoas, ambiente, ignorarId) {
  const i = inicio(data, horario);
  const out = [];
  for (const amb of l.ambientes) {
    if (ambiente && amb.nome !== ambiente) continue;
    for (const m of amb.mesas) {
      if (!m.reservavel || m.capacidade < pessoas) continue;
      const ocupada = store.reservas.some(
        (r) => r.id !== ignorarId && r.empresaId === l.id && r.mesaId === m.id && r.status === 'confirmada' && i < r.fim && i + DURACAO_MS > r.inicio
      );
      if (!ocupada) out.push({ mesa: m, ambiente: amb.nome });
    }
  }
  return out;
}

// Mesas ainda livres no horário, agrupadas pelos ambientes do layout da empresa.
function disponibilidade(store, empresaId, data, horario, pessoas, ignorarId) {
  const l = empresa(store, empresaId);
  if (!Number.isInteger(pessoas) || pessoas < 1) throw new Error('pessoas inválido');
  const porAmbiente = new Map(l.ambientes.map((a) => [a.nome, []]));
  for (const x of livres(store, l, data, horario, pessoas, undefined, ignorarId)) {
    porAmbiente.get(x.ambiente).push({ id: x.mesa.id, capacidade: x.mesa.capacidade });
  }
  return {
    ambientes: [...porAmbiente].map(([ambiente, mesas]) => ({ ambiente, mesas: mesas.sort((a, b) => a.capacidade - b.capacidade) })),
  };
}

function erro(msg, codigo) { return Object.assign(new Error(msg), { codigo }); }

// Dados do cliente que o chat conhece (opcionais): nome até 80 e contato (telefone ou e-mail) até 40 caracteres.
function validarCliente(d) {
  const out = {};
  for (const [campo, max] of [['nomeCliente', 80], ['contato', 40]]) {
    if (d[campo] === undefined || d[campo] === null) continue;
    if (typeof d[campo] !== 'string') throw erro(`${campo} deve ser texto`, 400);
    const v = d[campo].trim();
    if ([...v].length > max) throw erro(`${campo} passa do limite de ${max} caracteres`, 400);
    out[campo] = v;
  }
  return out;
}

function reservar(store, { empresaId, data, horario, pessoas, ambiente, mesaId, chave, nomeCliente, contato }) {
  const l = empresa(store, empresaId);
  if (!Number.isInteger(pessoas) || pessoas < 1) throw new Error('pessoas inválido');
  const cliente = validarCliente({ nomeCliente, contato });

  const k = `${empresaId}:${chave}`;
  if (chave && store.chaves.has(k)) return store.chaves.get(k);

  let ok = livres(store, l, data, horario, pessoas, ambiente);
  if (mesaId) ok = ok.filter((x) => x.mesa.id === mesaId);
  let res;
  if (ok.length) {
    ok.sort((a, b) => a.mesa.capacidade - b.mesa.capacidade);
    const { mesa, ambiente: amb } = ok[0];
    const ini = inicio(data, horario);
    const r = {
      id: (store.seqReserva = (store.seqReserva || 0) + 1), empresaId, mesaId: mesa.id, ambiente: amb,
      data, horario, pessoas, inicio: ini, fim: ini + DURACAO_MS, status: 'confirmada', ...cliente,
    };
    store.reservas.push(r);
    res = { status: 'confirmada', reservaId: r.id, mesa: mesa.id, ambiente: amb };
  } else {
    const alt = new Map();
    if (ambiente) {
      for (const x of livres(store, l, data, horario, pessoas)) {
        alt.set(x.ambiente, { tipo: 'outro-ambiente', ambiente: x.ambiente });
      }
    }
    res = { status: 'indisponivel', alternativas: [...alt.values()], disponibilidade: disponibilidade(store, empresaId, data, horario, pessoas).ambientes };
  }
  if (chave) store.chaves.set(k, res);
  return res;
}

function achar(store, empresaId, id) {
  empresa(store, empresaId);
  const r = store.reservas.find((x) => x.id === id && x.empresaId === empresaId);
  if (!r) throw erro('reserva inexistente', 404);
  return r;
}

// Edita pessoas, data, horário e/ou mesa. Sem mesaId, mantém a mesa atual se ainda servir.
function editarReserva(store, empresaId, id, mudancas) {
  const l = empresa(store, empresaId);
  const r = achar(store, empresaId, id);
  if (r.status !== 'confirmada') throw erro('reserva cancelada; reative antes de editar', 409);
  const pessoas = mudancas.pessoas !== undefined ? mudancas.pessoas : r.pessoas;
  const data = mudancas.data || r.data;
  const horario = mudancas.horario || r.horario;
  const mesaId = mudancas.mesaId || r.mesaId;
  if (!Number.isInteger(pessoas) || pessoas < 1) throw erro('pessoas inválido', 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !/^\d{2}:\d{2}$/.test(horario)) throw erro('data ou horário inválido', 400);
  const alvo = livres(store, l, data, horario, pessoas, undefined, r.id).find((x) => x.mesa.id === mesaId);
  if (!alvo) {
    return { status: 'indisponivel', disponibilidade: disponibilidade(store, empresaId, data, horario, pessoas, r.id).ambientes };
  }
  const ini = inicio(data, horario);
  const cliente = validarCliente(mudancas);
  Object.assign(r, { pessoas, data, horario, mesaId, ambiente: alvo.ambiente, inicio: ini, fim: ini + DURACAO_MS }, cliente);
  for (const k of Object.keys(cliente)) if (cliente[k] === '') delete r[k];
  return { status: 'atualizada', reserva: publica(r) };
}

function cancelarReserva(store, empresaId, id) {
  const r = achar(store, empresaId, id);
  r.status = 'cancelada';
  return { status: 'cancelada', reserva: publica(r) };
}

function reativarReserva(store, empresaId, id) {
  const l = empresa(store, empresaId);
  const r = achar(store, empresaId, id);
  if (r.status === 'confirmada') return { status: 'confirmada', reserva: publica(r) };
  const ok = livres(store, l, r.data, r.horario, r.pessoas, undefined, r.id).some((x) => x.mesa.id === r.mesaId);
  if (!ok) return { status: 'indisponivel', disponibilidade: disponibilidade(store, empresaId, r.data, r.horario, r.pessoas, r.id).ambientes };
  r.status = 'confirmada';
  return { status: 'confirmada', reserva: publica(r) };
}

function publica({ id, mesaId, ambiente, data, horario, pessoas, status, nomeCliente, contato }) {
  const o = { id, mesaId, ambiente, data, horario, pessoas, status };
  if (nomeCliente) o.nomeCliente = nomeCliente;
  if (contato) o.contato = contato;
  return o;
}

module.exports = { validarCliente, reservar, livres, disponibilidade, editarReserva, cancelarReserva, reativarReserva, publica, DURACAO_MIN };
