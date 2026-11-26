// Rotas de sessão do usuário: /login, /logout, /eu, /eu/reautenticar e /eu/senha.
// Cada função devolve a resposta do núcleo ou null quando a rota não é dela (o despachante em nucleo.js segue adiante).
// Sem Node aqui: tudo que depende do ambiente vem do contexto (c.plat, c.store).
//
// c = { req, ctx, store, plat, resp, semPermissao, limitarLogin, hashChave, lerCorpo, ip,
//       auth, papel, partes, doUsuario, senhaDoUsuarioConfere }   (auth e seguintes só existem depois da autenticação)
import { conferirSenha, criarCredencial, normalizarEmail, validarSenhaNova } from './usuarios.js';

export const SESSAO_MS = 12 * 60 * 60 * 1000; // validade da sessão de usuário

// POST /login { email, senha }: sem autenticação prévia; resposta sempre genérica para falha
export async function rotaLogin(c) {
  const { req, ctx, store, plat, resp } = c;
  if (!(req.metodo === 'POST' && req.url.split('?')[0] === '/login')) return null;
  const b = await c.lerCorpo(req);
  const email = normalizarEmail(b.email);
  const bloqueio = c.limitarLogin('ip:' + c.ip, 'email:' + email);
  if (bloqueio) return bloqueio;
  const u = email && typeof b.senha === 'string' ? await store.usuarioPorEmail(email) : null;
  // Sem usuário, ainda gasta o mesmo tempo de derivação para não revelar se o e-mail existe.
  const credencialFalsa = u ? null : { salt: '00'.repeat(16), iteracoes: 100000, senhaHash: '0'.repeat(64) };
  const ok = await conferirSenha(b.senha, u || credencialFalsa, plat.iguaisTempoConstante);
  if (!u || !ok || !u.ativo) return resp(401, { erro: 'e-mail ou senha inválidos' });
  const token = 's1_' + plat.aleatorio(32);
  const agoraMs = ctx.agora();
  await store.sessaoCriar({ tokenHash: await c.hashChave(token), usuarioId: u.id, criadaEm: new Date(agoraMs).toISOString(), expiraEm: new Date(agoraMs + SESSAO_MS).toISOString() });
  await store.usuarioLoginMarcar(u.id, new Date(agoraMs).toISOString());
  return resp(200, { token, usuario: { id: u.id, nome: u.nome, email: u.email, papel: u.papel, empresas: u.empresas } });
}

// Rotas que exigem estar autenticado.
export async function rotasSessao(c) {
  const { req, ctx, store, plat, resp, auth, papel, partes, doUsuario } = c;
  // POST /logout: encerra a sessão atual
  if (partes[0] === 'logout' && partes.length === 1 && req.metodo === 'POST') {
    if (auth.sessaoHash) await store.sessaoRemover(auth.sessaoHash);
    return resp(200, { ok: true });
  }
  // GET /eu: quem sou eu (o painel decide as abas por aqui); token do env responde só com o papel
  if (partes[0] === 'eu' && partes.length === 1 && req.metodo === 'GET') {
    if (auth.empresaEscopo) return c.semPermissao();
    return resp(200, doUsuario
      ? { id: auth.usuario.id, nome: auth.usuario.nome, email: auth.usuario.email, papel, empresas: auth.usuario.empresas, reautenticadoEm: auth.reautenticadoEm || null }
      : { id: null, nome: null, email: null, papel, empresas: null, reautenticadoEm: null });
  }
  // POST /eu/reautenticar { senha }
  if (partes[0] === 'eu' && partes[1] === 'reautenticar' && partes.length === 2 && req.metodo === 'POST') {
    if (!doUsuario) return resp(403, { erro: 'somente usuários com login reautenticam' });
    const bloqueio = c.limitarLogin('email:' + auth.usuario.email);
    if (bloqueio) return bloqueio;
    const b = await c.lerCorpo(req);
    if (!(await c.senhaDoUsuarioConfere(b.senha))) return resp(403, { erro: 'senha incorreta' });
    await store.sessaoReautenticar(auth.sessaoHash, new Date(ctx.agora()).toISOString());
    return resp(200, { ok: true });
  }
  // POST /eu/senha { atual, nova }: troca a própria senha e encerra as outras sessões
  if (partes[0] === 'eu' && partes[1] === 'senha' && partes.length === 2 && req.metodo === 'POST') {
    if (!doUsuario) return resp(403, { erro: 'somente usuários com login trocam a senha' });
    const bloqueio = c.limitarLogin('email:' + auth.usuario.email);
    if (bloqueio) return bloqueio;
    const b = await c.lerCorpo(req);
    const erroSenha = validarSenhaNova(b.nova);
    if (erroSenha) return resp(400, { erro: erroSenha });
    if (!(await c.senhaDoUsuarioConfere(b.atual))) return resp(403, { erro: 'senha atual incorreta' });
    await store.usuarioSenhaDefinir(auth.usuario.id, await criarCredencial(b.nova));
    await store.sessoesRemoverDoUsuario(auth.usuario.id, auth.sessaoHash);
    return resp(200, { ok: true });
  }
  return null;
}
