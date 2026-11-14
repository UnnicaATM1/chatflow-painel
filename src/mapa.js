'use strict';

const { loja } = require('./agentes');
const { DURACAO_MIN } = require('./reservas');

function mapa(store, lojaId, data, horario) {
  const l = loja(store, lojaId);
  const i = new Date(`${data}T${horario}:00`).getTime();
  return l.ambientes.map((a) => ({
    ambiente: a.nome,
    mesas: a.mesas.map((m) => {
      const r = store.reservas.find(
        (x) => x.lojaId === lojaId && x.mesaId === m.id && x.status === 'confirmada' && i < x.fim && i + DURACAO_MIN * 60000 > x.inicio
      );
      return {
        id: m.id,
        capacidade: m.capacidade,
        situacao: r ? 'reservada' : 'livre',
        reserva: r ? { horario: r.horario, pessoas: r.pessoas, status: r.status } : null,
      };
    }),
  }));
}

module.exports = { mapa };
