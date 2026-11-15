// Adaptador Node: traduz http.IncomingMessage <-> tratar() do núcleo. Fino de propósito.
// Só aqui existem node:http, node:fs e Buffer. Os arquivos do painel (web/) também só são servidos aqui:
// no Worker os assets são do Sites.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { criarContexto, tratar, cabecalhosCors, LIMITE_CORPO_ARQUIVO } from '../nucleo.js';

const WEB_DIR = fileURLToPath(new URL('../../web', import.meta.url));
const ESTATICOS = {
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'config.js': 'text/javascript; charset=utf-8',
  'bundle.js': 'text/javascript; charset=utf-8',
  'bundle.css': 'text/css; charset=utf-8',
  'tokens.css': 'text/css; charset=utf-8',
  'logo.png': 'image/png',
};

// Lê o corpo inteiro (até o maior limite de rota; o núcleo aplica o limite de cada rota).
function lerBytes(req, limite) {
  return new Promise((resolve, reject) => {
    let tam = 0;
    const partes = [];
    req.on('data', (c) => {
      tam += c.length;
      if (tam > limite) { reject(Object.assign(new Error('corpo grande demais'), { codigo: 413 })); req.destroy(); return; }
      partes.push(c);
    });
    req.on('end', () => resolve(partes.length ? new Uint8Array(Buffer.concat(partes)) : null));
    req.on('error', reject);
  });
}

function escrever(res, status, headers, corpo) {
  const h = { ...headers };
  if (corpo === null || corpo === undefined) { res.writeHead(status, h); return res.end(); }
  let bytes = corpo;
  if (!(corpo instanceof Uint8Array)) {
    bytes = Buffer.from(JSON.stringify(corpo));
    h['Content-Type'] = 'application/json; charset=utf-8';
  }
  h['Content-Length'] = bytes.length;
  res.writeHead(status, h);
  return res.end(bytes);
}

// criarServidor(store, tokens, opcoes): mesmas opções de criarContexto (adminSenha, corsOrigens, confiarProxy, agora, limites).
export function criarServidor(store, tokens, opcoes = {}) {
  const ctx = criarContexto({ ...opcoes, store, tokens });
  return http.createServer(async (req, res) => {
    const reqN = { metodo: req.method, url: req.url, headers: req.headers, corpo: null, ip: req.socket.remoteAddress || 'desconhecido' };
    try {
      const caminho = req.url.split('?')[0];
      // Painel estático (sem dados sensíveis), lista fechada de arquivos. Preflight (OPTIONS) vai sempre ao núcleo.
      if (req.method === 'GET' && (caminho === '/app' || caminho.startsWith('/app/'))) {
        const cors = cabecalhosCors(ctx, reqN);
        // /app sem barra: o painel usa caminhos relativos, então redireciona para /app/ (preserva a query)
        if (caminho === '/app') return escrever(res, 301, { ...cors, Location: '/app/' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '') }, null);
        const nome = caminho === '/app/' ? 'index.html' : caminho.slice(5);
        const tipo = ESTATICOS[nome];
        if (!tipo) return escrever(res, 404, cors, { erro: 'arquivo inexistente' });
        return escrever(res, 200, { ...cors, 'Content-Type': tipo }, new Uint8Array(fs.readFileSync(path.join(WEB_DIR, nome))));
      }
      reqN.corpo = await lerBytes(req, LIMITE_CORPO_ARQUIVO);
      const r = await tratar(reqN, ctx);
      return escrever(res, r.status, r.headers, r.corpo);
    } catch (e) {
      const codigo = e.codigo || (e instanceof Error && !e.codigo ? 400 : 500);
      return escrever(res, codigo, cabecalhosCors(ctx, reqN), { erro: e.message });
    }
  });
}
