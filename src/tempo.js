// Datas e horários sem fuso: tudo é "relógio de parede" da empresa, convertido para minutos absolutos
// (minutos desde 1970-01-01 00:00 do relógio local, sem horário de verão). Assim 23:30 do dia D
// e 00:30 do dia D+1 ficam a 60 minutos um do outro, em qualquer ambiente (Node, Worker, fuso do servidor).
// Usa só aritmética e Date.UTC (que não depende do fuso do ambiente).

function erro(msg, codigo) {
  return Object.assign(new Error(msg), { codigo });
}

// 'AAAA-MM-DD' + 'HH:MM' -> minutos absolutos. Datas impossíveis (2026-02-30) e horas fora de 00:00 a 23:59 dão 400.
export function minutosAbsolutos(data, horario) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data || '');
  const h = /^(\d{2}):(\d{2})$/.exec(horario || '');
  if (!d || !h) throw erro('data ou horário inválido', 400);
  const [ano, mes, dia] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const [hh, mm] = [Number(h[1]), Number(h[2])];
  const ms = Date.UTC(ano, mes - 1, dia);
  const volta = new Date(ms);
  if (volta.getUTCFullYear() !== ano || volta.getUTCMonth() !== mes - 1 || volta.getUTCDate() !== dia || hh > 23 || mm > 59) {
    throw erro('data ou horário inválido', 400);
  }
  return ms / 60000 + hh * 60 + mm;
}

// Fuso de negócio (KENDJI_FUSO, padrão America/Sao_Paulo). Hoje nenhuma regra compara reservas com "agora",
// então o fuso só é carregado e exposto; fica aqui para a primeira regra que precisar (ex.: bloquear reserva no passado).
export const FUSO_PADRAO = 'America/Sao_Paulo';
export function fusoDe(valor) {
  const f = typeof valor === 'string' && valor.trim() ? valor.trim() : FUSO_PADRAO;
  try { new Intl.DateTimeFormat('pt-BR', { timeZone: f }); return f; } catch { return FUSO_PADRAO; }
}

// Data/hora de parede no fuso de negócio para um instante (ms). Devolve { data: 'AAAA-MM-DD', horario: 'HH:MM' }.
export function parede(instanteMs, fuso) {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: fusoDe(fuso), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(instanteMs)).map((p) => [p.type, p.value]),
  );
  return { data: `${partes.year}-${partes.month}-${partes.day}`, horario: `${partes.hour}:${partes.minute}` };
}
