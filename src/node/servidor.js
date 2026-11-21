// Adaptador Node: traduz http.IncomingMessage <-> tratar() do núcleo. Fino de propósito.
// Só aqui existem node:http, node:fs e Buffer. Os arquivos do painel (web/) também só são servidos aqui:
// no Worker os assets são do Sites.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { criarContexto, tratar, cabecalhosCors } from '../nucleo.js';

const WEB_DIR = fileURLToPath(new URL('../../web', import.meta.url));
const ESTATICOS = {
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'config.js': 'text/javascript; charset=utf-8',
  'bundle.js': 'text/javascript; charset=utf-8',
  'bundle.css': 'text/css; charset=utf-8',
  'tokens.css': 'text/css; charset=utf-8',
  'logo-chatflow.png': 'image/png',
};

// Lê o corpo sob demanda (o núcleo só chama depois de autenticar), com o limite da rota. Passou do limite:
// para de guardar bytes e recusa com 413; o resto que o cliente ainda enviar é descartado (até DESCARTE_MAX, depois
// a conexão é derrubada), para o cliente conseguir ler a resposta em vez de levar um reset de conexão.
const DESCARTE_MAX = 32 * 1024 * 1024;

// Corpo que ninguém pediu (recusado antes de autenticar, rota sem corpo): não é guardado, só descartado,
// para o cliente poder ler a resposta. Acima de DESCARTE_MAX a conexão é derrubada.
function descartar(req, estado) {
  if (estado.lido) return;
  estado.lido = true;
  req.on('data', (c) => { estado.descartado += c.length; if (estado.descartado > DESCARTE_MAX) req.destroy(); });
  req.resume();
}

function lerBytes(req, limite, estado) {
  estado.lido = true;
  return new Promise((resolve, reject) => {
    let tam = 0;
    let partes = [];
    req.on('data', (c) => {
      if (estado.estourou) { estado.descartado += c.length; if (estado.descartado > DESCARTE_MAX) req.destroy(); return; }
      tam += c.length;
      if (tam > limite) { estado.estourou = true; partes = []; reject(Object.assign(new Error('corpo grande demais'), { codigo: 413 })); return; }
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
    const estado = { estourou: false, lido: false, descartado: 0 };
    const reqN = { metodo: req.method, url: req.url, headers: req.headers, ip: req.socket.remoteAddress || 'desconhecido', lerCorpo: (limite) => lerBytes(req, limite, estado) };
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
      const r = await tratar(reqN, ctx);
      descartar(req, estado);
      return escrever(res, r.status, r.headers, r.corpo);
    } catch (e) {
      descartar(req, estado);
      const codigo = e.codigo || (e instanceof Error && !e.codigo ? 400 : 500);
      return escrever(res, codigo, cabecalhosCors(ctx, reqN), { erro: e.message });
    }
  });
}
