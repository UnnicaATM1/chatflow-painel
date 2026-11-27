import { empresa } from './agentes.js';
import { minutosAbsolutos } from './tempo.js';

export const DURACAO_MIN = 90;

// A semente pode vir de uma exportação com IDs numéricos. Só carrega os dados da
// reserva: UUID e código são emitidos pelo repositório que recebe a semente.
export function prepararReservaSemeada({ mesaId, ambiente, data, horario, pessoas, status, nomeCliente, contato, observacao }, ambientes) {
  const alvo = ambientes.find((a) => (!ambiente || a.nome === ambiente) && a.mesas.some((mesa) => mesa.id === mesaId));
  if (!alvo || !Number.isInteger(pessoas) || pessoas < 1) throw new Error('reserva inválida na semente');
  if (status !== undefined && status !== 'confirmada' && status !== 'cancelada') throw new Error('status inválido na semente de reservas');
  const inicio = minutosAbsolutos(data, horario);
  return { mesaId, ambiente: alvo.nome, data, horario, pessoas, inicio, fim: inicio + DURACAO_MIN,
    ...validarCliente({ nomeCliente, contato, observacao }), status: status ?? 'confirmada' };
}

function inicio(data, horario) {
  return minutosAbsolutos(data, horario);
}

// Pura: mesas livres de `l` (registro da empresa) no horário, dadas as reservas `confirmadas` da empresa.
export function livres(l, confirmadas, data, horario, pessoas, ambiente) {
  const i = inicio(data, horario);
  const out = [];
  for (const amb of l.ambientes) {
    if (ambiente && amb.nome !== ambiente) continue;
    for (const m of amb.mesas) {
      if (!m.reservavel || m.capacidade < pessoas) continue;
      const ocupada = confirmadas.some((r) => r.mesaId === m.id && i < r.fim && i + DURACAO_MIN > r.inicio);
      if (!ocupada) out.push({ mesa: m, ambiente: amb.nome });
    }
  }
  return out;
}

// Mesas ainda livres no horário, agrupadas pelos ambientes do layout da empresa.
export async function disponibilidade(store, empresaId, data, horario, pessoas, ignorarId) {
  const l = await empresa(store, empresaId);
  if (!Number.isInteger(pessoas) || pessoas < 1) throw new Error('pessoas inválido');
  const porAmbiente = new Map(l.ambientes.map((a) => [a.nome, []]));
  const confirmadas = await store.reservaConfirmadas(empresaId, ignorarId);
  for (const x of livres(l, confirmadas, data, horario, pessoas)) {
    porAmbiente.get(x.ambiente).push({ id: x.mesa.id, capacidade: x.mesa.capacidade, ...(x.mesa.descricao ? { descricao: x.mesa.descricao } : {}) });
  }
  return {
    ambientes: [...porAmbiente].map(([ambiente, mesas]) => ({ ambiente, mesas: mesas.sort((a, b) => a.capacidade - b.capacidade) })),
  };
}

function erro(msg, codigo) { return Object.assign(new Error(msg), { codigo }); }

// Dados do cliente que o chat conhece (opcionais): nome até 80, contato (telefone ou e-mail) até 40 e observação
// da reserva até 300 caracteres. A observação vira uma linha só (o chat pode mandar quebras de linha).
export function validarCliente(d) {
  const out = {};
  for (const [campo, max] of [['nomeCliente', 80], ['contato', 40], ['observacao', 300]]) {
    if (d[campo] === undefined || d[campo] === null) continue;
    if (typeof d[campo] !== 'string') throw erro(`${campo} deve ser texto`, 400);
    const v = campo === 'observacao' ? d[campo].replace(/\s+/g, ' ').trim() : d[campo].trim();
    if ([...v].length > max) throw erro(`${campo} passa do limite de ${max} caracteres`, 400);
    out[campo] = v;
  }
  return out;
}

// Como `reservar`, mas devolve também a reserva criada ({ resposta, criada }): `criada` é null quando a chave de
// idempotência repetiu uma resposta anterior ou não havia mesa. Usado pelo núcleo para registrar o histórico.
export async function reservarDetalhado(store, { empresaId, data, horario, pessoas, ambiente, mesaId, chave, nomeCliente, contato, observacao }) {
  const l = await empresa(store, empresaId);
  if (!Number.isInteger(pessoas) || pessoas < 1) throw new Error('pessoas inválido');
  const cliente = validarCliente({ nomeCliente, contato, observacao });

  if (chave) {
    const antiga = await store.idempotenciaObter(empresaId, chave);
    if (antiga) return { resposta: antiga, criada: null };
  }

  const confirmadas = await store.reservaConfirmadas(empresaId);
  let ok = livres(l, confirmadas, data, horario, pessoas, ambiente);
  if (mesaId) ok = ok.filter((x) => x.mesa.id === mesaId);
  if (ok.length) {
    ok.sort((a, b) => a.mesa.capacidade - b.mesa.capacidade);
    const ini = inicio(data, horario);
    const r = await store.reservaCriar({
      empresaId, chave,
      candidatas: ok.map((x) => ({ mesaId: x.mesa.id, ambiente: x.ambiente })),
      reserva: { data, horario, pessoas, inicio: ini, fim: ini + DURACAO_MIN, ...cliente },
    });
    if (r.resposta) return { resposta: r.resposta, criada: r.criada ? r.reserva : null };
    // conflito: a mesa foi tomada entre a leitura e a gravação; cai na resposta "indisponivel" com a situação atual
  }
  const alt = new Map();
  if (ambiente) {
    for (const x of livres(l, await store.reservaConfirmadas(empresaId), data, horario, pessoas)) {
      alt.set(x.ambiente, { tipo: 'outro-ambiente', ambiente: x.ambiente });
    }
  }
  const res = { status: 'indisponivel', alternativas: [...alt.values()], disponibilidade: (await disponibilidade(store, empresaId, data, horario, pessoas)).ambientes };
  if (chave) await store.idempotenciaGravar(empresaId, chave, res);
  return { resposta: res, criada: null };
}

export async function reservar(store, dados) {
  return (await reservarDetalhado(store, dados)).resposta;
}

async function achar(store, empresaId, id) {
  await empresa(store, empresaId);
  const r = await store.reservaObter(empresaId, id);
  if (!r) throw erro('reserva inexistente', 404);
  return r;
}

async function indisponivel(store, empresaId, data, horario, pessoas, ignorarId) {
  return { status: 'indisponivel', disponibilidade: (await disponibilidade(store, empresaId, data, horario, pessoas, ignorarId)).ambientes };
}

// Edita pessoas, data, horário e/ou mesa. Sem mesaId, mantém a mesa atual se ainda servir.
export async function editarReserva(store, empresaId, id, mudancas) {
  const l = await empresa(store, empresaId);
  const r = await achar(store, empresaId, id);
  if (r.status !== 'confirmada') throw erro('reserva cancelada; reative antes de editar', 409);
  const pessoas = mudancas.pessoas !== undefined ? mudancas.pessoas : r.pessoas;
  const data = mudancas.data || r.data;
  const horario = mudancas.horario || r.horario;
  const mesaId = mudancas.mesaId || r.mesaId;
  if (!Number.isInteger(pessoas) || pessoas < 1) throw erro('pessoas inválido', 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !/^\d{2}:\d{2}$/.test(horario)) throw erro('data ou horário inválido', 400);
  const alvo = livres(l, await store.reservaConfirmadas(empresaId, r.id), data, horario, pessoas).find((x) => x.mesa.id === mesaId);
  if (!alvo) return indisponivel(store, empresaId, data, horario, pessoas, r.id);
  const ini = inicio(data, horario);
  const cliente = validarCliente(mudancas);
  const res = await store.reservaEditar({
    empresaId, id: r.id, cliente,
    dados: { pessoas, data, horario, mesaId, ambiente: alvo.ambiente, inicio: ini, fim: ini + DURACAO_MIN },
  });
  if (!res.ok) return indisponivel(store, empresaId, data, horario, pessoas, r.id);
  return { status: 'atualizada', reserva: publica(res.reserva) };
}

export async function cancelarReserva(store, empresaId, id) {
  await achar(store, empresaId, id);
  const r = await store.reservaCancelar(empresaId, id);
  if (!r) throw erro('reserva inexistente', 404);
  return { status: 'cancelada', reserva: publica(r) };
}

export async function reativarReserva(store, empresaId, id) {
  const l = await empresa(store, empresaId);
  const r = await achar(store, empresaId, id);
  if (r.status === 'confirmada') return { status: 'confirmada', reserva: publica(r) };
  const ok = livres(l, await store.reservaConfirmadas(empresaId, r.id), r.data, r.horario, r.pessoas).some((x) => x.mesa.id === r.mesaId);
  const res = ok ? await store.reservaReativar(empresaId, id) : { ok: false };
  if (!res.ok) return indisponivel(store, empresaId, r.data, r.horario, r.pessoas, r.id);
  return { status: 'confirmada', reserva: publica(res.reserva) };
}

export function publica({ id, mesaId, ambiente, data, horario, pessoas, status, nomeCliente, contato, observacao }) {
  const o = { id, mesaId, ambiente, data, horario, pessoas, status };
  if (nomeCliente) o.nomeCliente = nomeCliente;
  if (contato) o.contato = contato;
  if (observacao) o.observacao = observacao;
  return o;
}
