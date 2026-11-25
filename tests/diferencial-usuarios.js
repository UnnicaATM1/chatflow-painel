// Teste diferencial de usuários (não faz parte do npm test): o mesmo roteiro contra o servidor JS e o binário Rust.
// Compara status e corpo, normalizando ids, tokens de sessão e datas. Uso: node tests/diferencial-usuarios.js
// (precisa do binário: cargo build --release -p one-node dentro de rust/). Sai com código 1 se houver diferença.
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const RAIZ = path.join(__dirname, '..');
const RUST = process.env.CHATFLOW_RUST || path.join(RAIZ, 'rust', 'target', 'release', process.platform === 'win32' ? 'one-node.exe' : 'one-node');
const SENHA = 'senha-forte-123';

const livre = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
async function subir(cmd) {
  const porta = await livre();
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: String(porta), CHATFLOW_TOKEN_CLIENTE: 'tcl', CHATFLOW_TOKEN_INTEGRACAO: 'ti', CHATFLOW_ADMIN_SENHA: 'admin-env' };
  const f = spawn(cmd[0], cmd.slice(1), { env, cwd: RAIZ, stdio: ['ignore', 'ignore', 'inherit'] });
  for (let i = 0; i < 200; i++) { try { if ((await fetch(`http://127.0.0.1:${porta}/saude`)).status === 200) break; } catch { /* ainda subindo */ } await new Promise((r) => setTimeout(r, 25)); }
  return { base: `http://127.0.0.1:${porta}`, parar: () => f.kill() };
}

const norm = (v) => JSON.parse(JSON.stringify(v)
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
  .replace(/s1_[A-Za-z0-9_-]+/g, '<token>')
  .replace(/k1_[A-Za-z0-9_-]+/g, '<chave>')
  .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '<t>')
  .replace(/"boot":"[^"]*"/g, '"boot":"<b>"'));

async function roteiro(base) {
  const t = [];
  const chamar = async (rotulo, metodo, caminho, { token, corpo, headers } = {}) => {
    const r = await fetch(base + caminho, { method: metodo, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(corpo !== undefined ? { 'content-type': 'application/json' } : {}), ...(headers || {}) },
      body: corpo !== undefined ? JSON.stringify(corpo) : undefined });
    let j = null; try { j = await r.json(); } catch { /* sem corpo */ }
    t.push([rotulo, r.status, norm(j)]);
    return { status: r.status, corpo: j };
  };
  const su = { token: 'ti' };
  const e1 = (await chamar('empresa 1', 'POST', '/empresas', { ...su, corpo: { nome: 'Alfa' } })).corpo.id;
  const e2 = (await chamar('empresa 2', 'POST', '/empresas', { ...su, corpo: { nome: 'Beta' } })).corpo.id;
  const novo = (n, papel, empresas) => chamar('criar ' + n, 'POST', '/usuarios', { ...su, corpo: { nome: n, email: `${n.toLowerCase()}@x.com`, papel, senha: SENHA, empresas } });
  const ana = (await novo('Ana', 'equipe', [e1])).corpo;
  await novo('Bia', 'admin', [e1]);
  const cris = (await novo('Cris', 'superadmin', [])).corpo;
  await chamar('email repetido', 'POST', '/usuarios', { ...su, corpo: { nome: 'X', email: 'ana@x.com', papel: 'equipe', senha: SENHA } });
  await chamar('senha curta', 'POST', '/usuarios', { ...su, corpo: { nome: 'X', email: 'x@x.com', papel: 'equipe', senha: 'curta' } });
  await chamar('papel inválido', 'POST', '/usuarios', { ...su, corpo: { nome: 'X', email: 'x@x.com', papel: 'dono', senha: SENHA } });
  await chamar('e-mail inválido', 'POST', '/usuarios', { ...su, corpo: { nome: 'X', email: 'x@x', papel: 'equipe', senha: SENHA } });
  await chamar('empresa inexistente', 'POST', '/usuarios', { ...su, corpo: { nome: 'X', email: 'x@x.com', papel: 'equipe', senha: SENHA, empresas: ['nada'] } });
  await chamar('equipe do env não cria usuário', 'POST', '/usuarios', { token: 'tcl', corpo: { nome: 'X', email: 'x@x.com', papel: 'equipe', senha: SENHA } });
  await chamar('lista', 'GET', '/usuarios', su);
  const entrar = (n, s = SENHA) => chamar('login ' + n, 'POST', '/login', { corpo: { email: `${n.toLowerCase()}@x.com`, senha: s } });
  const ta = (await entrar('Ana')).corpo.token;
  await entrar('Ana', 'errada-errada');
  await chamar('login inexistente', 'POST', '/login', { corpo: { email: 'nada@x.com', senha: SENHA } });
  await chamar('login sem corpo', 'POST', '/login', { corpo: {} });
  await chamar('ana /eu', 'GET', '/eu', { token: ta });
  await chamar('ana lista empresas', 'GET', '/empresas', { token: ta });
  await chamar('ana empresa liberada', 'GET', `/empresas/${e1}/agente`, { token: ta });
  await chamar('ana empresa fora', 'GET', `/empresas/${e2}/agente`, { token: ta });
  await chamar('ana histórico', 'GET', `/empresas/${e1}/historico`, { token: ta });
  await chamar('ana api', 'GET', `/empresas/${e1}/api`, { token: ta });
  await chamar('ana usuarios', 'GET', '/usuarios', { token: ta });
  await chamar('ana cria empresa', 'POST', '/empresas', { token: ta, corpo: { nome: 'Nova' } });
  await chamar('ana excluídas', 'GET', '/historico/excluidas', { token: ta });
  await chamar('ana config sem reautenticar', 'PATCH', `/empresas/${e1}`, { token: ta, corpo: { nome: 'Alfa 2' } });
  await chamar('ana reautentica errado', 'POST', '/eu/reautenticar', { token: ta, corpo: { senha: 'errada-errada' } });
  await chamar('ana reautentica', 'POST', '/eu/reautenticar', { token: ta, corpo: { senha: SENHA } });
  await chamar('ana config', 'PATCH', `/empresas/${e1}`, { token: ta, corpo: { nome: 'Alfa 2' } });
  await chamar('ana módulos', 'PATCH', `/empresas/${e1}/modulos`, { token: ta, corpo: { conhecimento: false } });
  await chamar('ana exclui', 'POST', `/empresas/${e1}/excluir`, { token: ta, corpo: { senha: SENHA, confirmarNome: 'Alfa 2' } });
  const tb = (await entrar('Bia')).corpo.token;
  await chamar('bia reautentica', 'POST', '/eu/reautenticar', { token: tb, corpo: { senha: SENHA } });
  await chamar('bia config com X-Operador', 'PATCH', `/empresas/${e1}`, { token: tb, corpo: { nome: 'Alfa Bia' }, headers: { 'x-operador': 'Cris' } });
  await chamar('bia histórico', 'GET', `/empresas/${e1}/historico`, { token: tb });
  await chamar('bia api', 'GET', `/empresas/${e1}/api`, { token: tb });
  const tc = (await entrar('Cris')).corpo.token;
  await chamar('cris config direto', 'PATCH', `/empresas/${e1}`, { token: tc, corpo: { nome: 'Alfa Cris' } });
  await chamar('cris api', 'POST', `/empresas/${e1}/api/chave`, { token: tc });
  await chamar('cris excluídas', 'GET', '/historico/excluidas', { token: tc });
  await chamar('desativar ana', 'PATCH', `/usuarios/${ana.id}`, { ...su, corpo: { ativo: false } });
  await chamar('ana derrubada', 'GET', '/eu', { token: ta });
  await chamar('ana inativa não entra', 'POST', '/login', { corpo: { email: 'ana@x.com', senha: SENHA } });
  await chamar('último superadmin ativo', 'PATCH', `/usuarios/${cris.id}`, { ...su, corpo: { ativo: false } });
  await chamar('último superadmin papel', 'PATCH', `/usuarios/${cris.id}`, { ...su, corpo: { papel: 'admin' } });
  await chamar('patch inválido', 'PATCH', `/usuarios/${cris.id}`, { ...su, corpo: { papel: 'dono' } });
  await chamar('patch empresas', 'PATCH', `/usuarios/${cris.id}`, { ...su, corpo: { nome: 'Cris B', empresas: [e1, e2] } });
  await chamar('usuário inexistente', 'PATCH', '/usuarios/nao-existe', { ...su, corpo: { nome: 'x' } });
  const tb2 = (await entrar('Bia')).corpo.token;
  await chamar('trocar senha errada', 'POST', '/eu/senha', { token: tb, corpo: { atual: 'errada-errada', nova: 'nova-senha-123' } });
  await chamar('trocar senha curta', 'POST', '/eu/senha', { token: tb, corpo: { atual: SENHA, nova: 'curta' } });
  await chamar('trocar senha', 'POST', '/eu/senha', { token: tb, corpo: { atual: SENHA, nova: 'nova-senha-123' } });
  await chamar('bia mantém', 'GET', '/eu', { token: tb });
  await chamar('bia outra sessão cai', 'GET', '/eu', { token: tb2 });
  await chamar('redefinir', 'POST', `/usuarios/${cris.id}/senha`, { ...su, corpo: { senha: 'redefinida-123' } });
  await chamar('cris derrubada', 'GET', '/eu', { token: tc });
  await chamar('bia logout', 'POST', '/logout', { token: tb });
  await chamar('bia após logout', 'GET', '/eu', { token: tb });
  await chamar('env /eu integração', 'GET', '/eu', su);
  await chamar('env /eu cliente', 'GET', '/eu', { token: 'tcl' });
  await chamar('env cliente histórico', 'GET', `/empresas/${e1}/historico`, { token: 'tcl' });
  const k = await chamar('gerar chave', 'POST', `/empresas/${e1}/api/chave`, su);
  await chamar('chave lê agente', 'GET', `/empresas/${e1}/agente`, { token: k.corpo.chave });
  await chamar('chave /eu', 'GET', '/eu', { token: k.corpo.chave });
  await chamar('exclui com senha global (token env)', 'POST', `/empresas/${e2}/excluir`, { ...su, corpo: { senha: 'admin-env', confirmarNome: 'Beta' } });
  return t;
}

(async () => {
  const js = await subir(['node', 'src/server.js']);
  const rs = await subir([RUST]);
  let a, b;
  try { a = await roteiro(js.base); b = await roteiro(rs.base); } finally { js.parar(); rs.parar(); }
  let dif = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = JSON.stringify(a[i]), y = JSON.stringify(b[i]);
    if (x !== y) { dif++; console.log('DIFERENÇA', i, '\n  JS  :', x, '\n  Rust:', y); }
  }
  console.log(`${a.length} chamadas comparadas, ${dif} diferença(s).`);
  process.exit(dif ? 1 : 0);
})();
