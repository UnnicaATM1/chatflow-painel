// Usuários e sessões no D1 (contrato E). Não passam pela revisão global: não disputam mesa nem reserva.
// Operações com várias instruções usam db.batch (tudo ou nada).
const COLUNAS = 'id, nome, email, papel, ativo, criado_em AS criadoEm, ultimo_login AS ultimoLogin';

export function operacoesUsuariosD1(db, plat) {
  const preparar = (sql, ...args) => args.length ? db.prepare(sql).bind(...args) : db.prepare(sql);
  const obter = (sql, ...args) => preparar(sql, ...args).first();
  const listar = async (sql, ...args) => (await preparar(sql, ...args).all()).results;
  const empresasDe = async (id) => (await listar('SELECT empresa_id FROM usuario_empresas WHERE usuario_id = ? ORDER BY empresa_id', id)).map((l) => l.empresa_id);
  const publico = async (l) => l && { id: l.id, nome: l.nome, email: l.email, papel: l.papel, ativo: Boolean(l.ativo),
    empresas: await empresasDe(l.id), criadoEm: l.criadoEm, ultimoLogin: l.ultimoLogin };
  const completo = async (l) => {
    if (!l) return null;
    const c = await obter('SELECT senha_hash, salt, iteracoes FROM usuarios WHERE id = ?', l.id);
    return { ...(await publico(l)), senhaHash: c.senha_hash, salt: c.salt, iteracoes: c.iteracoes };
  };
  const comandosEmpresas = (id, ids) => [
    preparar('DELETE FROM usuario_empresas WHERE usuario_id = ?', id),
    ...[...new Set(ids)].map((e) => preparar('INSERT OR IGNORE INTO usuario_empresas (usuario_id, empresa_id) SELECT ?, id FROM empresas WHERE id = ?', id, e)),
  ];
  return {
    async usuarioCriar(d) {
      const id = plat.uuid();
      try {
        await db.batch([
          preparar(`INSERT INTO usuarios (id, nome, email, senha_hash, salt, iteracoes, papel, ativo, criado_em)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`, id, d.nome, d.email, d.senhaHash, d.salt, d.iteracoes, d.papel, d.criadoEm),
          ...comandosEmpresas(id, d.empresas || []),
        ]);
      } catch (erro) {
        if (String(erro.message).includes('UNIQUE') && String(erro.message).includes('email')) return { erro: 'email_duplicado' };
        throw erro;
      }
      return publico(await obter(`SELECT ${COLUNAS} FROM usuarios WHERE id = ?`, id));
    },
    async usuarioPorEmail(email) { return completo(await obter(`SELECT ${COLUNAS} FROM usuarios WHERE email = ?`, email)); },
    async usuarioObter(id) { return completo(await obter(`SELECT ${COLUNAS} FROM usuarios WHERE id = ?`, id)); },
    async usuarioListar() { return Promise.all((await listar(`SELECT ${COLUNAS} FROM usuarios ORDER BY rowid`)).map(publico)); },
    async usuarioAtualizar(id, m) {
      if (!(await obter('SELECT 1 FROM usuarios WHERE id = ?', id))) return null;
      const comandos = [];
      if (m.nome !== undefined) comandos.push(preparar('UPDATE usuarios SET nome = ? WHERE id = ?', m.nome, id));
      if (m.papel !== undefined) comandos.push(preparar('UPDATE usuarios SET papel = ? WHERE id = ?', m.papel, id));
      if (m.ativo !== undefined) comandos.push(preparar('UPDATE usuarios SET ativo = ? WHERE id = ?', m.ativo ? 1 : 0, id));
      if (m.empresas !== undefined) comandos.push(...comandosEmpresas(id, m.empresas));
      if (comandos.length) await db.batch(comandos);
      return publico(await obter(`SELECT ${COLUNAS} FROM usuarios WHERE id = ?`, id));
    },
    async usuarioSenhaDefinir(id, c) {
      const r = await preparar('UPDATE usuarios SET senha_hash = ?, salt = ?, iteracoes = ? WHERE id = ?', c.senhaHash, c.salt, c.iteracoes, id).run();
      return r.meta.changes > 0;
    },
    async usuarioLoginMarcar(id, quando) { await preparar('UPDATE usuarios SET ultimo_login = ? WHERE id = ?', quando, id).run(); },
    async usuarioSuperadminsAtivos() { return (await listar("SELECT id FROM usuarios WHERE papel = 'superadmin' AND ativo = 1 ORDER BY rowid")).map((l) => l.id); },
    async sessaoCriar(s) { await preparar('INSERT INTO sessoes (token_hash, usuario_id, criada_em, expira_em) VALUES (?, ?, ?, ?)', s.tokenHash, s.usuarioId, s.criadaEm, s.expiraEm).run(); },
    async sessaoPorHash(hash) {
      const l = await obter('SELECT usuario_id AS usuarioId, criada_em AS criadaEm, expira_em AS expiraEm, reautenticado_em AS reautenticadoEm FROM sessoes WHERE token_hash = ?', hash);
      return l ? { ...l } : null;
    },
    async sessaoReautenticar(hash, quando) { await preparar('UPDATE sessoes SET reautenticado_em = ? WHERE token_hash = ?', quando, hash).run(); },
    async sessaoRemover(hash) { await preparar('DELETE FROM sessoes WHERE token_hash = ?', hash).run(); },
    async sessoesRemoverDoUsuario(usuarioId, exceto = null) { await preparar('DELETE FROM sessoes WHERE usuario_id = ? AND token_hash IS NOT ?', usuarioId, exceto).run(); },
    async sessoesExpiradasRemover(agoraIso) { await preparar('DELETE FROM sessoes WHERE expira_em <= ?', agoraIso).run(); },
  };
}
