'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { lerConfig, atualizar } = require('./agentes');
const { reservar } = require('./reservas');
const { mapa } = require('./mapa');

const LIMITE_CORPO = 64 * 1024;

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

function criarServidor(store, tokens) {
  if (!tokens || !Object.values(tokens).some(Boolean)) throw new Error('nenhum token configurado');

  return http.createServer(async (req, res) => {
    try {
      const papel = autenticar(req, tokens);
      if (!papel) return responder(res, 401, { erro: 'não autenticado' });

      const url = new URL(req.url, 'http://x');
      const partes = url.pathname.split('/').filter(Boolean); // lojas/:id/<recurso>
      if (partes[0] !== 'lojas' || partes.length !== 3) return responder(res, 404, { erro: 'rota inexistente' });
      const lojaId = decodeURIComponent(partes[1]);
      const recurso = partes[2];
      const staff = papel === 'cliente' || papel === 'integracao';

      if (recurso === 'agente' && req.method === 'GET') {
        return responder(res, 200, lerConfig(store, lojaId));
      }
      if (recurso === 'agente' && req.method === 'PATCH') {
        if (!staff) return responder(res, 403, { erro: 'sem permissão' });
        const { campo, valor } = await lerCorpo(req);
        atualizar(store, lojaId, campo, valor, papel);
        return responder(res, 200, lerConfig(store, lojaId));
      }
      if (recurso === 'reservas' && req.method === 'POST') {
        const b = await lerCorpo(req);
        const chave = req.headers['idempotency-key'] || b.chave;
        if (!chave) return responder(res, 400, { erro: 'chave de idempotência obrigatória (Idempotency-Key)' });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(b.data || '') || !/^\d{2}:\d{2}$/.test(b.horario || '')) {
          return responder(res, 400, { erro: 'data (AAAA-MM-DD) e horario (HH:MM) obrigatórios' });
        }
        const r = reservar(store, { lojaId, data: b.data, horario: b.horario, pessoas: b.pessoas, ambiente: b.ambiente, chave: String(chave) });
        return responder(res, r.status === 'confirmada' ? 201 : 200, r);
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
