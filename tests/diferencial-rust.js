// Teste diferencial (não faz parte do npm test): mesmo roteiro de requisições contra o servidor JS e o binário Rust; compara status, cabeçalhos
// relevantes e corpo (normalizando o que muda sozinho: boot, quando, chave gerada, datas de criação).
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const RAIZ = path.join(__dirname, '..');
// Binário Rust: CHATFLOW_RUST ou o build release do workspace (cargo build --release dentro de rust/).
const RUST = process.env.CHATFLOW_RUST || path.join(RAIZ, 'rust', 'target', 'release', process.platform === 'win32' ? 'one-node.exe' : 'one-node');

const livre = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
// Uso: node tests/diferencial-rust.js   (precisa do binário Rust compilado). Sai com código 1 se houver diferença.
async function subir(cmd) {
  const porta = await livre();
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: String(porta), CHATFLOW_DEMO: '1', CHATFLOW_TOKEN_CLIENTE: 'tcl', CHATFLOW_TOKEN_INTEGRACAO: 'ti', CHATFLOW_TOKEN_CHAT: 'tc', CHATFLOW_ADMIN_SENHA: 'adm-1' };
  const f = spawn(cmd[0], cmd.slice(1), { env, cwd: RAIZ, stdio: ['ignore', 'ignore', 'inherit'] });
  for (let i = 0; i < 200; i++) { try { if ((await fetch(`http://127.0.0.1:${porta}/saude`)).status === 200) break; } catch {} await new Promise((r) => setTimeout(r, 25)); }
  return { base: `http://127.0.0.1:${porta}`, parar: () => f.kill() };
}

const T = { cl: 'tcl', int: 'ti', chat: 'tc' };
const pdf = Buffer.from('%PDF-1.4 fake').toString('base64');
const roteiro = [
  ['GET', '/saude'], ['GET', '/empresas'], ['GET', '/empresas', { t: 'x' }], ['GET', '/empresas', { t: T.cl }],
  ['GET', '/empresas/empresa_1/estrutura', { t: T.cl }], ['GET', '/empresas/empresa_1/agente', { t: T.chat }],
  ['GET', '/empresas/%E0%A4%A/agente', { t: T.chat }], ['GET', '/empresas/empresa_9/agente', { t: T.chat }],
  ['PATCH', '/empresas/empresa_1/agente', { t: T.cl, b: { campos: { descricao: 'Nova descrição', habilidades: 'x' } } }],
  ['PATCH', '/empresas/empresa_1/agente', { t: T.cl, b: { campo: 'nome', valor: 'Bia' } }],
  ['PATCH', '/empresas/empresa_1/agente', { t: T.cl, b: { campos: {} } }],
  ['PATCH', '/empresas/empresa_1/agente', { t: T.cl, b: { campos: { descricao: 5 } } }],
  ['PATCH', '/empresas/empresa_1/agente', { t: T.cl, b: { campos: { zzz: 'a' } } }],
  ['PATCH', '/empresas/empresa_1/agente', { t: T.cl, b: {} }],
  ['PATCH', '/empresas/empresa_1/agente', { t: T.chat, b: { campo: 'nome', valor: 'x' } }],
  ['PATCH', '/empresas/empresa_1/agente', { t: T.int, b: { campos: { personalidade: 'é'.repeat(2001) } } }],
  ['GET', '/empresas/empresa_1/disponibilidade?data=2026-11-20&horario=20:00&pessoas=2', { t: T.chat }],
  ['GET', '/empresas/empresa_1/disponibilidade?data=2026-11-20&horario=20:00&pessoas=2.0', { t: T.chat }],
  ['GET', '/empresas/empresa_1/disponibilidade?data=2026-11-20&horario=20:00&pessoas=0', { t: T.chat }],
  ['GET', '/empresas/empresa_1/disponibilidade?data=2026-11-20&horario=20:00&pessoas=2&ignorar=', { t: T.chat }], ['GET', '/empresas/empresa_1/disponibilidade?data=2026-11-20&horario=20:00&pessoas=2&ignorar=1', { t: T.chat }],
  ['DELETE', '/empresas/empresa_1/reservas/', { t: T.cl }], ['DELETE', '/empresas/empresa_1/reservas/%E0', { t: T.cl }], ['DELETE', '/empresas/empresa_1/reservas/22222222', { t: T.cl }],
  ['GET', '/empresas/empresa_1/disponibilidade?data=2026-02-30&horario=20:00&pessoas=2', { t: T.chat }],
  ['POST', '/empresas/empresa_1/reservas', { t: T.chat, b: { data: '2026-11-20', horario: '20:00', pessoas: 2, ambiente: 'salao', nomeCliente: ' Ana ', contato: '+55 11 9' }, h: { 'idempotency-key': 'a1' } }],
  ['POST', '/empresas/empresa_1/reservas', { t: T.chat, b: { data: '2026-11-20', horario: '20:00', pessoas: 2, ambiente: 'salao' }, h: { 'idempotency-key': 'a1' } }],
  ['POST', '/empresas/empresa_1/reservas', { t: T.chat, b: { data: '2026-11-20', horario: '20:00', pessoas: 2, ambiente: 'salao', mesaId: 'S1' }, h: { 'idempotency-key': 'a2' } }],
  ['POST', '/empresas/empresa_1/reservas', { t: T.chat, b: { data: '2026-11-20', horario: '20:00', pessoas: 5, ambiente: 'salao' }, h: { 'idempotency-key': 'a3' } }],
  ['POST', '/empresas/empresa_1/reservas', { t: T.chat, b: { data: '2026-11-20', horario: '20:00', pessoas: 6, ambiente: 'salao' }, h: { 'idempotency-key': 'a4' } }],
  ['POST', '/empresas/empresa_1/reservas', { t: T.chat, b: { data: '2026-11-20', horario: '20:00', pessoas: 4.5 }, h: { 'idempotency-key': 'a5' } }],
  ['POST', '/empresas/empresa_1/reservas', { t: T.chat, b: { data: '2026-11-20', horario: '20:00', pessoas: 2, nomeCliente: 7 }, h: { 'idempotency-key': 'a6' } }],
  ['POST', '/empresas/empresa_1/reservas', { t: T.chat, b: { data: '2026-11-20', horario: '20:00', pessoas: 2, ambiente: 'nao-existe' }, h: { 'idempotency-key': 'a7' } }],
  ['POST', '/empresas/empresa_1/reservas', { t: T.chat, b: { data: '20/11', horario: '20:00', pessoas: 2 }, h: { 'idempotency-key': 'a8' } }],
  ['POST', '/empresas/empresa_1/reservas', { t: T.chat, b: { data: '2026-11-20', horario: '20:00', pessoas: 2 } }],
  ['POST', '/empresas/empresa_1/reservas', { t: T.chat, raw: '{ruim', h: { 'idempotency-key': 'a9' } }],
  ['GET', '/empresas/empresa_1/reservas', { t: T.cl }], ['GET', '/empresas/empresa_1/reservas?data=2026-11-20', { t: T.cl }],
  ['GET', '/empresas/empresa_1/mapa?data=2026-11-20&horario=20:30', { t: T.cl }], ['GET', '/empresas/empresa_1/mapa?data=2026-11-20', { t: T.cl }],
  ['PATCH', '/empresas/empresa_1/reservas/{R1}', { t: T.cl, b: { pessoas: 3 } }], ['PATCH', '/empresas/empresa_1/reservas/{R1}', { t: T.cl, b: { horario: '21:00', mesaId: 'S2' } }],
  ['PATCH', '/empresas/empresa_1/reservas/{R1}', { t: T.cl, b: { pessoas: null } }], ['PATCH', '/empresas/empresa_1/reservas/{R1}', { t: T.cl, b: { data: 'x' } }],
  ['PATCH', '/empresas/empresa_1/reservas/99', { t: T.cl, b: { pessoas: 3 } }], ['PATCH', '/empresas/empresa_1/reservas/abc', { t: T.cl, b: { pessoas: 3 } }],
  ['DELETE', '/empresas/empresa_1/reservas/{R1}', { t: T.cl }], ['PATCH', '/empresas/empresa_1/reservas/{R1}', { t: T.cl, b: { pessoas: 2 } }],
  ['PATCH', '/empresas/empresa_1/reservas/{R1}', { t: T.cl, b: { status: 'confirmada' }, h: { 'x-operador': 'Mari%C3%A1' } }],
  ['GET', '/empresas/empresa_1/historico', { t: T.cl }], ['GET', '/empresas/empresa_1/historico?entidade=reserva&id={R1}&limite=2', { t: T.cl }],
  ['POST', '/empresas/empresa_1/historico/6/desfazer', { t: T.cl }], ['POST', '/empresas/empresa_1/historico/6/desfazer', { t: T.cl }], ['POST', '/empresas/empresa_1/historico/xx/desfazer', { t: T.cl }],
  ['POST', '/empresas', { t: T.cl, b: { nome: 'Oficina Sul', modulos: { reservas: false } } }], ['POST', '/empresas', { t: T.cl, b: { nome: 'oficina sul' } }],
  ['POST', '/empresas', { t: T.cl, b: { nome: '' } }], ['POST', '/empresas', { t: T.cl, b: { nome: 'Z', modulos: { x: true } } }], ['POST', '/empresas', { t: T.cl, b: { nome: 'Z', modulos: { reservas: 'sim' } } }],
  ['PATCH', '/empresas/empresa_4', { t: T.cl, b: { nome: 'Oficina Norte' } }],
  ['PATCH', '/empresas/empresa_4/modulos', { t: T.cl, b: { conhecimento: false } }], ['PATCH', '/empresas/empresa_4/modulos', { t: T.cl, b: {} }],
  ['GET', '/empresas/empresa_4/reservas', { t: T.cl }], ['GET', '/empresas/empresa_4/recursos', { t: T.chat }], ['GET', '/empresas/empresa_1/recursos', { t: T.chat }],
  ['POST', '/empresas/empresa_1/ambientes', { t: T.cl, b: { nome: 'Varanda' } }], ['POST', '/empresas/empresa_1/ambientes', { t: T.cl, b: { nome: 'varanda' } }],
  ['POST', '/empresas/empresa_1/mesas', { t: T.cl, b: { ambiente: 'Varanda', capacidade: 8 } }], ['POST', '/empresas/empresa_1/mesas', { t: T.cl, b: { ambiente: 'Varanda', capacidade: 0 } }],
  ['POST', '/empresas/empresa_1/mesas', { t: T.cl, b: { ambiente: 'x', capacidade: 2 } }],
  ['PATCH', '/empresas/empresa_1/mesas/S2', { t: T.cl, b: { descricao: '  Encostada na parede do bar, com visão para a entrada  ' } }], ['PATCH', '/empresas/empresa_1/mesas/S2', { t: T.cl, b: { descricao: 'á'.repeat(151) } }], ['PATCH', '/empresas/empresa_1/mesas/S2', { t: T.cl, b: { descricao: 'a\nb' } }], ['PATCH', '/empresas/empresa_1/mesas/S2', { t: T.cl, b: { descricao: null } }],
  ['POST', '/empresas/empresa_1/mesas', { t: T.cl, b: { ambiente: 'Varanda', capacidade: 2, descricao: 'Perto da área verde' } }], ['POST', '/empresas/empresa_1/mesas', { t: T.cl, b: { ambiente: 'Varanda', capacidade: 2, descricao: 7 } }],
  ['GET', '/empresas/empresa_1/estrutura', { t: T.cl }], ['GET', '/empresas/empresa_1/mapa?data=2026-11-20&horario=20:30', { t: T.cl }], ['GET', '/empresas/empresa_1/disponibilidade?data=2026-11-21&horario=20:00&pessoas=2', { t: T.chat }],
  ['POST', '/empresas/empresa_1/reservas', { t: T.chat, b: { data: '2026-11-21', horario: '20:00', pessoas: 2, mesaId: 'ZZ' }, h: { 'idempotency-key': 'desc-1' } }],
  ['GET', '/empresas/empresa_1/historico?entidade=mesa', { t: T.cl }], ['PATCH', '/empresas/empresa_1/mesas/S2', { t: T.cl, b: { descricao: '' } }],
  ['PATCH', '/empresas/empresa_1/mesas/S1', { t: T.cl, b: { capacidade: 6, reservavel: false } }], ['PATCH', '/empresas/empresa_1/mesas/S1', { t: T.cl, b: { capacidade: 'a' } }], ['PATCH', '/empresas/empresa_1/mesas/ZZ', { t: T.cl, b: {} }],
  ['POST', '/empresas/empresa_1/api/chave', { t: T.cl, b: {} }], ['GET', '/empresas/empresa_1/api', { t: T.int }], ['DELETE', '/empresas/empresa_1/api/chave', { t: T.int }], ['GET', '/empresas/empresa_1/api', { t: T.int }],
  ['POST', '/empresas/empresa_1/conhecimento', { t: T.cl, b: { tipo: 'tabela', titulo: 'Preços', tabela: { colunas: ['Item', 'Preço', 3], linhas: [['Lasanha', 'R$ 48 | médio'], ['Pizza', 59.9]] } } }],
  ['POST', '/empresas/empresa_1/conhecimento', { t: T.cl, b: { tipo: 'texto', titulo: 'Horários', texto: 'Aberto de terça a domingo.\n\nSegunda fechado.\nAlmoço das 12h às 15h' } }],
  ['POST', '/empresas/empresa_1/conhecimento', { t: T.cl, b: { tipo: 'documento', titulo: 'Cardápio', arquivo: { nome: 'dir/Cardápio 1.txt', base64: Buffer.from('Pizza de calabresa custa 50\nRefri 8').toString('base64') } } }],
  ['POST', '/empresas/empresa_1/conhecimento', { t: T.cl, b: { tipo: 'documento', titulo: 'Manual', arquivo: { nome: 'manual.pdf', base64: pdf } } }],
  ['POST', '/empresas/empresa_1/conhecimento', { t: T.cl, b: { tipo: 'documento', titulo: 'x', arquivo: { nome: 'x.exe', base64: pdf } } }],
  ['POST', '/empresas/empresa_1/conhecimento', { t: T.cl, b: { tipo: 'tabela', titulo: 't', tabela: { colunas: ['a'], linhas: [['1', '2']] } } }],
  ['POST', '/empresas/empresa_1/conhecimento', { t: T.cl, b: { tipo: 'outro', titulo: 't' } }],
  ['GET', '/empresas/empresa_1/conhecimento', { t: T.chat }], ['GET', '/empresas/empresa_1/conhecimento/1', { t: T.chat }], ['GET', '/empresas/empresa_1/conhecimento/99', { t: T.chat }],
  ['GET', '/empresas/empresa_1/conhecimento/3/arquivo', { t: T.chat, ver: ['content-type', 'content-disposition', 'x-content-type-options', 'content-security-policy'] }],
  ['GET', '/empresas/empresa_1/conhecimento/buscar?q=lasanha', { t: T.chat }], ['GET', '/empresas/empresa_1/conhecimento/buscar?q=quanto%20custa%20a%20pizza%3F', { t: T.chat }],
  ['GET', '/empresas/empresa_1/conhecimento/buscar?q=horarios+de+funcionamento', { t: T.chat }], ['GET', '/empresas/empresa_1/conhecimento/buscar?q=de%20para', { t: T.chat }],
  ['GET', '/empresas/empresa_1/conhecimento/buscar?q=', { t: T.chat }], ['GET', '/empresas/empresa_1/conhecimento/buscar?q=pizza&limite=1', { t: T.chat }],
  ['PATCH', '/empresas/empresa_1/conhecimento/2', { t: T.cl, b: { titulo: 'Horários 2', texto: 'Novo texto' } }], ['PATCH', '/empresas/empresa_1/conhecimento/2', { t: T.cl, b: {} }],
  ['PATCH', '/empresas/empresa_1/conhecimento/3', { t: T.cl, b: { arquivo: { nome: 'a.pdf', base64: pdf } } }],
  ['DELETE', '/empresas/empresa_1/conhecimento/1', { t: T.cl }], ['GET', '/empresas/empresa_1/contexto', { t: T.chat }], ['GET', '/empresas/empresa_2/contexto', { t: T.chat }],
  ['POST', '/empresas/empresa_3/excluir', { t: T.cl, b: { senha: 'errada', confirmarNome: 'Empresa 3' } }], ['POST', '/empresas/empresa_3/excluir', { t: T.cl, b: { senha: 'adm-1', confirmarNome: 'x' } }],
  ['POST', '/empresas/empresa_3/excluir', { t: T.cl, b: { senha: 'adm-1', confirmarNome: 'Empresa 3' } }], ['GET', '/historico/excluidas', { t: T.cl }], ['GET', '/empresas/empresa_3/agente', { t: T.chat }],
  ['POST', '/empresas', { t: T.cl, b: { nome: 'Nova depois da exclusão' } }],
  ['GET', '/empresas/empresa_1/historico?limite=abc', { t: T.cl }], ['PUT', '/empresas/empresa_1/agente', { t: T.cl, b: {} }], ['GET', '/nada', { t: T.cl }],
  ['GET', '/app', { t: null, manual: true, ver: ['location'] }], ['GET', '/app/', { t: null, so: ['status', 'content-type'] }], ['GET', '/app/config.js', { t: null, so: ['status', 'content-type'] }], ['GET', '/app/x.js', { t: null }],
  ['OPTIONS', '/empresas', { t: null }],
];

// reservaId (TASK-012) é um código aleatório de 8 caracteres: o valor difere entre os servidores, só o formato e o papel contam.
// Cada código novo vira <R1>, <R2>... na ordem em que aparece; o mesmo código nunca vira dois marcadores.
const CODIGO = /^[2-9A-HJKMNP-Z]{8}$/;
function normalizar(v, codigos, chave) {
  if (Array.isArray(v)) return v.map((x) => normalizar(x, codigos, chave));
  if (typeof v === 'string' && (chave === 'reservaId' || chave === 'id' || chave === 'entidadeId') && CODIGO.test(v)) {
    if (!codigos.includes(v)) codigos.push(v);
    return `<R${codigos.indexOf(v) + 1}>`;
  }
  if (chave === 'reservaId' && typeof v !== 'object') return `<FORMATO INVÁLIDO: ${JSON.stringify(v)}>`;
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === 'boot') o[k] = '<boot>';
      else if (k === 'quando' || k === 'criadoEm' || k === 'atualizadoEm' || k === 'criadaEm') o[k] = '<data>';
      else if (k === 'chave' && typeof x === 'string' && x.startsWith('k1_')) o[k] = '<chave>';
      else if (k === 'prefixo' && typeof x === 'string' && x.startsWith('k1_')) o[k] = '<prefixo>';
      else o[k] = normalizar(x, codigos, k);
    }
    return o;
  }
  return v;
}

async function rodar(base) {
  const saida = [];
  const codigos = [];
  for (const [metodo, rotaModelo, o = {}] of roteiro) {
    const rota = rotaModelo.replace(/\{R(\d+)\}/g, (_, n) => codigos[n - 1] || 'ausente');
    const headers = { ...(o.t ? { Authorization: `Bearer ${o.t}` } : {}), ...(o.b || o.raw ? { 'Content-Type': 'application/json' } : {}), ...(o.h || {}) };
    const r = await fetch(base + rota, { method: metodo, headers, body: o.raw ?? (o.b ? JSON.stringify(o.b) : undefined), redirect: o.manual ? 'manual' : 'follow' });
    const tipo = r.headers.get('content-type') || '';
    let corpo;
    if (o.so) corpo = undefined;
    else if (tipo.startsWith('application/json')) corpo = normalizar(JSON.parse(await r.text()), codigos, '');
    else corpo = `<${(await r.arrayBuffer()).byteLength} bytes>`;
    const cab = Object.fromEntries((o.ver || []).map((h) => [h, r.headers.get(h)]));
    if (o.so) for (const h of o.so) if (h !== 'status') cab[h] = r.headers.get(h);
    saida.push({ req: `${metodo} ${rotaModelo}`, status: r.status, cab, corpo, ordem: corpo && typeof corpo === 'object' ? JSON.stringify(corpo) : corpo });
  }
  return saida;
}

(async () => {
  // CHATFLOW_DIF_A (array JSON do comando) troca o lado "JS": usar o próprio Rust nos dois lados prova que a normalização dos ids é estável.
  const js = await subir(process.env.CHATFLOW_DIF_A ? JSON.parse(process.env.CHATFLOW_DIF_A) : [process.execPath, path.join(RAIZ, 'src', 'server.js')]);
  const rs = await subir([RUST]);
  try {
    const a = await rodar(js.base);
    const b = await rodar(rs.base);
    let dif = 0;
    for (let i = 0; i < a.length; i++) {
      const x = JSON.stringify([a[i].status, a[i].cab, a[i].ordem]);
      const y = JSON.stringify([b[i].status, b[i].cab, b[i].ordem]);
      if (x !== y) {
        dif++;
        console.log(`\n#${i} ${a[i].req}\n  JS  : ${x.slice(0, 700)}\n  RUST: ${y.slice(0, 700)}`);
      }
    }
    console.log(`\n${a.length} requisições comparadas, ${dif} diferenças`);
  } finally { js.parar(); rs.parar(); }
})();
