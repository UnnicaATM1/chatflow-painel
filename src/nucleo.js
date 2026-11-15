// Núcleo da API: uma função de requisição para resposta, sem Node.
//
//   tratar(req, ctx) -> { status, headers, corpo }
//   req = { metodo, url (caminho + query), headers (chaves em minúsculas), corpo: Uint8Array|null, ip }
//   corpo da resposta: objeto/array (o adaptador serializa como JSON), Uint8Array (binário) ou null.
//
// Nada de node:*, Buffer, process ou require aqui: o que depende do ambiente vem em ctx.plat (src/plataforma.js).
// Adaptadores: src/node/servidor.js (http do Node) e, no futuro, um `fetch` de Worker.
import { lerConfig, atualizarVarios, empresa } from './agentes.js';
import { reservar, disponibilidade, editarReserva, cancelarReserva, reativarReserva, publica } from './reservas.js';
import { registrar, diff, listar } from './historico.js';
import { addEmpresa } from './store.js';
import { mapa } from './mapa.js';
import * as conhecimento from './conhecimento.js';
import { contexto, recursosDe } from './contexto.js';
import { fusoDe } from './tempo.js';

export const LIMITE_CORPO = 512 * 1024; // 5 campos de texto somam até ~49 mil caracteres
export const LIMITE_CORPO_ARQUIVO = 6 * 1024 * 1024; // documento de até 4 MB em base64

// O corpo (bytes) já veio inteiro do adaptador; aqui só se aplica o limite da rota e se lê o JSON.
function lerCorpo(req, limite = LIMITE_CORPO) {
  const c = req.corpo;
  if (c && c.length > limite) throw Object.assign(new Error('corpo grande demais'), { codigo: 413 });
  if (!c || !c.length) return {};
  try { return JSON.parse(new TextDecoder('utf-8', { ignoreBOM: true }).decode(c)); }
  catch { throw Object.assign(new Error('JSON inválido'), { codigo: 400 }); }
}

// tokens: { chat, cliente, integracao } (strings). Papéis:
//  chat: lê config e reserva | cliente/integracao: lê, vê mapa, edita (conforme permissão do campo)
// Devolve { papel, empresaEscopo? } ou null. Chave de API de empresa vale só para aquela empresa e só com poderes do chat.
async function autenticar(req, ctx) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const { plat, tokens, store } = ctx;
  for (const papel of Object.keys(tokens)) {
    if (tokens[papel] && plat.iguaisTempoConstante(m[1], tokens[papel])) return { papel };
  }
  const h = await plat.sha256Hex(m[1]);
  for (const l of store.empresas.values()) {
    if (l.chave && plat.iguaisTempoConstante(h, l.chave.hash)) return { papel: 'chat', empresaEscopo: l.id };
  }
  return null;
}

// Quem fez: papel do token (confiável) + operador informado no cabeçalho X-Operador (rótulo, não prova de identidade).
function quem(req, papel) {
  let operador = '';
  try { operador = decodeURIComponent(req.headers['x-operador'] || ''); } catch { operador = ''; }
  return { papel, operador: operador.trim().slice(0, 60) || null };
}

// Executa a operação sobre a reserva e registra o que mudou (se mudou).
function mudarReserva(store, lid, rid, operacao, ator, extra) {
  const achar = () => store.reservas.find((x) => x.id === rid && x.empresaId === lid);
  const a0 = achar();
  const antes = a0 ? publica(a0) : null;
  const r = operacao();
  if (r.status === 'indisponivel') return r;
  const d = diff(antes, publica(achar()));
  if (Object.keys(d.depois).length) {
    const acao = (extra && extra.acao) || (d.depois.status === 'cancelada' ? 'cancelada' : d.depois.status === 'confirmada' ? 'reativada' : 'editada');
    registrar(store, { empresaId: lid, entidade: 'reserva', entidadeId: rid, ...ator, ...extra, acao, antes: d.antes, depois: d.depois });
  }
  return r;
}

function desfazer(store, lid, seq, ator) {
  empresa(store, lid);
  const ev = store.historico.find((e) => e.seq === seq && e.empresaId === lid);
  if (!ev || ev.entidade !== 'reserva') throw Object.assign(new Error('evento não desfazível'), { codigo: 404 });
  if (store.historico.some((e) => e.acao === 'desfeita' && e.refSeq === seq)) throw Object.assign(new Error('este evento já foi desfeito'), { codigo: 409 });
  const atual = store.reservas.find((x) => x.id === ev.entidadeId && x.empresaId === lid);
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

const PERMISSAO_PADRAO = ['nome', 'descricao', 'personalidade', 'habilidades', 'produtos', 'restricoes'];

// Valida o nome de uma empresa: 1 a 60 caracteres e único entre as empresas.
function validarNome(store, bruto, ignorarId) {
  const nome = typeof bruto === 'string' ? bruto.trim() : '';
  if (!nome || [...nome].length > 60) return { erro: 'nome da empresa deve ter de 1 a 60 caracteres', codigo: 400 };
  if ([...store.empresas.values()].some((x) => x.id !== ignorarId && x.nome.toLowerCase() === nome.toLowerCase())) {
    return { erro: 'já existe outra empresa com esse nome', codigo: 409 };
  }
  return { nome };
}

const MODULOS = ['reservas', 'conhecimento'];
const RECURSOS_RESERVAS = ['reservas', 'disponibilidade', 'mapa', 'ambientes', 'mesas'];

// true se a empresa usa o recurso (ou se ela nem existe: o handler seguinte responde 404)
function moduloLigado(store, id, nome) {
  const e = store.empresas.get(id);
  return !e || e.modulos[nome] !== false;
}

// Lê e valida { reservas?: boolean, conhecimento?: boolean }
function validarModulos(b) {
  const out = {};
  if (b === undefined) return { modulos: out };
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { erro: 'modulos inválido' };
  for (const k of Object.keys(b)) {
    if (!MODULOS.includes(k)) return { erro: `módulo desconhecido: ${k}` };
    if (typeof b[k] !== 'boolean') return { erro: `módulo ${k} deve ser verdadeiro ou falso` };
    out[k] = b[k];
  }
  return { modulos: out };
}

// Limite de requisições em memória (janela fixa de 1 minuto).
const JANELA_MS = 60 * 1000;
function criarLimitador(maximo) {
  const baldes = new Map(); // chave -> { inicio, n }
  return {
    // Conta uma requisição; devolve { ok, retryAfter } (retryAfter em segundos quando bloqueada)
    contar(chave, agora) {
      if (baldes.size > 10000) for (const [k, b] of baldes) if (agora - b.inicio >= JANELA_MS) baldes.delete(k);
      let b = baldes.get(chave);
      if (!b || agora - b.inicio >= JANELA_MS) { b = { inicio: agora, n: 0 }; baldes.set(chave, b); }
      b.n++;
      return b.n <= maximo ? { ok: true } : { ok: false, retryAfter: Math.max(1, Math.ceil((b.inicio + JANELA_MS - agora) / 1000)) };
    },
  };
}

// IP do cliente. Atrás de proxy confiável (KENDJI_CONFIAR_PROXY=1) usa o último valor de X-Forwarded-For (o que o proxy acrescentou).
function ipDe(req, confiarProxy) {
  if (confiarProxy) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.ip || 'desconhecido';
}

const CORS_METODOS = 'GET, POST, PATCH, DELETE, OPTIONS';
const CORS_CABECALHOS = 'Authorization, Content-Type, Idempotency-Key, X-Operador';


// Monta o contexto do núcleo. opcoes: { store, tokens, adminSenha, corsOrigens: [], confiarProxy, agora, fuso,
// limiteInvalidasPorMinuto, limitePorChavePorMinuto, plat }. As contagens de limite ficam na memória do contexto.
export function criarContexto(opcoes = {}) {
  const { store, tokens } = opcoes;
  if (!tokens || !Object.values(tokens).some(Boolean)) throw new Error('nenhum token configurado');
  const plat = opcoes.plat || store.plat;
  return {
    store, plat, tokens,
    adminSenha: opcoes.adminSenha || null, // KENDJI_ADMIN_SENHA: sem ela, excluir empresa fica desativado
    corsOrigens: new Set((opcoes.corsOrigens || []).map((o) => String(o).trim()).filter(Boolean)), // lista exata (KENDJI_CORS_ORIGENS)
    confiarProxy: opcoes.confiarProxy === true, // KENDJI_CONFIAR_PROXY=1: usar X-Forwarded-For
    fuso: fusoDe(opcoes.fuso), // KENDJI_FUSO (padrão America/Sao_Paulo); nenhuma regra compara reservas com "agora" ainda
    agora: opcoes.agora || (() => plat.agora()),
    limiteInvalidas: criarLimitador(opcoes.limiteInvalidasPorMinuto || 20), // por IP, chave inválida ou ausente
    limiteValidas: criarLimitador(opcoes.limitePorChavePorMinuto || 300), // por chave válida
  };
}

// CORS: só com a origem na lista exata; nunca "*" nem credenciais. Sem lista, nenhum cabeçalho.
// O adaptador reaproveita isto nas respostas estáticas.
export function cabecalhosCors(ctx, req) {
  const h = {};
  if (!ctx.corsOrigens.size) return h;
  h.Vary = 'Origin';
  const origem = req.headers.origin;
  if (origem && ctx.corsOrigens.has(origem)) {
    h['Access-Control-Allow-Origin'] = origem;
    if (req.metodo === 'OPTIONS') {
      h['Access-Control-Allow-Methods'] = CORS_METODOS;
      h['Access-Control-Allow-Headers'] = CORS_CABECALHOS;
      h['Access-Control-Max-Age'] = '600';
    }
  }
  return h;
}

export async function tratar(req, ctx) {
  const { store, plat, adminSenha } = ctx;
  const cors = cabecalhosCors(ctx, req);
  const resp = (status, corpo, headers) => ({ status, headers: { ...cors, ...(headers || {}) }, corpo: corpo === undefined ? null : corpo });
  const hashChave = (c) => plat.sha256Hex(c);
  try {
    // Preflight: sempre 204 (sem cabeçalhos CORS quando a origem não é permitida ou a variável não existe)
    if (req.metodo === 'OPTIONS') return resp(204, null);
    // GET /saude: sem autenticação, só { ok: true }
    if (req.metodo === 'GET' && req.url.split('?')[0] === '/saude') return resp(200, { ok: true });
    const auth = await autenticar(req, ctx);
    const limite = auth
      ? ctx.limiteValidas.contar(await hashChave(req.headers.authorization), ctx.agora())
      : ctx.limiteInvalidas.contar(ipDe(req, ctx.confiarProxy), ctx.agora());
    if (!limite.ok) return resp(429, { erro: 'muitas requisições; tente novamente em instantes' }, { 'Retry-After': String(limite.retryAfter) });
    if (!auth) return resp(401, { erro: 'não autenticado' });
    const papel = auth.papel;

    const url = new URL(req.url, 'http://x');
    const partes = url.pathname.split('/').filter(Boolean); // empresas/:id/<recurso>
    const staff = papel === 'cliente' || papel === 'integracao';
    // chave de API de uma empresa só alcança as rotas dessa empresa
    if (auth.empresaEscopo && !(partes[0] === 'empresas' && partes[1] && decodeURIComponent(partes[1]) === auth.empresaEscopo)) {
      return resp(403, { erro: 'esta chave só acessa a própria empresa' });
    }

    // GET /historico/excluidas: resumo das empresas excluídas (o instantâneo completo fica gravado no histórico)
    if (partes[0] === 'historico' && partes[1] === 'excluidas' && partes.length === 2 && req.metodo === 'GET') {
      if (!staff) return resp(403, { erro: 'sem permissão' });
      return resp(200, store.historico.filter((e) => e.acao === 'excluida' && e.entidade === 'empresa').reverse().map((e) => ({
        seq: e.seq, quando: e.quando, papel: e.papel, operador: e.operador, empresaId: e.empresaId, nome: e.antes.nome,
        reservas: e.antes.reservas.length, ambientes: e.antes.ambientes.length, mesas: e.antes.ambientes.reduce((n, a) => n + a.mesas.length, 0),
      })));
    }
    // POST /empresas { nome }  (adicionar empresa: nasce com agente vazio, sem ambientes e sem chave de API)
    if (partes[0] === 'empresas' && partes.length === 1 && req.metodo === 'POST') {
      if (!staff) return resp(403, { erro: 'sem permissão' });
      const b = lerCorpo(req);
      const v = validarNome(store, b.nome);
      if (v.erro) return resp(v.codigo, { erro: v.erro });
      const vm = validarModulos(b.modulos);
      if (vm.erro) return resp(400, { erro: vm.erro });
      let n = store.empresas.size + 1;
      while (store.empresas.has(`empresa_${n}`) || store.historico.some((e) => e.empresaId === `empresa_${n}`)) n++;
      const id = `empresa_${n}`;
      addEmpresa(store, {
        id, nome: v.nome, ambientes: [], modulos: vm.modulos,
        agente: { nome: '', descricao: '', personalidade: '', habilidades: '', produtos: '', restricoes: '', editavelPor: Object.fromEntries(PERMISSAO_PADRAO.map((c) => [c, ['cliente', 'integracao']])) },
      });
      registrar(store, { empresaId: id, entidade: 'empresa', entidadeId: id, acao: 'criada', ...quem(req, papel), depois: { nome: v.nome } });
      return resp(201, { id, nome: v.nome, modulos: store.empresas.get(id).modulos });
    }
    // Chave de API da empresa (só equipe de integração). A chave aparece uma única vez, ao gerar; só o hash fica guardado.
    if (partes[0] === 'empresas' && partes[2] === 'api' && (partes.length === 3 || (partes.length === 4 && partes[3] === 'chave'))) {
      if (papel !== 'integracao') return resp(403, { erro: 'somente a equipe de integração gerencia a chave de API' });
      const l = empresa(store, decodeURIComponent(partes[1]));
      if (partes.length === 3 && req.metodo === 'GET') {
        return resp(200, { ativa: !!l.chave, prefixo: l.chave ? l.chave.prefixo : null, criadaEm: l.chave ? l.chave.criadaEm : null });
      }
      if (partes.length === 4 && req.metodo === 'POST') {
        const chave = 'k1_' + plat.aleatorio(32);
        const antes = l.chave ? { prefixo: l.chave.prefixo } : {};
        l.chave = { hash: await hashChave(chave), prefixo: chave.slice(0, 11), criadaEm: new Date(plat.agora()).toISOString() };
        registrar(store, { empresaId: l.id, entidade: 'api', entidadeId: 'chave', acao: 'chave_gerada', ...quem(req, papel), antes, depois: { prefixo: l.chave.prefixo } });
        return resp(201, { chave, prefixo: l.chave.prefixo, criadaEm: l.chave.criadaEm });
      }
      if (partes.length === 4 && req.metodo === 'DELETE') {
        if (l.chave) registrar(store, { empresaId: l.id, entidade: 'api', entidadeId: 'chave', acao: 'chave_revogada', ...quem(req, papel), antes: { prefixo: l.chave.prefixo }, depois: {} });
        l.chave = null;
        return resp(200, { ativa: false });
      }
    }

    if (partes[0] === 'empresas' && partes.length === 1 && req.metodo === 'GET') {
      if (!staff) return resp(403, { erro: 'sem permissão' });
      return resp(200, [...store.empresas.values()].map((l) => ({ id: l.id, nome: l.nome, modulos: { ...l.modulos } })));
    }
    // PATCH /empresas/:id  { nome }  (renomear a empresa)
    if (partes[0] === 'empresas' && partes.length === 2 && req.metodo === 'PATCH') {
      if (!staff) return resp(403, { erro: 'sem permissão' });
      const l = empresa(store, decodeURIComponent(partes[1]));
      const b = lerCorpo(req);
      const v = validarNome(store, b.nome, l.id);
      if (v.erro) return resp(v.codigo, { erro: v.erro });
      const nome = v.nome;
      const antes = l.nome;
      l.nome = nome;
      const dl = diff({ nome: antes }, { nome });
      if (Object.keys(dl.depois).length) registrar(store, { empresaId: l.id, entidade: 'empresa', entidadeId: l.id, acao: 'editada', ...quem(req, papel), ...dl });
      return resp(200, { id: l.id, nome: l.nome, modulos: { ...l.modulos } });
    }
    // PATCH /empresas/:id/mesas/:mesaId  { capacidade?, reservavel? }
    if (partes[0] === 'empresas' && partes[2] === 'mesas' && partes.length === 4 && req.metodo === 'PATCH') {
      if (!staff) return resp(403, { erro: 'sem permissão' });
      const l = empresa(store, decodeURIComponent(partes[1]));
      if (!moduloLigado(store, l.id, 'reservas')) return resp(404, { erro: 'recurso "reservas" não habilitado para esta empresa' });
      const mesaId = decodeURIComponent(partes[3]);
      const mesa = l.ambientes.flatMap((a) => a.mesas).find((m) => m.id === mesaId);
      if (!mesa) return resp(404, { erro: 'mesa inexistente' });
      const b = lerCorpo(req);
      const antesMesa = { capacidade: mesa.capacidade, reservavel: mesa.reservavel };
      if (b.capacidade !== undefined) {
        if (!Number.isInteger(b.capacidade) || b.capacidade < 1 || b.capacidade > 100) return resp(400, { erro: 'capacidade inválida' });
        mesa.capacidade = b.capacidade;
      }
      if (b.reservavel !== undefined) {
        if (typeof b.reservavel !== 'boolean') return resp(400, { erro: 'reservavel inválido' });
        mesa.reservavel = b.reservavel;
      }
      const dm = diff(antesMesa, { capacidade: mesa.capacidade, reservavel: mesa.reservavel });
      if (Object.keys(dm.depois).length) registrar(store, { empresaId: l.id, entidade: 'mesa', entidadeId: mesaId, acao: 'editada', ...quem(req, papel), ...dm });
      return resp(200, mesa);
    }
    // PATCH /empresas/:id/reservas/:rid {pessoas?,data?,horario?,mesaId?} | {status:'cancelada'|'confirmada'}; DELETE cancela
    if (partes[0] === 'empresas' && partes[2] === 'reservas' && partes.length === 4 && (req.metodo === 'PATCH' || req.metodo === 'DELETE')) {
      if (!staff) return resp(403, { erro: 'sem permissão' });
      const lid = decodeURIComponent(partes[1]), rid = Number(partes[3]);
      if (!moduloLigado(store, lid, 'reservas')) return resp(404, { erro: 'recurso "reservas" não habilitado para esta empresa' });
      if (!Number.isInteger(rid)) return resp(404, { erro: 'reserva inexistente' });
      const ator = quem(req, papel);
      if (req.metodo === 'DELETE') return resp(200, mudarReserva(store, lid, rid, () => cancelarReserva(store, lid, rid), ator));
      const b = lerCorpo(req);
      const r = mudarReserva(store, lid, rid, () => (b.status === 'cancelada' ? cancelarReserva(store, lid, rid)
        : b.status === 'confirmada' ? reativarReserva(store, lid, rid)
          : editarReserva(store, lid, rid, { pessoas: b.pessoas, data: b.data, horario: b.horario, mesaId: b.mesaId, nomeCliente: b.nomeCliente, contato: b.contato })), ator);
      return resp(r.status === 'indisponivel' ? 409 : 200, r);
    }
    // POST /empresas/:id/historico/:seq/desfazer
    if (partes[0] === 'empresas' && partes[2] === 'historico' && partes.length === 5 && partes[4] === 'desfazer' && req.metodo === 'POST') {
      if (!staff) return resp(403, { erro: 'sem permissão' });
      const seq = Number(partes[3]);
      if (!Number.isInteger(seq)) return resp(404, { erro: 'evento inexistente' });
      const r = desfazer(store, decodeURIComponent(partes[1]), seq, quem(req, papel));
      return resp(r.status === 'indisponivel' ? 409 : 200, r);
    }
    // Base de conhecimento: GET (chat e equipe) lê; POST/PATCH/DELETE (equipe) editam.
    //  /empresas/:id/conhecimento | /conhecimento/:itemId | /conhecimento/:itemId/arquivo
    if (partes[0] === 'empresas' && partes[2] === 'conhecimento' && partes.length >= 3 && partes.length <= 5) {
      const eid = decodeURIComponent(partes[1]);
      const e = empresa(store, eid);
      if (e.modulos.conhecimento === false) return resp(404, { erro: 'recurso "conhecimento" não habilitado para esta empresa' });
      const ator = quem(req, papel);
      if (partes.length === 3 && req.metodo === 'GET') return resp(200, { itens: conhecimento.listarPublico(store, eid) });
      if (partes.length === 3 && req.metodo === 'POST') {
        if (!staff) return resp(403, { erro: 'sem permissão' });
        const item = conhecimento.criar(store, eid, lerCorpo(req, LIMITE_CORPO_ARQUIVO));
        registrar(store, { empresaId: eid, entidade: 'conhecimento', entidadeId: item.id, acao: 'criada', ...ator, depois: conhecimento.resumo(item) });
        return resp(201, conhecimento.publica(eid, item));
      }
      if (partes.length === 4 && partes[3] === 'buscar' && req.metodo === 'GET') {
        return resp(200, conhecimento.buscar(store, eid, url.searchParams.get('q'), url.searchParams.get('limite')));
      }
      const itemId = Number(partes[3]);
      if (!Number.isInteger(itemId)) return resp(404, { erro: 'item de conhecimento inexistente' });
      if (partes.length === 4 && req.metodo === 'GET') return resp(200, conhecimento.obter(store, eid, itemId));
      if (partes.length === 4 && req.metodo === 'PATCH') {
        if (!staff) return resp(403, { erro: 'sem permissão' });
        const antes = conhecimento.resumo(conhecimento.achar(store, eid, itemId).item);
        const item = conhecimento.editar(store, eid, itemId, lerCorpo(req, LIMITE_CORPO_ARQUIVO));
        const d = diff(antes, conhecimento.resumo(item));
        if (Object.keys(d.depois).length) registrar(store, { empresaId: eid, entidade: 'conhecimento', entidadeId: itemId, acao: 'editada', ...ator, ...d });
        return resp(200, conhecimento.publica(eid, item));
      }
      if (partes.length === 4 && req.metodo === 'DELETE') {
        if (!staff) return resp(403, { erro: 'sem permissão' });
        const item = conhecimento.excluir(store, eid, itemId);
        registrar(store, { empresaId: eid, entidade: 'conhecimento', entidadeId: itemId, acao: 'excluida', ...ator, antes: conhecimento.resumo(item), depois: {} });
        return resp(200, { excluido: true, id: itemId });
      }
      if (partes.length === 5 && partes[4] === 'arquivo' && req.metodo === 'GET') {
        const a = conhecimento.arquivoDe(store, eid, itemId);
        return { status: 200, headers: {
        'Content-Type': a.mime,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.nome)}`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': 'sandbox',
      }, corpo: a.buffer };
      }
    }
    if (partes[0] !== 'empresas' || partes.length !== 3) return resp(404, { erro: 'rota inexistente' });
    const empresaId = decodeURIComponent(partes[1]);
    const recurso = partes[2];
    if (RECURSOS_RESERVAS.includes(recurso) && !moduloLigado(store, empresaId, 'reservas')) {
      return resp(404, { erro: 'recurso "reservas" não habilitado para esta empresa' });
    }

    // GET /empresas/:id/recursos: o que esta empresa usa e quais endereços o sistema de conversa pode chamar
    if (recurso === 'recursos' && req.metodo === 'GET') {
      return resp(200, recursosDe(empresa(store, empresaId)));
    }
    // GET /empresas/:id/contexto: tudo o que o agente precisa em uma chamada (config, conhecimento, recursos e prompt pronto)
    if (recurso === 'contexto' && req.metodo === 'GET') {
      return resp(200, contexto(store, empresaId));
    }
    // PATCH /empresas/:id/modulos { reservas?, conhecimento? }: liga ou desliga recursos (os dados são mantidos)
    if (recurso === 'modulos' && req.metodo === 'PATCH') {
      if (!staff) return resp(403, { erro: 'sem permissão' });
      const e = empresa(store, empresaId);
      const vm = validarModulos(lerCorpo(req));
      if (vm.erro) return resp(400, { erro: vm.erro });
      if (Object.keys(vm.modulos).length === 0) return resp(400, { erro: 'nenhum módulo informado' });
      const antes = Object.fromEntries(MODULOS.map((m) => [`modulo_${m}`, e.modulos[m]]));
      Object.assign(e.modulos, vm.modulos);
      const d = diff(antes, Object.fromEntries(MODULOS.map((m) => [`modulo_${m}`, e.modulos[m]])));
      if (Object.keys(d.depois).length) registrar(store, { empresaId: e.id, entidade: 'empresa', entidadeId: e.id, acao: 'editada', ...quem(req, papel), ...d });
      return resp(200, { ...e.modulos });
    }

    if (recurso === 'agente' && req.metodo === 'GET') {
      return resp(200, lerConfig(store, empresaId));
    }
    // PATCH /empresas/:id/agente  { campos: { descricao, personalidade, habilidades, produtos, restricoes } } (tudo ou nada)
    // ou, por compatibilidade, { campo, valor }
    if (recurso === 'agente' && req.metodo === 'PATCH') {
      if (!staff) return resp(403, { erro: 'sem permissão' });
      const b = lerCorpo(req);
      const mud = b.campos && typeof b.campos === 'object' && !Array.isArray(b.campos) ? b.campos : { [b.campo]: b.valor };
      const antesCfg = lerConfig(store, empresaId);
      atualizarVarios(store, empresaId, mud, papel);
      const cfg = lerConfig(store, empresaId);
      const ator = quem(req, papel);
      for (const campo of Object.keys(mud)) {
        const da = diff({ [campo]: antesCfg[campo] }, { [campo]: cfg[campo] });
        if (Object.keys(da.depois).length) registrar(store, { empresaId, entidade: 'agente', entidadeId: campo, acao: 'editada', ...ator, ...da });
      }
      return resp(200, cfg);
    }
    if (recurso === 'reservas' && req.metodo === 'POST') {
      const b = lerCorpo(req);
      const chave = req.headers['idempotency-key'] || b.chave;
      if (!chave) return resp(400, { erro: 'chave de idempotência obrigatória (Idempotency-Key)' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.data || '') || !/^\d{2}:\d{2}$/.test(b.horario || '')) {
        return resp(400, { erro: 'data (AAAA-MM-DD) e horario (HH:MM) obrigatórios' });
      }
      const antesN = store.reservas.length;
      const r = reservar(store, { empresaId, data: b.data, horario: b.horario, pessoas: b.pessoas, ambiente: b.ambiente, mesaId: b.mesaId, chave: String(chave), nomeCliente: b.nomeCliente, contato: b.contato });
      if (r.status === 'confirmada' && store.reservas.length > antesN) {
        registrar(store, { empresaId, entidade: 'reserva', entidadeId: r.reservaId, acao: 'criada', ...quem(req, papel), depois: publica(store.reservas[store.reservas.length - 1]) });
      }
      return resp(r.status === 'confirmada' ? 201 : 200, r);
    }
    // Consulta do agente antes de reservar: mesas livres por ambiente
    if (recurso === 'disponibilidade' && req.metodo === 'GET') {
      const data = url.searchParams.get('data'), horario = url.searchParams.get('horario');
      const pessoas = Number(url.searchParams.get('pessoas'));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data || '') || !/^\d{2}:\d{2}$/.test(horario || '') || !Number.isInteger(pessoas) || pessoas < 1) {
        return resp(400, { erro: 'data (AAAA-MM-DD), horario (HH:MM) e pessoas obrigatórios' });
      }
      const ign = Number(url.searchParams.get('ignorar'));
      return resp(200, disponibilidade(store, empresaId, data, horario, pessoas, Number.isInteger(ign) && ign > 0 ? ign : undefined));
    }
    if (recurso === 'reservas' && req.metodo === 'GET') {
      if (!staff) return resp(403, { erro: 'sem permissão' });
      empresa(store, empresaId);
      const data = url.searchParams.get('data');
      return resp(200, store.reservas
        .filter((r) => r.empresaId === empresaId && (!data || r.data === data))
        .map(publica));
    }
    if (recurso === 'historico' && req.metodo === 'GET') {
      if (!staff) return resp(403, { erro: 'sem permissão' });
      empresa(store, empresaId);
      return resp(200, listar(store, empresaId, { entidade: url.searchParams.get('entidade'), entidadeId: url.searchParams.get('id'), limite: url.searchParams.get('limite') }));
    }
    // POST /empresas/:id/excluir { senha, confirmarNome }: exige a senha do administrador. Irreversível; grava instantâneo no histórico.
    if (recurso === 'excluir' && req.metodo === 'POST') {
      if (!staff) return resp(403, { erro: 'sem permissão' });
      const l = empresa(store, empresaId);
      if (!adminSenha) return resp(503, { erro: 'exclusão de empresa desativada: a senha do administrador não está configurada no servidor' });
      const agora = plat.agora();
      const tent = store.tentativasAdmin || (store.tentativasAdmin = { n: 0, ate: 0 });
      if (tent.ate > agora) return resp(429, { erro: `muitas tentativas incorretas; tente de novo em ${Math.ceil((tent.ate - agora) / 60000)} min` });
      const b = lerCorpo(req);
      const ator = quem(req, papel);
      if (typeof b.senha !== 'string' || !plat.iguaisTempoConstante(await hashChave(b.senha), await hashChave(adminSenha))) {
        tent.n++;
        if (tent.n >= 5) { tent.ate = agora + 15 * 60000; tent.n = 0; }
        registrar(store, { empresaId: l.id, entidade: 'empresa', entidadeId: l.id, acao: 'exclusao_negada', ...ator });
        return resp(403, { erro: 'senha do administrador incorreta' });
      }
      tent.n = 0;
      if (b.confirmarNome !== l.nome) return resp(400, { erro: 'digite o nome exato da empresa para confirmar' });
      const instantaneo = {
        nome: l.nome, agente: lerConfig(store, l.id), ambientes: l.ambientes, chaveApiAtiva: !!l.chave, modulos: { ...l.modulos },
        conhecimento: l.conhecimento.map(conhecimento.resumo),
        reservas: store.reservas.filter((r) => r.empresaId === l.id).map(publica),
      };
      store.empresas.delete(l.id);
      store.reservas = store.reservas.filter((r) => r.empresaId !== l.id);
      for (const k of [...store.chaves.keys()]) if (k.startsWith(`${l.id}:`)) store.chaves.delete(k);
      registrar(store, { empresaId: l.id, entidade: 'empresa', entidadeId: l.id, acao: 'excluida', ...ator, antes: instantaneo, depois: {} });
      return resp(200, { excluida: true, id: l.id, nome: l.nome });
    }
    // POST /empresas/:id/ambientes { nome }
    if (recurso === 'ambientes' && req.metodo === 'POST') {
      if (!staff) return resp(403, { erro: 'sem permissão' });
      const l = empresa(store, empresaId);
      const b = lerCorpo(req);
      const nome = typeof b.nome === 'string' ? b.nome.trim() : '';
      if (!nome || [...nome].length > 40) return resp(400, { erro: 'nome do ambiente deve ter de 1 a 40 caracteres' });
      if (l.ambientes.some((a) => a.nome.toLowerCase() === nome.toLowerCase())) return resp(409, { erro: 'já existe um ambiente com esse nome' });
      l.ambientes.push({ nome, mesas: [] });
      registrar(store, { empresaId: l.id, entidade: 'ambiente', entidadeId: nome, acao: 'criada', ...quem(req, papel), depois: { nome } });
      return resp(201, { nome, mesas: [] });
    }
    // POST /empresas/:id/mesas { ambiente, capacidade, reservavel? }
    if (recurso === 'mesas' && req.metodo === 'POST') {
      if (!staff) return resp(403, { erro: 'sem permissão' });
      const l = empresa(store, empresaId);
      const b = lerCorpo(req);
      const amb = l.ambientes.find((a) => a.nome === b.ambiente);
      if (!amb) return resp(404, { erro: 'ambiente inexistente' });
      if (!Number.isInteger(b.capacidade) || b.capacidade < 1 || b.capacidade > 100) return resp(400, { erro: 'capacidade inválida' });
      const base = (amb.nome.match(/[A-Za-z]/) || ['M'])[0].toUpperCase();
      const existentes = new Set(l.ambientes.flatMap((a) => a.mesas.map((m) => m.id)));
      let n = 1;
      while (existentes.has(`${base}${n}`)) n++;
      const mesa = { id: `${base}${n}`, capacidade: b.capacidade, reservavel: b.reservavel !== false };
      amb.mesas.push(mesa);
      registrar(store, { empresaId: l.id, entidade: 'mesa', entidadeId: mesa.id, acao: 'criada', ...quem(req, papel), depois: { ambiente: amb.nome, capacidade: mesa.capacidade, reservavel: mesa.reservavel } });
      return resp(201, mesa);
    }
    if (recurso === 'estrutura' && req.metodo === 'GET') {
      if (!staff) return resp(403, { erro: 'sem permissão' });
      const l = empresa(store, empresaId);
      return resp(200, { id: l.id, nome: l.nome, ambientes: l.ambientes, modulos: { ...l.modulos } });
    }
    if (recurso === 'mapa' && req.metodo === 'GET') {
      if (!staff) return resp(403, { erro: 'sem permissão' });
      const data = url.searchParams.get('data'), horario = url.searchParams.get('horario');
      if (!data || !horario) return resp(400, { erro: 'data e horario obrigatórios' });
      return resp(200, mapa(store, empresaId, data, horario));
    }
    return resp(404, { erro: 'rota inexistente' });
  } catch (e) {
    const codigo = e.codigo || (e instanceof Error && !e.codigo ? 400 : 500);
    return resp(codigo, { erro: e.message });
  }
}
