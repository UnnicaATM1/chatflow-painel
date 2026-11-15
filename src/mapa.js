'use strict';

const { empresa } = require('./agentes');
const { DURACAO_MIN } = require('./reservas');

function mapa(store, empresaId, data, horario) {
  const l = empresa(store, empresaId);
  const i = new Date(`${data}T${horario}:00`).getTime();
  return l.ambientes.map((a) => ({
    ambiente: a.nome,
    mesas: a.mesas.map((m) => {
      const r = store.reservas.find(
        (x) => x.empresaId === empresaId && x.mesaId === m.id && x.status === 'confirmada' && i < x.fim && i + DURACAO_MIN * 60000 > x.inicio
      );
      return {
        id: m.id,
        capacidade: m.capacidade,
        situacao: r ? 'reservada' : 'livre',
        reserva: r ? { horario: r.horario, pessoas: r.pessoas, status: r.status, ...(r.nomeCliente ? { nomeCliente: r.nomeCliente } : {}), ...(r.contato ? { contato: r.contato } : {}) } : null,
      };
    }),
  }));
}

module.exports = { mapa };
