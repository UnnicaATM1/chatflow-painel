// Gestão de usuários (só superadmin): GET/POST /usuarios, PATCH /usuarios/:id e POST /usuarios/:id/senha.
// Devolve a resposta do núcleo ou null quando a rota não é daqui (o despachante em nucleo.js segue adiante).
// Sem Node aqui. c = mesmo contexto de rotas-sessao.js.
import { criarCredencial, validarNovoUsuario, validarSenhaNova, PAPEIS_USUARIO } from './usuarios.js';

export async function rotasUsuarios(c) {
  const { req, ctx, store, resp, partes } = c;
  if (partes[0] !== 'usuarios') return null;
  if (!c.pode('usuarios.gerir')) return c.semPermissao();
  const idsEmpresas = async () => new Set((await store.empresaListar({ incluirConhecimento: false })).map((l) => l.id));
  if (partes.length === 1 && req.metodo === 'GET') return resp(200, await store.usuarioListar());
  if (partes.length === 1 && req.metodo === 'POST') {
    const corpo = await c.lerCorpo(req);
    const v = validarNovoUsuario(corpo);
    if (v.erro) return resp(400, { erro: v.erro });
    const existentes = await idsEmpresas();
    const desconhecida = v.empresas.find((e) => !existentes.has(e));
    if (desconhecida) return resp(400, { erro: `empresa inexistente: ${desconhecida}` });
    const cred = await criarCredencial(corpo.senha);
    const r = await store.usuarioCriar({ nome: v.nome, email: v.email, papel: v.papel, empresas: v.empresas, ...cred, criadoEm: new Date(ctx.agora()).toISOString() });
    if (r.erro) return resp(409, { erro: 'e-mail já cadastrado' });
    return resp(201, r);
  }
  if (partes.length >= 2) {
    const uid = c.idDe(1);
    const alvo = await store.usuarioObter(uid);
    if (!alvo) return resp(404, { erro: 'usuário inexistente' });
    if (partes.length === 2 && req.metodo === 'PATCH') {
      const b = await c.lerCorpo(req);
      const m = {};
      if (b.nome !== undefined) { if (typeof b.nome !== 'string' || !b.nome.trim() || b.nome.trim().length > 80) return resp(400, { erro: 'nome de 1 a 80 caracteres' }); m.nome = b.nome.trim(); }
      if (b.papel !== undefined) { if (!PAPEIS_USUARIO.includes(b.papel)) return resp(400, { erro: 'papel deve ser equipe, admin ou superadmin' }); m.papel = b.papel; }
      if (b.ativo !== undefined) { if (typeof b.ativo !== 'boolean') return resp(400, { erro: 'ativo deve ser verdadeiro ou falso' }); m.ativo = b.ativo; }
      if (b.empresas !== undefined) {
        if (!Array.isArray(b.empresas) || b.empresas.some((x) => typeof x !== 'string')) return resp(400, { erro: 'empresas deve ser uma lista de ids' });
        const existentes = await idsEmpresas();
        const desconhecida = b.empresas.find((e) => !existentes.has(e));
        if (desconhecida) return resp(400, { erro: `empresa inexistente: ${desconhecida}` });
        m.empresas = [...new Set(b.empresas)];
      }
      // Nunca ficar sem superadmin ativo.
      const deixaDeSer = alvo.papel === 'superadmin' && alvo.ativo && ((m.papel && m.papel !== 'superadmin') || m.ativo === false);
      if (deixaDeSer && (await store.usuarioSuperadminsAtivos()).filter((i) => i !== alvo.id).length === 0) {
        return resp(409, { erro: 'precisa existir pelo menos um superadmin ativo' });
      }
      const r = await store.usuarioAtualizar(uid, m);
      if (m.ativo === false || (m.papel && m.papel !== alvo.papel)) await store.sessoesRemoverDoUsuario(uid);
      return resp(200, r);
    }
    if (partes.length === 3 && partes[2] === 'senha' && req.metodo === 'POST') {
      const b = await c.lerCorpo(req);
      const erroSenha = validarSenhaNova(b.senha);
      if (erroSenha) return resp(400, { erro: erroSenha });
      await store.usuarioSenhaDefinir(uid, await criarCredencial(b.senha));
      await store.sessoesRemoverDoUsuario(uid);
      return resp(200, { ok: true });
    }
  }
  return null;
}
