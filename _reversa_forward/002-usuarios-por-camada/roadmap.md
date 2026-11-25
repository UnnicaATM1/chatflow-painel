# Roadmap 002 — Usuários com senha própria por camada

Abordagem: delta sobre o ONE existente. O núcleo `src/nucleo.js` (`autenticar`, `quem`, `tratar`) ganha um segundo caminho de autenticação (sessão de usuário) ao lado dos tokens do env e da chave `k1_…`. Os três repositórios (`src/repositorio.js` memória, `src/sqlite/repositorio.js`, `src/d1/repositorio.js`) ganham as mesmas funções de usuário e sessão. O Rust (`rust/one-core`, `rust/one-store`, `rust/one-node`) recebe a paridade, validada pela régua `tests/api.test.js`. O site no Sites segue em Worker JS (`worker/index.js`), decisão do João.

## Princípios aplicados
Sem `.reversa/principles.md` no projeto. Valem as regras do repositório: fora de `src/node/` só JS padrão e Web API (Worker); mesma interface nos três repositórios; JSON com a mesma ordem de chaves em JS e Rust; segredos nunca em repo, log ou mensagem. Sem conflito.

## Decisões técnicas
- D1 🟢 Hash PBKDF2-SHA256 por Web Crypto (`crypto.subtle`), sal de 16 bytes por usuário, 100000 iterações (teto do Workers), comparação em tempo constante já existente (`plat.iguaisTempoConstante`). No Rust: crates `pbkdf2` e `sha2`, mesmos parâmetros e mesmo formato guardado.
- D2 🟢 Sessão por token opaco de 32 bytes (`plat.aleatorio`), guardando só o hash SHA-256; validade 12 h; tabela `sessoes`. Revogação imediata: desativar usuário ou trocar senha apaga as sessões.
- D3 🟢 `autenticar` tenta, em ordem: token do env (cliente, integracao), sessão de usuário, chave `k1_…`. O resultado ganha `{papel, usuario?}`. Papéis internos: `cliente` e `integracao` (env); `equipe`, `admin` e `superadmin` (usuário). `staff` passa a significar qualquer um dos cinco. Novas verificações: `ehSuperadmin` (integracao ou superadmin) e `ehAdmin` (admin, superadmin ou integracao).
- D4 🟢 Histórico: o evento (JSON na coluna `evento`) ganha `usuarioId` e `usuarioNome`. O `operador` digitado só vale para token do env e vira `token-equipe` ou `token-integracao`. Sem mudar o schema de `historico`.
- D5 🟢 Empresas por usuário em `usuario_empresas`; `GET /empresas` e toda rota `/empresas/:id/…` filtram por essa lista (403 fora dela). Superadmin e tokens do env veem todas.
- D6 🟢 Reautenticação: `POST /eu/reautenticar {senha}` grava `reautenticado_em` na sessão. Configuração e excluir empresa exigem sessão reautenticada nos últimos 5 min; superadmin dispensa para Configuração. `CHATFLOW_ADMIN_SENHA` continua aceita só para o token do env (emergência).
- D7 🟡 Limite de tentativas de login: contador por IP e por e-mail no limitador do núcleo (em memória por isolate); no D1, tabela `login_falhas`. Premissa: aceitar a lacuna por isolate no primeiro marco e fechar no terceiro.
- D8 🟡 Senha provisória definida pelo superadmin; a pessoa troca em `POST /eu/senha` (premissa das dúvidas do requirements).

## Delta arquitetural
`src/nucleo.js` (autenticar, quem, rotas novas, filtros por empresa); novo `src/usuarios.js` (hash, validação, regras de camada, JS puro); `src/plataforma.js` (expor `pbkdf2`); repositórios memória, SQLite e D1; `src/node/plataforma.js` e `worker/index.js` (injetar `pbkdf2`); `web/app.js` (login, Usuários, abas por `GET /eu`, reautenticação no servidor). Rust: `one-core` (nucleo, novo `usuarios.rs`), `one-store` (memoria, modelo), `one-node`.

## Delta de dados
Ver `data-delta.md` (tabelas `usuarios`, `usuario_empresas`, `sessoes`, `login_falhas`).

## Delta de contratos
Ver `interfaces/usuarios-http.md` (Contrato F). Contrato E (repositório) em `docs/plano-usuarios.md`.

## Plano de migração
Migrações novas e aditivas: `db/migrations/0003_usuarios.sql` (SQLite, via `src/sqlite/migracoes.js`) e `src/d1/migrations/0003_usuarios.sql` (D1, aplicada com `scripts/worker-migrations.mjs`). Nada existente é alterado; sem seeds. O primeiro superadmin é criado pelo token de integração na tela Usuários. Os tokens do env seguem funcionando, então não há corte.

## Marcos
1. Dados e login: Contrato E nos 3 repositórios, `src/usuarios.js`, `POST /login`, `/logout`, `/eu`.
2. Autorização: filtro por empresa e por camada em todas as rotas, histórico com usuário, reautenticação, paridade Rust.
3. Painel e fechamento: tela Usuários, login por e-mail, abas por papel, limite de login no D1, publicação.

## Riscos
- PBKDF2 a 100000 iterações é o teto do Workers; documentar.
- Divergência entre JS e Rust no formato do hash: teste diferencial com o mesmo vetor de senha e sal.
- Rotas existentes sem verificação por empresa quando o usuário não é superadmin: cobrir com teste que percorre todas as rotas `/empresas/:id/…` com um usuário de outra empresa.
- Lacuna do limitador de login por isolate (D7).

## Critério de pronto
Critérios de aceite 1 a 5 do `requirements.md`, mais `CHATFLOW_TESTE_OPERACAO=1 npm test`, `npm run test:worker` e a régua contra o binário Rust verdes, HANDOFF atualizado com o bloco Status validado.
