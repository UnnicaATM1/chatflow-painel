CREATE TABLE IF NOT EXISTS usuarios (
  id TEXT NOT NULL PRIMARY KEY,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  senha_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  iteracoes INTEGER NOT NULL,
  papel TEXT NOT NULL CHECK (papel IN ('equipe', 'admin', 'superadmin')),
  ativo INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0, 1)),
  criado_em TEXT NOT NULL,
  ultimo_login TEXT
);

CREATE TABLE IF NOT EXISTS usuario_empresas (
  usuario_id TEXT NOT NULL REFERENCES usuarios (id) ON DELETE CASCADE,
  empresa_id TEXT NOT NULL REFERENCES empresas (id) ON DELETE CASCADE,
  PRIMARY KEY (usuario_id, empresa_id)
);

CREATE TABLE IF NOT EXISTS sessoes (
  token_hash TEXT NOT NULL PRIMARY KEY,
  usuario_id TEXT NOT NULL REFERENCES usuarios (id) ON DELETE CASCADE,
  criada_em TEXT NOT NULL,
  expira_em TEXT NOT NULL,
  reautenticado_em TEXT
);
CREATE INDEX IF NOT EXISTS sessoes_por_usuario ON sessoes (usuario_id);
