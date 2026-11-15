'use strict';

import { empresa } from './agentes.js';
import { DURACAO_MIN } from './reservas.js';
import { minutosAbsolutos } from './tempo.js';

function mapa(store, empresaId, data, horario) {
  const l = empresa(store, empresaId);
  const i = minutosAbsolutos(data, horario);
  return l.ambientes.map((a) => ({
    ambiente: a.nome,
    mesas: a.mesas.map((m) => {
      const r = store.reservas.find(
        (x) => x.empresaId === empresaId && x.mesaId === m.id && x.status === 'confirmada' && i < x.fim && i + DURACAO_MIN > x.inicio
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

export { mapa };
