import { empresa } from './agentes.js';
import { DURACAO_MIN } from './reservas.js';
import { minutosAbsolutos } from './tempo.js';

export async function mapa(store, empresaId, data, horario) {
  const l = await empresa(store, empresaId);
  const i = minutosAbsolutos(data, horario);
  const confirmadas = await store.reservaConfirmadas(empresaId);
  return l.ambientes.map((a) => ({
    ambiente: a.nome,
    mesas: a.mesas.map((m) => {
      const r = confirmadas.find((x) => x.mesaId === m.id && i < x.fim && i + DURACAO_MIN > x.inicio);
      return {
        id: m.id,
        capacidade: m.capacidade,
        ...(m.descricao ? { descricao: m.descricao } : {}),
        situacao: r ? 'reservada' : 'livre',
        reserva: r ? { horario: r.horario, pessoas: r.pessoas, status: r.status, ...(r.nomeCliente ? { nomeCliente: r.nomeCliente } : {}), ...(r.contato ? { contato: r.contato } : {}), ...(r.observacao ? { observacao: r.observacao } : {}) } : null,
      };
    }),
  }));
}
