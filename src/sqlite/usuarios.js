// Usuários e sessões no SQLite (contrato E). `h` traz os ajudantes do repositório: obter, listar, gravar, transacionar e a plataforma.
const COLUNAS = 'id, nome, email, papel, ativo, criado_em AS criadoEm, ultimo_login AS ultimoLogin';

export function operacoesUsuariosSqlite({ obter, listar, gravar, transacionar, p }) {
  const empresasDe = (id) => listar('SELECT empresa_id FROM usuario_empresas WHERE usuario_id = ? ORDER BY empresa_id', id).map((l) => l.empresa_id);
  const publico = (l) => l && { id: l.id, nome: l.nome, email: l.email, papel: l.papel, ativo: Boolean(l.ativo),
    empresas: empresasDe(l.id), criadoEm: l.criadoEm, ultimoLogin: l.ultimoLogin };
  const completo = (l) => {
    if (!l) return null;
    const c = obter('SELECT senha_hash, salt, iteracoes FROM usuarios WHERE id = ?', l.id);
    return { ...publico(l), senhaHash: c.senha_hash, salt: c.salt, iteracoes: c.iteracoes };
  };
  const trocarEmpresas = (id, ids) => {
    gravar('DELETE FROM usuario_empresas WHERE usuario_id = ?', id);
    for (const e of new Set(ids)) gravar('INSERT OR IGNORE INTO usuario_empresas (usuario_id, empresa_id) SELECT ?, id FROM empresas WHERE id = ?', id, e);
  };
  return {
    async usuarioCriar(d) {
      return transacionar(async () => {
        const id = p.uuid();
        const r = gravar(`INSERT INTO usuarios (id, nome, email, senha_hash, salt, iteracoes, papel, ativo, criado_em)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT (email) DO NOTHING`, id, d.nome, d.email, d.senhaHash, d.salt, d.iteracoes, d.papel, d.criadoEm);
        if (!r.changes) return { erro: 'email_duplicado' };
        trocarEmpresas(id, d.empresas || []);
        return publico(obter(`SELECT ${COLUNAS} FROM usuarios WHERE id = ?`, id));
      });
    },
    async usuarioPorEmail(email) { return completo(obter(`SELECT ${COLUNAS} FROM usuarios WHERE email = ?`, email)); },
    async usuarioObter(id) { return completo(obter(`SELECT ${COLUNAS} FROM usuarios WHERE id = ?`, id)); },
    async usuarioListar() { return listar(`SELECT ${COLUNAS} FROM usuarios ORDER BY rowid`).map(publico); },
    async usuarioAtualizar(id, m) {
      return transacionar(async () => {
        if (!obter('SELECT 1 FROM usuarios WHERE id = ?', id)) return null;
        if (m.nome !== undefined) gravar('UPDATE usuarios SET nome = ? WHERE id = ?', m.nome, id);
        if (m.papel !== undefined) gravar('UPDATE usuarios SET papel = ? WHERE id = ?', m.papel, id);
        if (m.ativo !== undefined) gravar('UPDATE usuarios SET ativo = ? WHERE id = ?', m.ativo ? 1 : 0, id);
        if (m.empresas !== undefined) trocarEmpresas(id, m.empresas);
        return publico(obter(`SELECT ${COLUNAS} FROM usuarios WHERE id = ?`, id));
      });
    },
    async usuarioSenhaDefinir(id, c) {
      return gravar('UPDATE usuarios SET senha_hash = ?, salt = ?, iteracoes = ? WHERE id = ?', c.senhaHash, c.salt, c.iteracoes, id).changes > 0;
    },
    async usuarioLoginMarcar(id, quando) { gravar('UPDATE usuarios SET ultimo_login = ? WHERE id = ?', quando, id); },
    async usuarioSuperadminsAtivos() { return listar("SELECT id FROM usuarios WHERE papel = 'superadmin' AND ativo = 1 ORDER BY rowid").map((l) => l.id); },
    async sessaoCriar(s) { gravar('INSERT INTO sessoes (token_hash, usuario_id, criada_em, expira_em) VALUES (?, ?, ?, ?)', s.tokenHash, s.usuarioId, s.criadaEm, s.expiraEm); },
    async sessaoPorHash(hash) {
      const l = obter('SELECT usuario_id AS usuarioId, criada_em AS criadaEm, expira_em AS expiraEm, reautenticado_em AS reautenticadoEm FROM sessoes WHERE token_hash = ?', hash);
      return l ? { ...l } : null;
    },
    async sessaoReautenticar(hash, quando) { gravar('UPDATE sessoes SET reautenticado_em = ? WHERE token_hash = ?', quando, hash); },
    async sessaoRemover(hash) { gravar('DELETE FROM sessoes WHERE token_hash = ?', hash); },
    async sessoesRemoverDoUsuario(usuarioId, exceto = null) { gravar('DELETE FROM sessoes WHERE usuario_id = ? AND token_hash IS NOT ?', usuarioId, exceto); },
    async sessoesExpiradasRemover(agoraIso) { gravar('DELETE FROM sessoes WHERE expira_em <= ?', agoraIso); },
  };
}
