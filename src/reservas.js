'use strict';

const { loja } = require('./agentes');

const DURACAO_MIN = 90;
const DURACAO_MS = DURACAO_MIN * 60000;

function inicio(data, horario) {
  return new Date(`${data}T${horario}:00`).getTime();
}

function livres(store, l, data, horario, pessoas, ambiente) {
  const i = inicio(data, horario);
  const out = [];
  for (const amb of l.ambientes) {
    if (ambiente && amb.nome !== ambiente) continue;
    for (const m of amb.mesas) {
      if (!m.reservavel || m.capacidade < pessoas) continue;
      const ocupada = store.reservas.some(
        (r) => r.lojaId === l.id && r.mesaId === m.id && r.status === 'confirmada' && i < r.fim && i + DURACAO_MS > r.inicio
      );
      if (!ocupada) out.push({ mesa: m, ambiente: amb.nome });
    }
  }
  return out;
}

function reservar(store, { lojaId, data, horario, pessoas, ambiente, chave }) {
  const l = loja(store, lojaId);
  if (!Number.isInteger(pessoas) || pessoas < 1) throw new Error('pessoas inválido');

  const k = `${lojaId}:${chave}`;
  if (chave && store.chaves.has(k)) return store.chaves.get(k);

  const ok = livres(store, l, data, horario, pessoas, ambiente);
  let res;
  if (ok.length) {
    ok.sort((a, b) => a.mesa.capacidade - b.mesa.capacidade);
    const { mesa, ambiente: amb } = ok[0];
    const ini = inicio(data, horario);
    const r = {
      id: store.reservas.length + 1, lojaId, mesaId: mesa.id, ambiente: amb,
      data, horario, pessoas, inicio: ini, fim: ini + DURACAO_MS, status: 'confirmada',
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
    res = { status: 'indisponivel', alternativas: [...alt.values()] };
  }
  if (chave) store.chaves.set(k, res);
  return res;
}

module.exports = { reservar, livres, DURACAO_MIN };
