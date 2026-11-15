'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { lerConfig, atualizarVarios, empresa } = require('./agentes');
const { reservar, disponibilidade, editarReserva, cancelarReserva, reativarReserva, publica } = require('./reservas');
const { registrar, diff, listar } = require('./historico');
const { addEmpresa } = require('./store');
const { mapa } = require('./mapa');
const conhecimento = require('./conhecimento');
const { contexto, recursosDe } = require('./contexto');

const LIMITE_CORPO = 512 * 1024; // 5 campos de texto somam até ~49 mil caracteres
const LIMITE_CORPO_ARQUIVO = 6 * 1024 * 1024; // documento de até 4 MB em base64
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

const hashChave = (c) => crypto.createHash('sha256').update(c).digest('hex');

// Devolve { papel, empresaEscopo? } ou null. Chave de API de empresa vale só para aquela empresa e só com poderes do chat.
function autenticar(req, tokens, store) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  for (const papel of Object.keys(tokens)) {
    if (tokens[papel] && iguais(m[1], tokens[papel])) return { papel };
  }
  const h = hashChave(m[1]);
  for (const l of store.empresas.values()) {
    if (l.chave && iguais(h, l.chave.hash)) return { papel: 'chat', empresaEscopo: l.id };
  }
  return null;
}

function lerCorpo(req, limite = LIMITE_CORPO) {
  return new Promise((resolve, reject) => {
    let tam = 0;
    const partes = [];
    req.on('data', (c) => {
      tam += c.length;
      if (tam > limite) { reject(Object.assign(new Error('corpo grande demais'), { codigo: 413 })); req.destroy(); return; }
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

// opcoes.adminSenha: senha do administrador (vem de KENDJI_ADMIN_SENHA). Sem ela, excluir empresa fica desativado.
function criarServidor(store, tokens, opcoes = {}) {
  if (!tokens || !Object.values(tokens).some(Boolean)) throw new Error('nenhum token configurado');
  const adminSenha = opcoes.adminSenha || null;

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
      const auth = autenticar(req, tokens, store);
      if (!auth) return responder(res, 401, { erro: 'não autenticado' });
      const papel = auth.papel;

      const url = new URL(req.url, 'http://x');
      const partes = url.pathname.split('/').filter(Boolean); // empresas/:id/<recurso>
      const staff = papel === 'cliente' || papel === 'integracao';
      // chave de API de uma empresa só alcança as rotas dessa empresa
      if (auth.empresaEscopo && !(partes[0] === 'empresas' && partes[1] && decodeURIComponent(partes[1]) === auth.empresaEscopo)) {
        return responder(res, 403, { erro: 'esta chave só acessa a própria empresa' });
      }

      // GET /historico/excluidas: resumo das empresas excluídas (o instantâneo completo fica gravado no histórico)
      if (partes[0] === 'historico' && partes[1] === 'excluidas' && partes.length === 2 && req.method === 'GET') {
        if (!staff) return responder(res, 403, { erro: 'sem permissão' });
        return responder(res, 200, store.historico.filter((e) => e.acao === 'excluida' && e.entidade === 'empresa').reverse().map((e) => ({
          seq: e.seq, quando: e.quando, papel: e.papel, operador: e.operador, empresaId: e.empresaId, nome: e.antes.nome,
          reservas: e.antes.reservas.length, ambientes: e.antes.ambientes.length, mesas: e.antes.ambientes.reduce((n, a) => n + a.mesas.length, 0),
        })));
      }
      // POST /empresas { nome }  (adicionar empresa: nasce com agente vazio, sem ambientes e sem chave de API)
      if (partes[0] === 'empresas' && partes.length === 1 && req.method === 'POST') {
        if (!staff) return responder(res, 403, { erro: 'sem permissão' });
        const b = await lerCorpo(req);
        const v = validarNome(store, b.nome);
        if (v.erro) return responder(res, v.codigo, { erro: v.erro });
        const vm = validarModulos(b.modulos);
        if (vm.erro) return responder(res, 400, { erro: vm.erro });
        let n = store.empresas.size + 1;
        while (store.empresas.has(`empresa_${n}`) || store.historico.some((e) => e.empresaId === `empresa_${n}`)) n++;
        const id = `empresa_${n}`;
        addEmpresa(store, {
          id, nome: v.nome, ambientes: [], modulos: vm.modulos,
          agente: { nome: '', descricao: '', personalidade: '', habilidades: '', produtos: '', restricoes: '', editavelPor: Object.fromEntries(PERMISSAO_PADRAO.map((c) => [c, ['cliente', 'integracao']])) },
        });
        registrar(store, { empresaId: id, entidade: 'empresa', entidadeId: id, acao: 'criada', ...quem(req, papel), depois: { nome: v.nome } });
        return responder(res, 201, { id, nome: v.nome, modulos: store.empresas.get(id).modulos });
      }
      // Chave de API da empresa (só equipe de integração). A chave aparece uma única vez, ao gerar; só o hash fica guardado.
      if (partes[0] === 'empresas' && partes[2] === 'api' && (partes.length === 3 || (partes.length === 4 && partes[3] === 'chave'))) {
        if (papel !== 'integracao') return responder(res, 403, { erro: 'somente a equipe de integração gerencia a chave de API' });
        const l = empresa(store, decodeURIComponent(partes[1]));
        if (partes.length === 3 && req.method === 'GET') {
          return responder(res, 200, { ativa: !!l.chave, prefixo: l.chave ? l.chave.prefixo : null, criadaEm: l.chave ? l.chave.criadaEm : null });
        }
        if (partes.length === 4 && req.method === 'POST') {
          const chave = 'k1_' + crypto.randomBytes(32).toString('base64url');
          const antes = l.chave ? { prefixo: l.chave.prefixo } : {};
          l.chave = { hash: hashChave(chave), prefixo: chave.slice(0, 11), criadaEm: new Date().toISOString() };
          registrar(store, { empresaId: l.id, entidade: 'api', entidadeId: 'chave', acao: 'chave_gerada', ...quem(req, papel), antes, depois: { prefixo: l.chave.prefixo } });
          return responder(res, 201, { chave, prefixo: l.chave.prefixo, criadaEm: l.chave.criadaEm });
        }
        if (partes.length === 4 && req.method === 'DELETE') {
          if (l.chave) registrar(store, { empresaId: l.id, entidade: 'api', entidadeId: 'chave', acao: 'chave_revogada', ...quem(req, papel), antes: { prefixo: l.chave.prefixo }, depois: {} });
          l.chave = null;
          return responder(res, 200, { ativa: false });
        }
      }

      if (partes[0] === 'empresas' && partes.length === 1 && req.method === 'GET') {
        if (!staff) return responder(res, 403, { erro: 'sem permissão' });
        return responder(res, 200, [...store.empresas.values()].map((l) => ({ id: l.id, nome: l.nome, modulos: { ...l.modulos } })));
      }
      // PATCH /empresas/:id  { nome }  (renomear a empresa)
      if (partes[0] === 'empresas' && partes.length === 2 && req.method === 'PATCH') {
        if (!staff) return responder(res, 403, { erro: 'sem permissão' });
        const l = empresa(store, decodeURIComponent(partes[1]));
        const b = await lerCorpo(req);
        const v = validarNome(store, b.nome, l.id);
        if (v.erro) return responder(res, v.codigo, { erro: v.erro });
        const nome = v.nome;
        const antes = l.nome;
        l.nome = nome;
        const dl = diff({ nome: antes }, { nome });
        if (Object.keys(dl.depois).length) registrar(store, { empresaId: l.id, entidade: 'empresa', entidadeId: l.id, acao: 'editada', ...quem(req, papel), ...dl });
        return responder(res, 200, { id: l.id, nome: l.nome, modulos: { ...l.modulos } });
      }
      // PATCH /empresas/:id/mesas/:mesaId  { capacidade?, reservavel? }
      if (partes[0] === 'empresas' && partes[2] === 'mesas' && partes.length === 4 && req.method === 'PATCH') {
        if (!staff) return responder(res, 403, { erro: 'sem permissão' });
        const l = empresa(store, decodeURIComponent(partes[1]));
        if (!moduloLigado(store, l.id, 'reservas')) return responder(res, 404, { erro: 'recurso "reservas" não habilitado para esta empresa' });
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
        if (Object.keys(dm.depois).length) registrar(store, { empresaId: l.id, entidade: 'mesa', entidadeId: mesaId, acao: 'editada', ...quem(req, papel), ...dm });
        return responder(res, 200, mesa);
      }
      // PATCH /empresas/:id/reservas/:rid {pessoas?,data?,horario?,mesaId?} | {status:'cancelada'|'confirmada'}; DELETE cancela
      if (partes[0] === 'empresas' && partes[2] === 'reservas' && partes.length === 4 && (req.method === 'PATCH' || req.method === 'DELETE')) {
        if (!staff) return responder(res, 403, { erro: 'sem permissão' });
        const lid = decodeURIComponent(partes[1]), rid = Number(partes[3]);
        if (!moduloLigado(store, lid, 'reservas')) return responder(res, 404, { erro: 'recurso "reservas" não habilitado para esta empresa' });
        if (!Number.isInteger(rid)) return responder(res, 404, { erro: 'reserva inexistente' });
        const ator = quem(req, papel);
        if (req.method === 'DELETE') return responder(res, 200, mudarReserva(store, lid, rid, () => cancelarReserva(store, lid, rid), ator));
        const b = await lerCorpo(req);
        const r = mudarReserva(store, lid, rid, () => (b.status === 'cancelada' ? cancelarReserva(store, lid, rid)
          : b.status === 'confirmada' ? reativarReserva(store, lid, rid)
            : editarReserva(store, lid, rid, { pessoas: b.pessoas, data: b.data, horario: b.horario, mesaId: b.mesaId, nomeCliente: b.nomeCliente, contato: b.contato })), ator);
        return responder(res, r.status === 'indisponivel' ? 409 : 200, r);
      }
      // POST /empresas/:id/historico/:seq/desfazer
      if (partes[0] === 'empresas' && partes[2] === 'historico' && partes.length === 5 && partes[4] === 'desfazer' && req.method === 'POST') {
        if (!staff) return responder(res, 403, { erro: 'sem permissão' });
        const seq = Number(partes[3]);
        if (!Number.isInteger(seq)) return responder(res, 404, { erro: 'evento inexistente' });
        const r = desfazer(store, decodeURIComponent(partes[1]), seq, quem(req, papel));
        return responder(res, r.status === 'indisponivel' ? 409 : 200, r);
      }
      // Base de conhecimento: GET (chat e equipe) lê; POST/PATCH/DELETE (equipe) editam.
      //  /empresas/:id/conhecimento | /conhecimento/:itemId | /conhecimento/:itemId/arquivo
      if (partes[0] === 'empresas' && partes[2] === 'conhecimento' && partes.length >= 3 && partes.length <= 5) {
        const eid = decodeURIComponent(partes[1]);
        const e = empresa(store, eid);
        if (e.modulos.conhecimento === false) return responder(res, 404, { erro: 'recurso "conhecimento" não habilitado para esta empresa' });
        const ator = quem(req, papel);
        if (partes.length === 3 && req.method === 'GET') return responder(res, 200, { itens: conhecimento.listarPublico(store, eid) });
        if (partes.length === 3 && req.method === 'POST') {
          if (!staff) return responder(res, 403, { erro: 'sem permissão' });
          const item = conhecimento.criar(store, eid, await lerCorpo(req, LIMITE_CORPO_ARQUIVO));
          registrar(store, { empresaId: eid, entidade: 'conhecimento', entidadeId: item.id, acao: 'criada', ...ator, depois: conhecimento.resumo(item) });
          return responder(res, 201, conhecimento.publica(eid, item));
        }
        if (partes.length === 4 && partes[3] === 'buscar' && req.method === 'GET') {
          return responder(res, 200, conhecimento.buscar(store, eid, url.searchParams.get('q'), url.searchParams.get('limite')));
        }
        const itemId = Number(partes[3]);
        if (!Number.isInteger(itemId)) return responder(res, 404, { erro: 'item de conhecimento inexistente' });
        if (partes.length === 4 && req.method === 'GET') return responder(res, 200, conhecimento.obter(store, eid, itemId));
        if (partes.length === 4 && req.method === 'PATCH') {
          if (!staff) return responder(res, 403, { erro: 'sem permissão' });
          const antes = conhecimento.resumo(conhecimento.achar(store, eid, itemId).item);
          const item = conhecimento.editar(store, eid, itemId, await lerCorpo(req, LIMITE_CORPO_ARQUIVO));
          const d = diff(antes, conhecimento.resumo(item));
          if (Object.keys(d.depois).length) registrar(store, { empresaId: eid, entidade: 'conhecimento', entidadeId: itemId, acao: 'editada', ...ator, ...d });
          return responder(res, 200, conhecimento.publica(eid, item));
        }
        if (partes.length === 4 && req.method === 'DELETE') {
          if (!staff) return responder(res, 403, { erro: 'sem permissão' });
          const item = conhecimento.excluir(store, eid, itemId);
          registrar(store, { empresaId: eid, entidade: 'conhecimento', entidadeId: itemId, acao: 'excluida', ...ator, antes: conhecimento.resumo(item), depois: {} });
          return responder(res, 200, { excluido: true, id: itemId });
        }
        if (partes.length === 5 && partes[4] === 'arquivo' && req.method === 'GET') {
          const a = conhecimento.arquivoDe(store, eid, itemId);
          res.writeHead(200, {
            'Content-Type': a.mime,
            'Content-Length': a.buffer.length,
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.nome)}`,
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': 'sandbox',
          });
          return res.end(a.buffer);
        }
      }
      if (partes[0] !== 'empresas' || partes.length !== 3) return responder(res, 404, { erro: 'rota inexistente' });
      const empresaId = decodeURIComponent(partes[1]);
      const recurso = partes[2];
      if (RECURSOS_RESERVAS.includes(recurso) && !moduloLigado(store, empresaId, 'reservas')) {
        return responder(res, 404, { erro: 'recurso "reservas" não habilitado para esta empresa' });
      }

      // GET /empresas/:id/recursos: o que esta empresa usa e quais endereços o sistema de conversa pode chamar
      if (recurso === 'recursos' && req.method === 'GET') {
        return responder(res, 200, recursosDe(empresa(store, empresaId)));
      }
      // GET /empresas/:id/contexto: tudo o que o agente precisa em uma chamada (config, conhecimento, recursos e prompt pronto)
      if (recurso === 'contexto' && req.method === 'GET') {
        return responder(res, 200, contexto(store, empresaId));
      }
      // PATCH /empresas/:id/modulos { reservas?, conhecimento? }: liga ou desliga recursos (os dados são mantidos)
      if (recurso === 'modulos' && req.method === 'PATCH') {
        if (!staff) return responder(res, 403, { erro: 'sem permissão' });
        const e = empresa(store, empresaId);
        const vm = validarModulos(await lerCorpo(req));
        if (vm.erro) return responder(res, 400, { erro: vm.erro });
        if (Object.keys(vm.modulos).length === 0) return responder(res, 400, { erro: 'nenhum módulo informado' });
        const antes = Object.fromEntries(MODULOS.map((m) => [`modulo_${m}`, e.modulos[m]]));
        Object.assign(e.modulos, vm.modulos);
        const d = diff(antes, Object.fromEntries(MODULOS.map((m) => [`modulo_${m}`, e.modulos[m]])));
        if (Object.keys(d.depois).length) registrar(store, { empresaId: e.id, entidade: 'empresa', entidadeId: e.id, acao: 'editada', ...quem(req, papel), ...d });
        return responder(res, 200, { ...e.modulos });
      }

      if (recurso === 'agente' && req.method === 'GET') {
        return responder(res, 200, lerConfig(store, empresaId));
      }
      // PATCH /empresas/:id/agente  { campos: { descricao, personalidade, habilidades, produtos, restricoes } } (tudo ou nada)
      // ou, por compatibilidade, { campo, valor }
      if (recurso === 'agente' && req.method === 'PATCH') {
        if (!staff) return responder(res, 403, { erro: 'sem permissão' });
        const b = await lerCorpo(req);
        const mud = b.campos && typeof b.campos === 'object' && !Array.isArray(b.campos) ? b.campos : { [b.campo]: b.valor };
        const antesCfg = lerConfig(store, empresaId);
        atualizarVarios(store, empresaId, mud, papel);
        const cfg = lerConfig(store, empresaId);
        const ator = quem(req, papel);
        for (const campo of Object.keys(mud)) {
          const da = diff({ [campo]: antesCfg[campo] }, { [campo]: cfg[campo] });
          if (Object.keys(da.depois).length) registrar(store, { empresaId, entidade: 'agente', entidadeId: campo, acao: 'editada', ...ator, ...da });
        }
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
        const r = reservar(store, { empresaId, data: b.data, horario: b.horario, pessoas: b.pessoas, ambiente: b.ambiente, mesaId: b.mesaId, chave: String(chave), nomeCliente: b.nomeCliente, contato: b.contato });
        if (r.status === 'confirmada' && store.reservas.length > antesN) {
          registrar(store, { empresaId, entidade: 'reserva', entidadeId: r.reservaId, acao: 'criada', ...quem(req, papel), depois: publica(store.reservas[store.reservas.length - 1]) });
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
        return responder(res, 200, disponibilidade(store, empresaId, data, horario, pessoas, Number.isInteger(ign) && ign > 0 ? ign : undefined));
      }
      if (recurso === 'reservas' && req.method === 'GET') {
        if (!staff) return responder(res, 403, { erro: 'sem permissão' });
        empresa(store, empresaId);
        const data = url.searchParams.get('data');
        return responder(res, 200, store.reservas
          .filter((r) => r.empresaId === empresaId && (!data || r.data === data))
          .map(publica));
      }
      if (recurso === 'historico' && req.method === 'GET') {
        if (!staff) return responder(res, 403, { erro: 'sem permissão' });
        empresa(store, empresaId);
        return responder(res, 200, listar(store, empresaId, { entidade: url.searchParams.get('entidade'), entidadeId: url.searchParams.get('id'), limite: url.searchParams.get('limite') }));
      }
      // POST /empresas/:id/excluir { senha, confirmarNome }: exige a senha do administrador. Irreversível; grava instantâneo no histórico.
      if (recurso === 'excluir' && req.method === 'POST') {
        if (!staff) return responder(res, 403, { erro: 'sem permissão' });
        const l = empresa(store, empresaId);
        if (!adminSenha) return responder(res, 503, { erro: 'exclusão de empresa desativada: a senha do administrador não está configurada no servidor' });
        const agora = Date.now();
        const tent = store.tentativasAdmin || (store.tentativasAdmin = { n: 0, ate: 0 });
        if (tent.ate > agora) return responder(res, 429, { erro: `muitas tentativas incorretas; tente de novo em ${Math.ceil((tent.ate - agora) / 60000)} min` });
        const b = await lerCorpo(req);
        const ator = quem(req, papel);
        if (typeof b.senha !== 'string' || !iguais(hashChave(b.senha), hashChave(adminSenha))) {
          tent.n++;
          if (tent.n >= 5) { tent.ate = agora + 15 * 60000; tent.n = 0; }
          registrar(store, { empresaId: l.id, entidade: 'empresa', entidadeId: l.id, acao: 'exclusao_negada', ...ator });
          return responder(res, 403, { erro: 'senha do administrador incorreta' });
        }
        tent.n = 0;
        if (b.confirmarNome !== l.nome) return responder(res, 400, { erro: 'digite o nome exato da empresa para confirmar' });
        const instantaneo = {
          nome: l.nome, agente: lerConfig(store, l.id), ambientes: l.ambientes, chaveApiAtiva: !!l.chave, modulos: { ...l.modulos },
          conhecimento: l.conhecimento.map(conhecimento.resumo),
          reservas: store.reservas.filter((r) => r.empresaId === l.id).map(publica),
        };
        store.empresas.delete(l.id);
        store.reservas = store.reservas.filter((r) => r.empresaId !== l.id);
        for (const k of [...store.chaves.keys()]) if (k.startsWith(`${l.id}:`)) store.chaves.delete(k);
        registrar(store, { empresaId: l.id, entidade: 'empresa', entidadeId: l.id, acao: 'excluida', ...ator, antes: instantaneo, depois: {} });
        return responder(res, 200, { excluida: true, id: l.id, nome: l.nome });
      }
      // POST /empresas/:id/ambientes { nome }
      if (recurso === 'ambientes' && req.method === 'POST') {
        if (!staff) return responder(res, 403, { erro: 'sem permissão' });
        const l = empresa(store, empresaId);
        const b = await lerCorpo(req);
        const nome = typeof b.nome === 'string' ? b.nome.trim() : '';
        if (!nome || [...nome].length > 40) return responder(res, 400, { erro: 'nome do ambiente deve ter de 1 a 40 caracteres' });
        if (l.ambientes.some((a) => a.nome.toLowerCase() === nome.toLowerCase())) return responder(res, 409, { erro: 'já existe um ambiente com esse nome' });
        l.ambientes.push({ nome, mesas: [] });
        registrar(store, { empresaId: l.id, entidade: 'ambiente', entidadeId: nome, acao: 'criada', ...quem(req, papel), depois: { nome } });
        return responder(res, 201, { nome, mesas: [] });
      }
      // POST /empresas/:id/mesas { ambiente, capacidade, reservavel? }
      if (recurso === 'mesas' && req.method === 'POST') {
        if (!staff) return responder(res, 403, { erro: 'sem permissão' });
        const l = empresa(store, empresaId);
        const b = await lerCorpo(req);
        const amb = l.ambientes.find((a) => a.nome === b.ambiente);
        if (!amb) return responder(res, 404, { erro: 'ambiente inexistente' });
        if (!Number.isInteger(b.capacidade) || b.capacidade < 1 || b.capacidade > 100) return responder(res, 400, { erro: 'capacidade inválida' });
        const base = (amb.nome.match(/[A-Za-z]/) || ['M'])[0].toUpperCase();
        const existentes = new Set(l.ambientes.flatMap((a) => a.mesas.map((m) => m.id)));
        let n = 1;
        while (existentes.has(`${base}${n}`)) n++;
        const mesa = { id: `${base}${n}`, capacidade: b.capacidade, reservavel: b.reservavel !== false };
        amb.mesas.push(mesa);
        registrar(store, { empresaId: l.id, entidade: 'mesa', entidadeId: mesa.id, acao: 'criada', ...quem(req, papel), depois: { ambiente: amb.nome, capacidade: mesa.capacidade, reservavel: mesa.reservavel } });
        return responder(res, 201, mesa);
      }
      if (recurso === 'estrutura' && req.method === 'GET') {
        if (!staff) return responder(res, 403, { erro: 'sem permissão' });
        const l = empresa(store, empresaId);
        return responder(res, 200, { id: l.id, nome: l.nome, ambientes: l.ambientes, modulos: { ...l.modulos } });
      }
      if (recurso === 'mapa' && req.method === 'GET') {
        if (!staff) return responder(res, 403, { erro: 'sem permissão' });
        const data = url.searchParams.get('data'), horario = url.searchParams.get('horario');
        if (!data || !horario) return responder(res, 400, { erro: 'data e horario obrigatórios' });
        return responder(res, 200, mapa(store, empresaId, data, horario));
      }
      return responder(res, 404, { erro: 'rota inexistente' });
    } catch (e) {
      const codigo = e.codigo || (e instanceof Error && !e.codigo ? 400 : 500);
      return responder(res, codigo, { erro: e.message });
    }
  });
}

module.exports = { criarServidor };
