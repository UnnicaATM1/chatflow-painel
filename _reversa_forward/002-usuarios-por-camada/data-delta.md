# Delta de dados 002

Novas tabelas (SQLite e D1, migração `0003_usuarios.sql`, sem seeds):

- `usuarios(id TEXT PK, nome TEXT NOT NULL, email TEXT NOT NULL UNIQUE (minúsculo), senha_hash TEXT NOT NULL, salt TEXT NOT NULL, iteracoes INTEGER NOT NULL, papel TEXT NOT NULL CHECK IN ('equipe','admin','superadmin'), ativo INTEGER NOT NULL DEFAULT 1, criado_em TEXT NOT NULL, ultimo_login TEXT)`.
- `usuario_empresas(usuario_id TEXT, empresa_id TEXT, PRIMARY KEY (usuario_id, empresa_id))`.
- `sessoes(token_hash TEXT PK, usuario_id TEXT NOT NULL, criada_em TEXT NOT NULL, expira_em TEXT NOT NULL, reautenticado_em TEXT)` com índice por `usuario_id`.
- `login_falhas` (D1, limitador compartilhado): NÃO criada; o limite de login fica em memória (ver `docs/usuarios-e-camadas.md`).

Sem campos removidos. `historico` não muda: `usuarioId` e `usuarioNome` entram no JSON de `evento`. Memória: mapas equivalentes em `src/repositorio.js` e `rust/one-store/src/memoria.rs`.
