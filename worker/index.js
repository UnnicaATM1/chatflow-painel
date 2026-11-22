import { cabecalhosCors, criarContexto, tratar } from '../src/nucleo.js';
import { criarStoreD1 } from '../src/d1/repositorio.js';
import { criarStore } from '../src/store.js';
import painel from 'chatflow:assets';

const LIMITE_DESCARTE = 32 * 1024 * 1024;

// O ingresso pode encerrar a conexão se receber a resposta com parte do upload
// pendente. Descarte sem reter bytes, com um teto para uploads recusados.
async function descartarCorpo(stream) {
  const reader = stream.getReader();
  let tamanho = 0;
  try {
    while (tamanho < LIMITE_DESCARTE) {
      const { done, value } = await reader.read();
      if (done) return;
      tamanho += value.byteLength;
    }
    await reader.cancel();
  } catch {
    // O cliente já pode ter fechado a conexão.
  } finally {
    reader.releaseLock();
  }
}

async function lerBytes(stream, limite) {
  if (!stream) return null;

  const reader = stream.getReader();
  let tamanho = 0;
  const partes = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      tamanho += value.byteLength;
      if (tamanho > limite) {
        throw Object.assign(new Error('corpo grande demais'), { codigo: 413 });
      }
      partes.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (!tamanho) return null;
  if (partes.length === 1) return partes[0];
  const bytes = new Uint8Array(tamanho);
  let posicao = 0;
  for (const parte of partes) {
    bytes.set(parte, posicao);
    posicao += parte.byteLength;
  }
  return bytes;
}

function responder(status, headers, corpo = null) {
  const h = new Headers(headers);
  if (corpo !== null && !(corpo instanceof Uint8Array)) {
    h.set('Content-Type', 'application/json; charset=utf-8');
    corpo = new TextEncoder().encode(JSON.stringify(corpo));
  }
  if (corpo !== null) h.set('Content-Length', String(corpo.byteLength));
  return new Response(corpo, { status, headers: h });
}

export function abrirStoreWorker(env) {
  if (env.DB && env.BUCKET) return criarStoreD1(env);
  if (env.DB || env.BUCKET) throw new Error('Os bindings DB e BUCKET precisam ser configurados juntos');
  return criarStore({ fuso: env.CHATFLOW_FUSO });
}

export function criarWorker(abrirStore = abrirStoreWorker) {
  // O store em memória e os contadores duram apenas enquanto este isolate existir.
  let contexto;

  return {
    async fetch(request, env, ctx) {
      const { pathname, search } = new URL(request.url);
      const req = {
        metodo: request.method,
        url: pathname + search,
        headers: Object.fromEntries(request.headers),
        ip: request.headers.get('CF-Connecting-IP') || 'desconhecido',
        lerCorpo: (limite) => lerBytes(request.body, limite),
      };

      const corsOrigens = (env.CHATFLOW_CORS_ORIGENS || '').split(',').map((origem) => origem.trim()).filter(Boolean);
      if (req.metodo === 'GET' && (pathname === '/' || pathname === '/app' || pathname.startsWith('/app/'))) {
        const cors = cabecalhosCors({ corsOrigens: new Set(corsOrigens) }, req);
        if (pathname === '/' || pathname === '/app') return responder(301, { ...cors, Location: '/app/' + search });
        const nome = pathname === '/app/' ? 'index.html' : pathname.slice(5);
        const asset = painel.get(nome);
        if (!asset) return responder(404, cors, { erro: 'arquivo inexistente' });
        return responder(200, { ...cors, 'Content-Type': asset.tipo }, asset.bytes);
      }

      contexto ??= Promise.resolve(abrirStore(env)).then((store) => criarContexto({
        store,
        tokens: { cliente: env.CHATFLOW_TOKEN_CLIENTE, integracao: env.CHATFLOW_TOKEN_INTEGRACAO },
        permitirSemTokenEquipe: true,
        adminSenha: env.CHATFLOW_ADMIN_SENHA,
        corsOrigens,
        fuso: env.CHATFLOW_FUSO,
      })).catch((erro) => {
        contexto = undefined;
        throw erro;
      });
      const r = await tratar(req, await contexto);
      if (request.body) ctx.waitUntil(descartarCorpo(request.body));
      return responder(r.status, r.headers, r.corpo);
    },
  };
}

export default criarWorker();
