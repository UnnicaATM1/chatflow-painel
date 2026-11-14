'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { lerConfig, atualizar, loja } = require('./agentes');
const { reservar, disponibilidade, editarReserva, cancelarReserva, reativarReserva, publica } = require('./reservas');
const { registrar, diff, listar } = require('./historico');
const { mapa } = require('./mapa');

const LIMITE_CORPO = 64 * 1024;
const WEB_DIR = path.join(__dirname, '..', 'web');
const ESTATICOS = {
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'bundle.js': 'text/javascript; charset=utf-8',
  'bundle.css': 'text/css; charset=utf-8',
  'tokens.css': 'text/css; charset=utf-8',
  'logo.png': 'image/png',
};

// tokens: { chat, cliente, integracao } (strings). Papéis:
//  chat: lê config e reserva | cliente/integracao: lê, vê mapa, edita (conforme permissão do campo)
function iguais(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function autenticar(req, tokens) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  for (const papel of Object.keys(tokens)) {
    if (tokens[papel] && iguais(m[1], tokens[papel])) return papel;
  }
  return null;
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let tam = 0;
    const partes = [];
    req.on('data', (c) => {
      tam += c.length;
      if (tam > LIMITE_CORPO) { reject(Object.assign(new Error('corpo grande demais'), { codigo: 413 })); req.destroy(); return; }
      partes.push(c);
    });
    req.on('end', () => {
      try { resolve(partes.length ? JSON.parse(Buffer.concat(partes).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('JSON inválido'), { codigo: 400 })); }
    });
    req.on('error', reject);
  });
}

function responder(res, codigo, corpo) {
  const json = JSON.stringify(corpo);
  res.writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}

// Quem fez: papel do token (confiável) + operador informado no cabeçalho X-Operador (rótulo, não prova de identidade).
function quem(req, papel) {
  let operador = '';
  try { operador = decodeURIComponent(req.headers['x-operador'] || ''); } catch { operador = ''; }
  return { papel, operador: operador.trim().slice(0, 60) || null };
}

// Executa a operação sobre a reserva e registra o que mudou (se mudou).
function mudarReserva(store, lid, rid, operacao, ator, extra) {
  const achar = () => store.reservas.find((x) => x.id === rid && x.lojaId === lid);
  const a0 = achar();
  const antes = a0 ? publica(a0) : null;
  const r = operacao();
  if (r.status === 'indisponivel') return r;
  const d = diff(antes, publica(achar()));
  if (Object.keys(d.depois).length) {
    const acao = (extra && extra.acao) || (d.depois.status === 'cancelada' ? 'cancelada' : d.depois.status === 'confirmada' ? 'reativada' : 'editada');
    registrar(store, { lojaId: lid, entidade: 'reserva', entidadeId: rid, ...ator, ...extra, acao, antes: d.antes, depois: d.depois });
  }
  return r;
}

function desfazer(store, lid, seq, ator) {
  loja(store, lid);
  const ev = store.historico.find((e) => e.seq === seq && e.lojaId === lid);
  if (!ev || ev.entidade !== 'reserva') throw Object.assign(new Error('evento não desfazível'), { codigo: 404 });
  if (store.historico.some((e) => e.acao === 'desfeita' && e.refSeq === seq)) throw Object.assign(new Error('este evento já foi desfeito'), { codigo: 409 });
  const atual = store.reservas.find((x) => x.id === ev.entidadeId && x.lojaId === lid);
  if (!atual) throw Object.assign(new Error('reserva inexistente'), { codigo: 404 });
  const pub = publica(atual);
  for (const k of Object.keys(ev.depois)) {
    if (JSON.stringify(pub[k]) !== JSON.stringify(ev.depois[k])) {
      throw Object.assign(new Error('há mudanças posteriores nesta reserva; desfaça na ordem inversa'), { codigo: 409 });
    }
  }
  const op = () => {
    if (ev.acao === 'criada') return cancelarReserva(store, lid, ev.entidadeId);
    if (ev.antes.status === 'cancelada') return cancelarReserva(store, lid, ev.entidadeId);
    if (ev.antes.status === 'confirmada') return reativarReserva(store, lid, ev.entidadeId);
    return editarReserva(store, lid, ev.entidadeId, { pessoas: ev.antes.pessoas, data: ev.antes.data, horario: ev.antes.horario, mesaId: ev.antes.mesaId });
  };
  return mudarReserva(store, lid, ev.entidadeId, op, ator, { acao: 'desfeita', refSeq: seq });
}

function criarServidor(store, tokens) {
  if (!tokens || !Object.values(tokens).some(Boolean)) throw new Error('nenhum token configurado');

  return http.createServer(async (req, res) => {
    try {
      // Front-end estático (sem dados sensíveis), lista fechada de arquivos
      if (req.method === 'GET' && (req.url === '/app' || req.url.startsWith('/app/'))) {
        const nome = req.url === '/app' || req.url === '/app/' ? 'index.html' : req.url.slice(5).split('?')[0];
        const tipo = ESTATICOS[nome];
        if (!tipo) return responder(res, 404, { erro: 'arquivo inexistente' });
        const corpo = fs.readFileSync(path.join(WEB_DIR, nome));
        res.writeHead(200, { 'Content-Type': tipo, 'Content-Length': corpo.length });
        return res.end(corpo);
      }
      const papel = autenticar(req, tokens);
      if (!papel) return responder(res, 401, { erro: 'não autenticado' });

      const url = new URL(req.url, 'http://x');
      const partes = url.pathname.split('/').filter(Boolean); // lojas/:id/<recurso>
      const staff = papel === 'cliente' || papel === 'integracao';

      if (partes[0] === 'lojas' && partes.length === 1 && req.method === 'GET') {
        if (!staff) return responder(res, 403, { erro: 'sem permissão' });
        return responder(res, 200, [...store.lojas.values()].map((l) => ({ id: l.id, nome: l.nome })));
      }
      // PATCH /lojas/:id/mesas/:mesaId  { capacidade?, reservavel? }
      if (partes[0] === 'lojas' && partes[2] === 'mesas' && partes.length === 4 && req.method === 'PATCH') {
        if (!staff) return responder(res, 403, { erro: 'sem permissão' });
        const l = loja(store, decodeURIComponent(partes[1]));
        const mesaId = decodeURIComponent(partes[3]);
        const mesa = l.ambientes.flatMap((a) => a.mesas).find((m) => m.id === mesaId);
        if (!mesa) return responder(res, 404, { erro: 'mesa inexistente' });
        const b = await lerCorpo(req);
        const antesMesa = { capacidade: mesa.capacidade, reservavel: mesa.reservavel };
        if (b.capacidade !== undefined) {
          if (!Number.isInteger(b.capacidade) || b.capacidade < 1 || b.capacidade > 100) return responder(res, 400, { erro: 'capacidade inválida' });
          mesa.capacidade = b.capacidade;
        }
        if (b.reservavel !== undefined) {
          if (typeof b.reservavel !== 'boolean') return responder(res, 400, { erro: 'reservavel inválido' });
          mesa.reservavel = b.reservavel;
        }
        const dm = diff(antesMesa, { capacidade: mesa.capacidade, reservavel: mesa.reservavel });
        if (Object.keys(dm.depois).length) registrar(store, { lojaId: l.id, entidade: 'mesa', entidadeId: mesaId, acao: 'editada', ...quem(req, papel), ...dm });
        return responder(res, 200, mesa);
      }
      // PATCH /lojas/:id/reservas/:rid {pessoas?,data?,horario?,mesaId?} | {status:'cancelada'|'confirmada'}; DELETE cancela
      if (partes[0] === 'lojas' && partes[2] === 'reservas' && partes.length === 4 && (req.method === 'PATCH' || req.method === 'DELETE')) {
        if (!staff) return responder(res, 403, { erro: 'sem permissão' });
        const lid = decodeURIComponent(partes[1]), rid = Number(partes[3]);
        if (!Number.isInteger(rid)) return responder(res, 404, { erro: 'reserva inexistente' });
        const ator = quem(req, papel);
        if (req.method === 'DELETE') return responder(res, 200, mudarReserva(store, lid, rid, () => cancelarReserva(store, lid, rid), ator));
        const b = await lerCorpo(req);
        const r = mudarReserva(store, lid, rid, () => (b.status === 'cancelada' ? cancelarReserva(store, lid, rid)
          : b.status === 'confirmada' ? reativarReserva(store, lid, rid)
            : editarReserva(store, lid, rid, { pessoas: b.pessoas, data: b.data, horario: b.horario, mesaId: b.mesaId })), ator);
        return responder(res, r.status === 'indisponivel' ? 409 : 200, r);
      }
      // POST /lojas/:id/historico/:seq/desfazer
      if (partes[0] === 'lojas' && partes[2] === 'historico' && partes.length === 5 && partes[4] === 'desfazer' && req.method === 'POST') {
        if (!staff) return responder(res, 403, { erro: 'sem permissão' });
        const seq = Number(partes[3]);
        if (!Number.isInteger(seq)) return responder(res, 404, { erro: 'evento inexistente' });
        const r = desfazer(store, decodeURIComponent(partes[1]), seq, quem(req, papel));
        return responder(res, r.status === 'indisponivel' ? 409 : 200, r);
      }
      if (partes[0] !== 'lojas' || partes.length !== 3) return responder(res, 404, { erro: 'rota inexistente' });
      const lojaId = decodeURIComponent(partes[1]);
      const recurso = partes[2];

      if (recurso === 'agente' && req.method === 'GET') {
        return responder(res, 200, lerConfig(store, lojaId));
      }
      if (recurso === 'agente' && req.method === 'PATCH') {
        if (!staff) return responder(res, 403, { erro: 'sem permissão' });
        const { campo, valor } = await lerCorpo(req);
        const antesCfg = lerConfig(store, lojaId)[campo];
        atualizar(store, lojaId, campo, valor, papel);
        const cfg = lerConfig(store, lojaId);
        const da = diff({ [campo]: antesCfg }, { [campo]: cfg[campo] });
        if (Object.keys(da.depois).length) registrar(store, { lojaId, entidade: 'agente', entidadeId: campo, acao: 'editada', ...quem(req, papel), ...da });
        return responder(res, 200, cfg);
      }
      if (recurso === 'reservas' && req.method === 'POST') {
        const b = await lerCorpo(req);
        const chave = req.headers['idempotency-key'] || b.chave;
        if (!chave) return responder(res, 400, { erro: 'chave de idempotência obrigatória (Idempotency-Key)' });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(b.data || '') || !/^\d{2}:\d{2}$/.test(b.horario || '')) {
          return responder(res, 400, { erro: 'data (AAAA-MM-DD) e horario (HH:MM) obrigatórios' });
        }
        const antesN = store.reservas.length;
        const r = reservar(store, { lojaId, data: b.data, horario: b.horario, pessoas: b.pessoas, ambiente: b.ambiente, mesaId: b.mesaId, chave: String(chave) });
        if (r.status === 'confirmada' && store.reservas.length > antesN) {
          registrar(store, { lojaId, entidade: 'reserva', entidadeId: r.reservaId, acao: 'criada', ...quem(req, papel), depois: publica(store.reservas[store.reservas.length - 1]) });
        }
        return responder(res, r.status === 'confirmada' ? 201 : 200, r);
      }
      // Consulta do agente antes de reservar: mesas livres por ambiente
      if (recurso === 'disponibilidade' && req.method === 'GET') {
        const data = url.searchParams.get('data'), horario = url.searchParams.get('horario');
        const pessoas = Number(url.searchParams.get('pessoas'));
        if (!/^\d{4}-\d{2}-\d{2}$/.test(data || '') || !/^\d{2}:\d{2}$/.test(horario || '') || !Number.isInteger(pessoas) || pessoas < 1) {
          return responder(res, 400, { erro: 'data (AAAA-MM-DD), horario (HH:MM) e pessoas obrigatórios' });
        }
        const ign = Number(url.searchParams.get('ignorar'));
        return responder(res, 200, disponibilidade(store, lojaId, data, horario, pessoas, Number.isInteger(ign) && ign > 0 ? ign : undefined));
      }
      if (recurso === 'reservas' && req.method === 'GET') {
        if (!staff) return responder(res, 403, { erro: 'sem permissão' });
        loja(store, lojaId);
        const data = url.searchParams.get('data');
        return responder(res, 200, store.reservas
          .filter((r) => r.lojaId === lojaId && (!data || r.data === data))
          .map(publica));
      }
      if (recurso === 'historico' && req.method === 'GET') {
        if (!staff) return responder(res, 403, { erro: 'sem permissão' });
        loja(store, lojaId);
        return responder(res, 200, listar(store, lojaId, { entidade: url.searchParams.get('entidade'), entidadeId: url.searchParams.get('id'), limite: url.searchParams.get('limite') }));
      }
      if (recurso === 'estrutura' && req.method === 'GET') {
        if (!staff) return responder(res, 403, { erro: 'sem permissão' });
        const l = loja(store, lojaId);
        return responder(res, 200, { id: l.id, nome: l.nome, ambientes: l.ambientes });
      }
      if (recurso === 'mapa' && req.method === 'GET') {
        if (!staff) return responder(res, 403, { erro: 'sem permissão' });
        const data = url.searchParams.get('data'), horario = url.searchParams.get('horario');
        if (!data || !horario) return responder(res, 400, { erro: 'data e horario obrigatórios' });
        return responder(res, 200, mapa(store, lojaId, data, horario));
      }
      return responder(res, 404, { erro: 'rota inexistente' });
    } catch (e) {
      const codigo = e.codigo || (e instanceof Error && !e.codigo ? 400 : 500);
      return responder(res, codigo, { erro: e.message });
    }
  });
}

module.exports = { criarServidor };
