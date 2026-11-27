// Núcleo da API: uma função de requisição para resposta, sem Node.
//
//   tratar(req, ctx) -> { status, headers, corpo }
//   req = { metodo, url (caminho + query), headers (chaves em minúsculas), ip, corpo: Uint8Array|null | lerCorpo(limite) }
//   corpo da resposta: objeto/array (o adaptador serializa como JSON), Uint8Array (binário) ou null.
//
// Nada de node:*, Buffer, process ou require aqui: o que depende do ambiente vem em ctx.plat (src/plataforma.js).
// Adaptadores: src/node/servidor.js (HTTP do Node) e worker/index.js (Fetch API).
import { lerConfig, atualizarVarios, empresa } from './agentes.js';
import { reservarDetalhado, disponibilidade, editarReserva, cancelarReserva, reativarReserva, publica } from './reservas.js';
import { registrar, diff, listar } from './historico.js';
import { addEmpresa } from './store.js';
import { mapa } from './mapa.js';
import * as conhecimento from './conhecimento.js';
import { contexto, recursosDe } from './contexto.js';
import { fusoDe } from './tempo.js';
import { codigoReservaValido } from './plataforma.js';
import { conferirSenha, ehSuperadmin } from './usuarios.js';
import { podeFazer } from './permissoes.js';
import { rotaLogin, rotasSessao } from './rotas-sessao.js';
import { rotasUsuarios } from './rotas-usuarios.js';

export const LIMITE_CORPO = 512 * 1024; // 5 campos de texto somam até ~49 mil caracteres
export const LIMITE_CORPO_ARQUIVO = 6 * 1024 * 1024; // documento de até 4 MB em base64

// O corpo só é lido DEPOIS da autenticação e só pelas rotas que precisam dele, com o limite da rota.
// req.corpo (bytes já em mãos, usado em testes e em adaptadores que recebem tudo de uma vez) ou
// req.lerCorpo(limite) (leitura sob demanda; o adaptador recusa com 413 se passar do limite sem ler o resto).
async function lerCorpo(req, limite = LIMITE_CORPO) {
  const c = req.corpo !== undefined ? req.corpo : (req.lerCorpo ? await req.lerCorpo(limite) : null);
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
  // Sessão de usuário (token "s1_…"): papel, nome e empresas vêm do servidor, nunca do cliente.
  if (m[1].startsWith('s1_') && store.sessaoPorHash) {
    const hash = await plat.sha256Hex(m[1]);
    const s = await store.sessaoPorHash(hash);
    if (s && Date.parse(s.expiraEm) > ctx.agora()) {
      const u = await store.usuarioObter(s.usuarioId);
      if (u && u.ativo) {
        return { papel: u.papel, sessaoHash: hash, reautenticadoEm: s.reautenticadoEm,
          usuario: { id: u.id, nome: u.nome, email: u.email, empresas: u.empresas } };
      }
    }
    return null;
  }
  const id = await store.empresaPorChaveHash(await plat.sha256Hex(m[1]));
  return id ? { papel: 'chat', empresaEscopo: id } : null;
}

// Quem fez: papel do token (confiável) + operador informado no cabeçalho X-Operador (rótulo, não prova de identidade).
function quem(req, papel, auth) {
  // Usuário logado: nome e id vêm da sessão; o cabeçalho X-Operador é ignorado (ninguém se passa por outro).
  if (auth && auth.usuario) return { papel, operador: auth.usuario.nome, usuarioId: auth.usuario.id, usuarioNome: auth.usuario.nome };
  let operador = '';
  try { operador = decodeURIComponent(req.headers['x-operador'] || ''); } catch { operador = ''; }
  return { papel, operador: operador.trim().slice(0, 60) || null };
}

// Executa a operação sobre a reserva e registra o que mudou (se mudou).
async function mudarReserva(store, lid, rid, operacao, ator, extra) {
  if (store.transacao) return store.transacao((tx) => mudarReserva(tx, lid, rid, operacao, ator, extra));
  const achar = () => store.reservaObter(lid, rid);
  const a0 = await achar();
  const antes = a0 ? publica(a0) : null;
  const r = await operacao(store);
  if (r.status === 'indisponivel') return r;
  const d = diff(antes, r.reserva);
  if (Object.keys(d.depois).length) {
    const acao = (extra && extra.acao) || (d.depois.status === 'cancelada' ? 'cancelada' : d.depois.status === 'confirmada' ? 'reativada' : 'editada');
    await registrar(store, { empresaId: lid, entidade: 'reserva', entidadeId: rid, ...ator, ...extra, acao, antes: d.antes, depois: d.depois });
  }
  return r;
}

function mesaPublica({ id, capacidade, reservavel, descricao }) {
  return { id, capacidade, reservavel: reservavel === true, ...(descricao ? { descricao } : {}) };
}

// Descrição do local da mesa: uma linha de texto, até 150 caracteres; vazio apaga. Devolve null quando inválida.
const LIMITE_DESCRICAO_MESA = 150;
const ERRO_DESCRICAO_MESA = 'descrição da mesa deve ter uma linha com até 150 caracteres';
function descricaoDeMesa(valor) {
  if (typeof valor !== 'string') return null;
  const texto = valor.trim();
  return /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(texto) || [...texto].length > LIMITE_DESCRICAO_MESA ? null : texto;
}

async function mudarLayout(store, empresaId, recurso, id, metodo, nome, ator) {
  if (store.transacao) return store.transacao((tx) => mudarLayout(tx, empresaId, recurso, id, metodo, nome, ator));
  const l = await empresa(store, empresaId);
  const entidade = recurso === 'ambientes' ? 'ambiente' : 'mesa';
  const ambiente = l.ambientes.find((a) => entidade === 'ambiente' ? a.nome === id : a.mesas.some((m) => m.id === id));
  if (!ambiente) return [404, { erro: `${entidade} inexistente` }];
  const evento = { empresaId, entidade, entidadeId: id };

  if (metodo === 'PATCH') {
    const antes = { nome: ambiente.nome };
    const resultado = await store.ambienteRenomear(empresaId, id, nome);
    if (resultado.erro === 'nome_duplicado') return [409, { erro: 'nome já usado' }];
    if (resultado.erro === 'nao_encontrado') return [404, { erro: 'ambiente inexistente' }];
    if (antes.nome !== resultado.nome) {
      await registrar(store, { ...evento, acao: 'ambiente_renomeado', ...ator, antes, depois: { nome: resultado.nome } });
    }
    return [200, { nome: resultado.nome, mesas: resultado.mesas.map(mesaPublica) }];
  }

  const mesas = (entidade === 'ambiente' ? ambiente.mesas : ambiente.mesas.filter((m) => m.id === id)).map(mesaPublica);
  const ids = new Set(mesas.map((m) => m.id));
  const nomeAmbiente = ambiente.nome;
  const reservas = (await store.reservaListar(empresaId))
    .filter((r) => ids.has(r.mesaId)).map(({ id, mesaId }) => ({ id, mesaId }));
  const antes = entidade === 'ambiente'
    ? { nome: nomeAmbiente, mesas, reservas }
    : { ...mesas[0], ambiente: nomeAmbiente, reservas };
  const resultado = entidade === 'ambiente' ? await store.ambienteRemover(empresaId, id) : await store.mesaRemover(empresaId, id);
  if (resultado.erro === 'nao_encontrado') return [404, { erro: `${entidade} inexistente` }];
  if (resultado.erro === 'mesa_com_reserva') {
    return [409, { erro: 'mesa com reserva ativa', reservas: resultado.reservas }];
  }
  const acao = entidade === 'ambiente' ? 'ambiente_removido' : 'mesa_removida';
  await registrar(store, { ...evento, acao, ...ator, antes, depois: null });
  return [200, resultado];
}

async function excluirReserva(store, empresaId, id, ator) {
  if (store.transacao) return store.transacao((tx) => excluirReserva(tx, empresaId, id, ator));
  await empresa(store, empresaId);
  const resultado = await store.reservaExcluir(empresaId, id);
  if (resultado.erro === 'nao_encontrada') return [404, { erro: 'reserva inexistente' }];
  if (resultado.erro === 'reserva_ativa') return [409, { erro: 'reserva ativa; cancele antes de excluir' }];
  const r = resultado.reserva;
  const antes = { ...publica(r), inicio: r.inicio, fim: r.fim };
  await registrar(store, { empresaId, entidade: 'reserva', entidadeId: id, acao: 'reserva_excluida', ...ator, antes, depois: null });
  return [200, { ok: true }];
}

async function desfazer(store, lid, seq, ator) {
  if (store.transacao) return store.transacao((tx) => desfazer(tx, lid, seq, ator));
  await empresa(store, lid);
  const ev = await store.historicoObter(lid, seq);
  if (!ev || ev.entidade !== 'reserva') throw Object.assign(new Error('evento não desfazível'), { codigo: 404 });
  if (await store.historicoDesfeito(lid, seq)) throw Object.assign(new Error('este evento já foi desfeito'), { codigo: 409 });
  const atual = await store.reservaObter(lid, ev.entidadeId);
  if (!atual) throw Object.assign(new Error('reserva inexistente'), { codigo: 404 });
  const pub = publica(atual);
  // inclui campos que a mudança apagou (só aparecem em `antes`): se voltaram a ter valor, há mudança posterior
  for (const k of new Set([...Object.keys(ev.depois), ...Object.keys(ev.antes || {})])) {
    if (JSON.stringify(pub[k]) !== JSON.stringify(ev.depois[k])) {
      throw Object.assign(new Error('há mudanças posteriores nesta reserva; desfaça na ordem inversa'), { codigo: 409 });
    }
  }
  const op = (store) => {
    if (ev.acao === 'criada') return cancelarReserva(store, lid, ev.entidadeId);
    if (ev.antes.status === 'cancelada') return cancelarReserva(store, lid, ev.entidadeId);
    if (ev.antes.status === 'confirmada') return reativarReserva(store, lid, ev.entidadeId);
    const volta = { pessoas: ev.antes.pessoas, data: ev.antes.data, horario: ev.antes.horario, mesaId: ev.antes.mesaId };
    // dados do cliente que a edição mudou voltam ao valor anterior ('' apaga o que não existia)
    for (const k of ['nomeCliente', 'contato', 'observacao']) {
      if (k in (ev.antes || {}) || k in (ev.depois || {})) volta[k] = ev.antes?.[k] ?? '';
    }
    return editarReserva(store, lid, ev.entidadeId, volta);
  };
  return mudarReserva(store, lid, ev.entidadeId, op, ator, { acao: 'desfeita', refSeq: seq });
}

async function criarReservaComHistorico(store, dados, ator) {
  if (store.transacao) return store.transacao((tx) => criarReservaComHistorico(tx, dados, ator));
  const det = await reservarDetalhado(store, dados);
  if (det.criada) {
    await registrar(store, { empresaId: dados.empresaId, entidade: 'reserva', entidadeId: det.resposta.reservaId,
      acao: 'criada', ...ator, depois: publica(det.criada) });
  }
  return det.resposta;
}

const PERMISSAO_PADRAO = ['nome', 'descricao', 'personalidade', 'habilidades', 'produtos', 'restricoes'];

async function criarEmpresaComHistorico(store, b, ator) {
  if (store.transacao) return store.transacao((tx) => criarEmpresaComHistorico(tx, b, ator));
  const v = await validarNome(store, b.nome);
  if (v.erro) return [v.codigo, { erro: v.erro }];
  const vm = validarModulos(b.modulos);
  if (vm.erro) return [400, { erro: vm.erro }];
  const id = await store.empresaProximoId();
  const criada = await addEmpresa(store, {
    id, nome: v.nome, ambientes: [], modulos: vm.modulos,
    agente: { nome: '', descricao: '', personalidade: '', habilidades: '', produtos: '', restricoes: '',
      editavelPor: Object.fromEntries(PERMISSAO_PADRAO.map((c) => [c, ['cliente', 'integracao']])) },
  });
  await registrar(store, { empresaId: id, entidade: 'empresa', entidadeId: id, acao: 'criada', ...ator, depois: { nome: v.nome } });
  return [201, { id, nome: v.nome, modulos: criada.modulos }];
}

// Valida o nome de uma empresa: 1 a 60 caracteres e único entre as empresas.
async function validarNome(store, bruto, ignorarId) {
  const nome = typeof bruto === 'string' ? bruto.trim() : '';
  if (!nome || [...nome].length > 60) return { erro: 'nome da empresa deve ter de 1 a 60 caracteres', codigo: 400 };
  if (await store.empresaNomeEmUso(nome, ignorarId)) {
    return { erro: 'já existe outra empresa com esse nome', codigo: 409 };
  }
  return { nome };
}

const MODULOS = ['reservas', 'conhecimento'];
const RECURSOS_RESERVAS = ['reservas', 'disponibilidade', 'mapa', 'ambientes', 'mesas'];

// true se a empresa usa o recurso (ou se ela nem existe: o handler seguinte responde 404)
async function moduloLigado(store, id, nome) {
  const e = await store.empresaObter(id, { incluirConhecimento: false });
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
const REAUTENTICACAO_MS = 5 * 60 * 1000; // quanto tempo a reautenticação vale
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

// IP do cliente. Atrás de proxy confiável (CHATFLOW_CONFIAR_PROXY=1) usa o último valor de X-Forwarded-For (o que o proxy acrescentou).
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
  if (!tokens || (!opcoes.permitirSemTokenEquipe && !Object.values(tokens).some(Boolean))) {
    throw new Error('nenhum token configurado');
  }
  const plat = opcoes.plat || store.plat;
  return {
    store, plat, tokens,
    adminSenha: opcoes.adminSenha || null, // CHATFLOW_ADMIN_SENHA: sem ela, excluir empresa fica desativado
    corsOrigens: new Set((opcoes.corsOrigens || []).map((o) => String(o).trim()).filter(Boolean)), // lista exata (CHATFLOW_CORS_ORIGENS)
    confiarProxy: opcoes.confiarProxy === true, // CHATFLOW_CONFIAR_PROXY=1: usar X-Forwarded-For
    fuso: fusoDe(opcoes.fuso), // CHATFLOW_FUSO (padrão America/Sao_Paulo)
    agora: opcoes.agora || (() => plat.agora()),
    limiteInvalidas: criarLimitador(opcoes.limiteInvalidasPorMinuto || 20), // por IP, chave inválida ou ausente
    limiteValidas: criarLimitador(opcoes.limitePorChavePorMinuto || 300), // por chave válida
    limiteLogin: criarLimitador(opcoes.limiteLoginPorMinuto || 10), // tentativas de login por e-mail e por IP
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
  // Limite de tentativas de login por chave ('ip:…', 'email:…'): conta todas e devolve a resposta 429 se alguma estourou (ou null).
  const limitarLogin = (...chaves) => {
    const bloqueada = chaves.map((c) => ctx.limiteLogin.contar(c, ctx.agora())).find((r) => !r.ok);
    return bloqueada ? resp(429, { erro: 'muitas tentativas; tente novamente em instantes' }, { 'Retry-After': String(bloqueada.retryAfter) }) : null;
  };
  const semPermissao = () => resp(403, { erro: 'sem permissão' });
  // Contexto entregue aos módulos de rotas (src/rotas-*.js); o que depende da autenticação é completado depois dela.
  const rota = { req, ctx, store, plat, resp, semPermissao, limitarLogin, hashChave, lerCorpo, ip: ipDe(req, ctx.confiarProxy) };
  try {
    // Preflight: sempre 204 (sem cabeçalhos CORS quando a origem não é permitida ou a variável não existe)
    if (req.metodo === 'OPTIONS') return resp(204, null);
    // GET /saude: sem autenticação, só { ok: true }
    if (req.metodo === 'GET' && req.url.split('?')[0] === '/saude') return resp(200, { ok: true });
    // POST /login (src/rotas-sessao.js): sem autenticação prévia
    const respLogin = await rotaLogin(rota);
    if (respLogin) return respLogin;
    const auth = await autenticar(req, ctx);
    const limite = auth
      ? ctx.limiteValidas.contar(await hashChave(req.headers.authorization), ctx.agora())
      : ctx.limiteInvalidas.contar(ipDe(req, ctx.confiarProxy), ctx.agora());
    if (!limite.ok) return resp(429, { erro: 'muitas requisições; tente novamente em instantes' }, { 'Retry-After': String(limite.retryAfter) });
    if (!auth) return resp(401, { erro: 'não autenticado' });
    const papel = auth.papel;

    const url = new URL(req.url, 'http://x');
    const partes = url.pathname.split('/').filter(Boolean); // empresas/:id/<recurso>
    const idDe = (i) => decodeURIComponent(partes[i]); // segmento do caminho já decodificado
    const pode = (acao) => podeFazer(papel, acao); // quem pode o quê: src/permissoes.js
    const staff = pode('painel.usar');
    const base = ehSuperadmin(papel) ? 'integracao' : 'cliente'; // papel legado das regras de edição do agente
    const doUsuario = Boolean(auth.usuario);
    // Usuário que não é superadmin só enxerga as empresas liberadas para ele.
    if (doUsuario && !pode('empresas.todas') && partes[0] === 'empresas' && partes[1] && !auth.usuario.empresas.includes(idDe(1))) {
      return resp(403, { erro: 'empresa não liberada' });
    }
    // Configuração sensível: equipe e admin reautenticam com a própria senha (vale 5 min); superadmin e tokens do env dispensam.
    const reautenticado = !doUsuario || pode('configuracao.sem-senha') || (auth.reautenticadoEm && ctx.agora() - Date.parse(auth.reautenticadoEm) <= REAUTENTICACAO_MS);
    const exigirReautenticacao = () => resp(403, { erro: 'digite novamente a sua senha para continuar', reautenticar: true });
    // A senha informada é a do usuário logado? (só faz sentido para sessões de usuário)
    const senhaDoUsuarioConfere = async (senha) => typeof senha === 'string' && conferirSenha(senha, await store.usuarioObter(auth.usuario.id), plat.iguaisTempoConstante);
    // chave de API de uma empresa só alcança as rotas dessa empresa
    if (auth.empresaEscopo && !(partes[0] === 'empresas' && partes[1] && idDe(1) === auth.empresaEscopo)) {
      return resp(403, { erro: 'esta chave só acessa a própria empresa' });
    }

    Object.assign(rota, { auth, papel, partes, idDe, doUsuario, pode, senhaDoUsuarioConfere });
    // Sessão do usuário e gestão de usuários (src/rotas-sessao.js e src/rotas-usuarios.js)
    const respSessao = (await rotasSessao(rota)) || (await rotasUsuarios(rota));
    if (respSessao) return respSessao;
    // GET /historico/excluidas: resumo das empresas excluídas (o instantâneo completo fica gravado no histórico)
    if (partes[0] === 'historico' && partes[1] === 'excluidas' && partes.length === 2 && req.metodo === 'GET') {
      if (!pode('historico.excluidas')) return semPermissao();
      return resp(200, (await store.historicoExcluidas()).map((e) => ({
        seq: e.seq, quando: e.quando, papel: e.papel, operador: e.operador, empresaId: e.empresaId, nome: e.antes.nome,
        reservas: e.antes.reservas.length, ambientes: e.antes.ambientes.length, mesas: e.antes.ambientes.reduce((n, a) => n + a.mesas.length, 0),
      })));
    }
    // POST /empresas { nome }  (adicionar empresa: nasce com agente vazio, sem ambientes e sem chave de API)
    if (partes[0] === 'empresas' && partes.length === 1 && req.metodo === 'POST') {
      if (!pode('empresa.criar')) return semPermissao();
      const b = await lerCorpo(req);
      return resp(...await criarEmpresaComHistorico(store, b, quem(req, papel, auth)));
    }
    // Chave de API da empresa (só equipe de integração). A chave aparece uma única vez, ao gerar; só o hash fica guardado.
    if (partes[0] === 'empresas' && partes[2] === 'api' && (partes.length === 3 || (partes.length === 4 && partes[3] === 'chave'))) {
      if (!pode('api.gerir')) return resp(403, { erro: 'somente a equipe de integração gerencia a chave de API' });
      const l = await empresa(store, idDe(1));
      if (partes.length === 3 && req.metodo === 'GET') {
        return resp(200, { ativa: !!l.chave, prefixo: l.chave ? l.chave.prefixo : null, criadaEm: l.chave ? l.chave.criadaEm : null });
      }
      if (partes.length === 4 && req.metodo === 'POST') {
        const chave = 'k1_' + plat.aleatorio(32);
        const antes = l.chave ? { prefixo: l.chave.prefixo } : {};
        const nova = { hash: await hashChave(chave), prefixo: chave.slice(0, 11), criadaEm: new Date(plat.agora()).toISOString() };
        await store.chaveDefinir(l.id, nova);
        await registrar(store, { empresaId: l.id, entidade: 'api', entidadeId: 'chave', acao: 'chave_gerada', ...quem(req, papel, auth), antes, depois: { prefixo: nova.prefixo } });
        return resp(201, { chave, prefixo: nova.prefixo, criadaEm: nova.criadaEm });
      }
      if (partes.length === 4 && req.metodo === 'DELETE') {
        if (l.chave) await registrar(store, { empresaId: l.id, entidade: 'api', entidadeId: 'chave', acao: 'chave_revogada', ...quem(req, papel, auth), antes: { prefixo: l.chave.prefixo }, depois: {} });
        await store.chaveRemover(l.id);
        return resp(200, { ativa: false });
      }
    }

    if (partes[0] === 'empresas' && partes.length === 1 && req.metodo === 'GET') {
      if (!staff) return semPermissao();
      return resp(200, (await store.empresaListar({ incluirConhecimento: false }))
        .filter((l) => !doUsuario || pode('empresas.todas') || auth.usuario.empresas.includes(l.id))
        .map((l) => ({ id: l.id, nome: l.nome, modulos: { ...l.modulos } })));
    }
    // PATCH /empresas/:id  { nome }  (renomear a empresa)
    if (partes[0] === 'empresas' && partes.length === 2 && req.metodo === 'PATCH') {
      if (!staff) return semPermissao();
      if (!reautenticado) return exigirReautenticacao();
      const l = await empresa(store, idDe(1));
      const b = await lerCorpo(req);
      const v = await validarNome(store, b.nome, l.id);
      if (v.erro) return resp(v.codigo, { erro: v.erro });
      const nome = v.nome;
      const antes = l.nome;
      await store.empresaRenomear(l.id, nome);
      const dl = diff({ nome: antes }, { nome });
      if (Object.keys(dl.depois).length) await registrar(store, { empresaId: l.id, entidade: 'empresa', entidadeId: l.id, acao: 'editada', ...quem(req, papel, auth), ...dl });
      return resp(200, { id: l.id, nome, modulos: { ...l.modulos } });
    }
    // PATCH/DELETE ambientes e DELETE mesas; o nome é o identificador do ambiente.
    if (partes[0] === 'empresas' && partes.length === 4 && (
      (partes[2] === 'ambientes' && ['PATCH', 'DELETE'].includes(req.metodo)) ||
      (partes[2] === 'mesas' && req.metodo === 'DELETE')
    )) {
      if (!staff) return semPermissao();
      const lid = idDe(1);
      const id = idDe(3);
      if (!(await moduloLigado(store, lid, 'reservas'))) return resp(404, { erro: 'recurso "reservas" não habilitado para esta empresa' });
      let nome;
      if (req.metodo === 'PATCH') {
        const b = await lerCorpo(req);
        nome = typeof b?.nome === 'string' ? b.nome.trim() : '';
        if (!nome || [...nome].length > 60) return resp(400, { erro: 'nome do ambiente deve ter de 1 a 60 caracteres' });
      }
      return resp(...await mudarLayout(store, lid, partes[2], id, req.metodo, nome, quem(req, papel, auth)));
    }
    // PATCH /empresas/:id/mesas/:mesaId  { capacidade?, reservavel?, descricao? }
    if (partes[0] === 'empresas' && partes[2] === 'mesas' && partes.length === 4 && req.metodo === 'PATCH') {
      if (!staff) return semPermissao();
      const l = await empresa(store, idDe(1));
      if (!(await moduloLigado(store, l.id, 'reservas'))) return resp(404, { erro: 'recurso "reservas" não habilitado para esta empresa' });
      const mesaId = idDe(3);
      const mesa = l.ambientes.flatMap((a) => a.mesas).find((m) => m.id === mesaId);
      if (!mesa) return resp(404, { erro: 'mesa inexistente' });
      const b = await lerCorpo(req);
      const antesMesa = { capacidade: mesa.capacidade, reservavel: mesa.reservavel, descricao: mesa.descricao || '' };
      if (b.capacidade !== undefined) {
        if (!Number.isInteger(b.capacidade) || b.capacidade < 1 || b.capacidade > 100) return resp(400, { erro: 'capacidade inválida' });
      }
      if (b.reservavel !== undefined) {
        if (typeof b.reservavel !== 'boolean') return resp(400, { erro: 'reservavel inválido' });
      }
      let descricao;
      if (b.descricao !== undefined) {
        descricao = descricaoDeMesa(b.descricao);
        if (descricao === null) return resp(400, { erro: ERRO_DESCRICAO_MESA });
      }
      const editada = await store.mesaEditar(l.id, mesaId, { capacidade: b.capacidade, reservavel: b.reservavel, descricao });
      if (!editada) return resp(404, { erro: 'mesa inexistente' });
      const dm = diff(antesMesa, { capacidade: editada.mesa.capacidade, reservavel: editada.mesa.reservavel, descricao: editada.mesa.descricao || '' });
      if (Object.keys(dm.depois).length) await registrar(store, { empresaId: l.id, entidade: 'mesa', entidadeId: mesaId, acao: 'editada', ...quem(req, papel, auth), ...dm });
      return resp(200, editada.mesa);
    }
    // PATCH /empresas/:id/reservas/:rid {pessoas?,data?,horario?,mesaId?} | {status:'cancelada'|'confirmada'}; DELETE cancela
    if (partes[0] === 'empresas' && partes[2] === 'reservas' && partes.length === 4 && (req.metodo === 'PATCH' || req.metodo === 'DELETE')) {
      if (!staff) return semPermissao();
      const lid = idDe(1), rid = idDe(3);
      if (!(await moduloLigado(store, lid, 'reservas'))) return resp(404, { erro: 'recurso "reservas" não habilitado para esta empresa' });
      if (!codigoReservaValido(rid)) return resp(404, { erro: 'reserva inexistente' });
      const ator = quem(req, papel, auth);
      if (req.metodo === 'DELETE' && url.searchParams.get('definitivo') === '1') {
        return resp(...await excluirReserva(store, lid, rid, ator));
      }
      if (req.metodo === 'DELETE') return resp(200, await mudarReserva(store, lid, rid, (tx) => cancelarReserva(tx, lid, rid), ator));
      const b = await lerCorpo(req);
      const r = await mudarReserva(store, lid, rid, (tx) => (b.status === 'cancelada' ? cancelarReserva(tx, lid, rid)
        : b.status === 'confirmada' ? reativarReserva(tx, lid, rid)
          : editarReserva(tx, lid, rid, { pessoas: b.pessoas, data: b.data, horario: b.horario, mesaId: b.mesaId, nomeCliente: b.nomeCliente, contato: b.contato, observacao: b.observacao })), ator);
      return resp(r.status === 'indisponivel' ? 409 : 200, r);
    }
    // POST /empresas/:id/historico/:seq/desfazer
    if (partes[0] === 'empresas' && partes[2] === 'historico' && partes.length === 5 && partes[4] === 'desfazer' && req.metodo === 'POST') {
      if (!pode('historico.desfazer')) return semPermissao();
      const seq = Number(partes[3]);
      if (!Number.isInteger(seq)) return resp(404, { erro: 'evento inexistente' });
      const r = await desfazer(store, idDe(1), seq, quem(req, papel, auth));
      return resp(r.status === 'indisponivel' ? 409 : 200, r);
    }
    // Base de conhecimento: GET (chat e equipe) lê; POST/PATCH/DELETE (equipe) editam.
    //  /empresas/:id/conhecimento | /conhecimento/:itemId | /conhecimento/:itemId/arquivo
    if (partes[0] === 'empresas' && partes[2] === 'conhecimento' && partes.length >= 3 && partes.length <= 5) {
      const eid = idDe(1);
      const e = await empresa(store, eid);
      if (e.modulos.conhecimento === false) return resp(404, { erro: 'recurso "conhecimento" não habilitado para esta empresa' });
      const ator = quem(req, papel, auth);
      if (partes.length === 3 && req.metodo === 'GET') return resp(200, { itens: await conhecimento.listarPublico(store, eid) });
      if (partes.length === 3 && req.metodo === 'POST') {
        if (!staff) return semPermissao();
        const item = await conhecimento.criar(store, eid, await lerCorpo(req, LIMITE_CORPO_ARQUIVO));
        await registrar(store, { empresaId: eid, entidade: 'conhecimento', entidadeId: item.id, acao: 'criada', ...ator, depois: conhecimento.resumo(item) });
        return resp(201, conhecimento.publica(eid, item));
      }
      if (partes.length === 4 && partes[3] === 'buscar' && req.metodo === 'GET') {
        return resp(200, await conhecimento.buscar(store, eid, url.searchParams.get('q'), url.searchParams.get('limite')));
      }
      const itemId = Number(partes[3]);
      if (!Number.isInteger(itemId)) return resp(404, { erro: 'item de conhecimento inexistente' });
      if (partes.length === 4 && req.metodo === 'GET') return resp(200, await conhecimento.obter(store, eid, itemId));
      if (partes.length === 4 && req.metodo === 'PATCH') {
        if (!staff) return semPermissao();
        const antes = conhecimento.resumo((await conhecimento.achar(store, eid, itemId, { incluirArquivo: false })).item);
        const item = await conhecimento.editar(store, eid, itemId, await lerCorpo(req, LIMITE_CORPO_ARQUIVO));
        const d = diff(antes, conhecimento.resumo(item));
        if (Object.keys(d.depois).length) await registrar(store, { empresaId: eid, entidade: 'conhecimento', entidadeId: itemId, acao: 'editada', ...ator, ...d });
        return resp(200, conhecimento.publica(eid, item));
      }
      if (partes.length === 4 && req.metodo === 'DELETE') {
        if (!staff) return semPermissao();
        const item = await conhecimento.excluir(store, eid, itemId);
        await registrar(store, { empresaId: eid, entidade: 'conhecimento', entidadeId: itemId, acao: 'excluida', ...ator, antes: conhecimento.resumo(item), depois: {} });
        return resp(200, { excluido: true, id: itemId });
      }
      if (partes.length === 5 && partes[4] === 'arquivo' && req.metodo === 'GET') {
        const a = await conhecimento.arquivoDe(store, eid, itemId);
        return { status: 200, headers: {
          'Content-Type': a.mime,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.nome)}`,
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': 'sandbox',
        }, corpo: a.buffer };
      }
    }
    if (partes[0] !== 'empresas' || partes.length !== 3) return resp(404, { erro: 'rota inexistente' });
    const empresaId = idDe(1);
    const recurso = partes[2];
    if (RECURSOS_RESERVAS.includes(recurso) && !(await moduloLigado(store, empresaId, 'reservas'))) {
      return resp(404, { erro: 'recurso "reservas" não habilitado para esta empresa' });
    }

    // GET /empresas/:id/recursos: o que esta empresa usa e quais endereços o sistema de conversa pode chamar
    if (recurso === 'recursos' && req.metodo === 'GET') {
      return resp(200, recursosDe(await empresa(store, empresaId)));
    }
    // GET /empresas/:id/contexto: tudo o que o agente precisa em uma chamada (config, conhecimento, recursos e prompt pronto)
    if (recurso === 'contexto' && req.metodo === 'GET') {
      return resp(200, await contexto(store, empresaId, { agora: ctx.agora(), fuso: ctx.fuso }));
    }
    // PATCH /empresas/:id/modulos { reservas?, conhecimento? }: liga ou desliga recursos (os dados são mantidos)
    if (recurso === 'modulos' && req.metodo === 'PATCH') {
      if (!staff) return semPermissao();
      if (!reautenticado) return exigirReautenticacao();
      const e = await empresa(store, empresaId);
      const vm = validarModulos(await lerCorpo(req));
      if (vm.erro) return resp(400, { erro: vm.erro });
      if (Object.keys(vm.modulos).length === 0) return resp(400, { erro: 'nenhum módulo informado' });
      const antes = Object.fromEntries(MODULOS.map((m) => [`modulo_${m}`, e.modulos[m]]));
      const novos = await store.empresaModulosDefinir(e.id, vm.modulos);
      const d = diff(antes, Object.fromEntries(MODULOS.map((m) => [`modulo_${m}`, novos[m]])));
      if (Object.keys(d.depois).length) await registrar(store, { empresaId: e.id, entidade: 'empresa', entidadeId: e.id, acao: 'editada', ...quem(req, papel, auth), ...d });
      return resp(200, { ...novos });
    }

    if (recurso === 'agente' && req.metodo === 'GET') {
      return resp(200, await lerConfig(store, empresaId));
    }
    // PATCH /empresas/:id/agente  { campos: { descricao, personalidade, habilidades, produtos, restricoes } } (tudo ou nada)
    // ou, por compatibilidade, { campo, valor }
    if (recurso === 'agente' && req.metodo === 'PATCH') {
      if (!staff) return semPermissao();
      const b = await lerCorpo(req);
      const mud = b.campos && typeof b.campos === 'object' && !Array.isArray(b.campos) ? b.campos : { [b.campo]: b.valor };
      const antesCfg = await lerConfig(store, empresaId);
      await atualizarVarios(store, empresaId, mud, base);
      const cfg = await lerConfig(store, empresaId);
      const ator = quem(req, papel, auth);
      for (const campo of Object.keys(mud)) {
        const da = diff({ [campo]: antesCfg[campo] }, { [campo]: cfg[campo] });
        if (Object.keys(da.depois).length) await registrar(store, { empresaId, entidade: 'agente', entidadeId: campo, acao: 'editada', ...ator, ...da });
      }
      return resp(200, cfg);
    }
    if (recurso === 'reservas' && req.metodo === 'POST') {
      const b = await lerCorpo(req);
      const chave = req.headers['idempotency-key'] || b.chave;
      if (!chave) return resp(400, { erro: 'chave de idempotência obrigatória (Idempotency-Key)' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.data || '') || !/^\d{2}:\d{2}$/.test(b.horario || '')) {
        return resp(400, { erro: 'data (AAAA-MM-DD) e horario (HH:MM) obrigatórios' });
      }
      const r = await criarReservaComHistorico(store, { empresaId, data: b.data, horario: b.horario, pessoas: b.pessoas,
        ambiente: b.ambiente, mesaId: b.mesaId, chave: String(chave), nomeCliente: b.nomeCliente, contato: b.contato, observacao: b.observacao }, quem(req, papel, auth));
      return resp(r.status === 'confirmada' ? 201 : 200, r);
    }
    // Consulta do agente antes de reservar: mesas livres por ambiente
    if (recurso === 'disponibilidade' && req.metodo === 'GET') {
      const data = url.searchParams.get('data'), horario = url.searchParams.get('horario');
      const pessoas = Number(url.searchParams.get('pessoas'));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data || '') || !/^\d{2}:\d{2}$/.test(horario || '') || !Number.isInteger(pessoas) || pessoas < 1) {
        return resp(400, { erro: 'data (AAAA-MM-DD), horario (HH:MM) e pessoas obrigatórios' });
      }
      const ign = url.searchParams.get('ignorar');
      if (ign !== null && !codigoReservaValido(ign)) return resp(400, { erro: 'código de reserva inválido em ignorar' });
      return resp(200, await disponibilidade(store, empresaId, data, horario, pessoas, ign ?? undefined));
    }
    if (recurso === 'reservas' && req.metodo === 'GET') {
      if (!staff) return semPermissao();
      await empresa(store, empresaId);
      const data = url.searchParams.get('data');
      return resp(200, (await store.reservaListar(empresaId, { data }))
        .map(publica));
    }
    if (recurso === 'historico' && req.metodo === 'GET') {
      if (!pode('historico.ver')) return semPermissao();
      await empresa(store, empresaId);
      return resp(200, await listar(store, empresaId, { entidade: url.searchParams.get('entidade'), entidadeId: url.searchParams.get('id'), limite: url.searchParams.get('limite') }));
    }
    // POST /empresas/:id/excluir { senha, confirmarNome }: exige a senha do administrador. Irreversível; grava instantâneo no histórico.
    if (recurso === 'excluir' && req.metodo === 'POST') {
      if (!staff) return semPermissao();
      if (!pode('empresa.excluir')) return resp(403, { erro: 'somente admin ou superadmin exclui empresa' });
      const l = await empresa(store, empresaId);
      // Usuário logado confirma com a PRÓPRIA senha; o token do env usa CHATFLOW_ADMIN_SENHA.
      if (!doUsuario && !adminSenha) return resp(503, { erro: 'exclusão de empresa desativada: a senha do administrador não está configurada no servidor' });
      const agora = plat.agora();
      const tent = await store.tentativasAdminObter();
      if (tent.ate > agora) return resp(429, { erro: `muitas tentativas incorretas; tente de novo em ${Math.ceil((tent.ate - agora) / 60000)} min` });
      const b = await lerCorpo(req);
      const ator = quem(req, papel, auth);
      const senhaCerta = typeof b.senha === 'string' && (doUsuario
        ? await senhaDoUsuarioConfere(b.senha)
        : plat.iguaisTempoConstante(await hashChave(b.senha), await hashChave(adminSenha)));
      if (!senhaCerta) {
        tent.n++;
        if (tent.n >= 5) { tent.ate = agora + 15 * 60000; tent.n = 0; }
        await store.tentativasAdminGravar(tent);
        await registrar(store, { empresaId: l.id, entidade: 'empresa', entidadeId: l.id, acao: 'exclusao_negada', ...ator });
        return resp(403, { erro: doUsuario ? 'senha incorreta' : 'senha do administrador incorreta' });
      }
      tent.n = 0;
      await store.tentativasAdminGravar(tent);
      if (b.confirmarNome !== l.nome) return resp(400, { erro: 'digite o nome exato da empresa para confirmar' });
      const instantaneo = {
        nome: l.nome, agente: await lerConfig(store, l.id), ambientes: l.ambientes, chaveApiAtiva: !!l.chave, modulos: { ...l.modulos },
        conhecimento: (await store.conhecimentoListar(l.id, { incluirArquivo: false })).map(conhecimento.resumo),
        reservas: (await store.reservaListar(l.id)).map(publica),
      };
      await store.empresaExcluir(l.id, { empresaId: l.id, entidade: 'empresa', entidadeId: l.id, acao: 'excluida', ...ator, antes: instantaneo, depois: {} });
      return resp(200, { excluida: true, id: l.id, nome: l.nome });
    }
    // POST /empresas/:id/ambientes { nome }
    if (recurso === 'ambientes' && req.metodo === 'POST') {
      if (!staff) return semPermissao();
      const l = await empresa(store, empresaId);
      const b = await lerCorpo(req);
      const nome = typeof b.nome === 'string' ? b.nome.trim() : '';
      if (!nome || [...nome].length > 40) return resp(400, { erro: 'nome do ambiente deve ter de 1 a 40 caracteres' });
      const cr = await store.ambienteCriar(l.id, nome);
      if (!cr.ok) return resp(409, { erro: 'já existe um ambiente com esse nome' });
      await registrar(store, { empresaId: l.id, entidade: 'ambiente', entidadeId: nome, acao: 'criada', ...quem(req, papel, auth), depois: { nome } });
      return resp(201, { nome, mesas: [] });
    }
    // POST /empresas/:id/mesas { ambiente, capacidade, reservavel?, descricao? }
    if (recurso === 'mesas' && req.metodo === 'POST') {
      if (!staff) return semPermissao();
      const l = await empresa(store, empresaId);
      const b = await lerCorpo(req);
      const amb = l.ambientes.find((a) => a.nome === b.ambiente);
      if (!amb) return resp(404, { erro: 'ambiente inexistente' });
      if (!Number.isInteger(b.capacidade) || b.capacidade < 1 || b.capacidade > 100) return resp(400, { erro: 'capacidade inválida' });
      const descricao = b.descricao === undefined ? '' : descricaoDeMesa(b.descricao);
      if (descricao === null) return resp(400, { erro: ERRO_DESCRICAO_MESA });
      const mesa = await store.mesaCriar(l.id, amb.nome, { capacidade: b.capacidade, reservavel: b.reservavel, descricao });
      await registrar(store, { empresaId: l.id, entidade: 'mesa', entidadeId: mesa.id, acao: 'criada', ...quem(req, papel, auth), depois: { ambiente: amb.nome, capacidade: mesa.capacidade, reservavel: mesa.reservavel, ...(descricao ? { descricao } : {}) } });
      return resp(201, mesa);
    }
    if (recurso === 'estrutura' && req.metodo === 'GET') {
      if (!staff) return semPermissao();
      const l = await empresa(store, empresaId);
      return resp(200, { id: l.id, nome: l.nome, ambientes: l.ambientes, modulos: { ...l.modulos } });
    }
    if (recurso === 'mapa' && req.metodo === 'GET') {
      if (!staff) return semPermissao();
      const data = url.searchParams.get('data'), horario = url.searchParams.get('horario');
      if (!data || !horario) return resp(400, { erro: 'data e horario obrigatórios' });
      return resp(200, await mapa(store, empresaId, data, horario));
    }
    return resp(404, { erro: 'rota inexistente' });
  } catch (e) {
    const codigo = e.codigo || (e instanceof Error && !e.codigo ? 400 : 500);
    return resp(codigo, { erro: e.message });
  }
}
