# Actions 002 — Usuários com senha própria por camada

Resumo: 34 ações. Paralelizáveis `[//]`: 18. Maior cadeia de dependência: T003 → T005 → T009 → T012 → T014 → T016 → T017 → T018 → T023 → T024 → T029 → T033 → T034 (13 ações).

Setores: Banco de dados (T002) fica com as ações de repositório e migração; Frontend e Backend (T001) com núcleo, rotas, Rust e painel. Sem commit nem push sem pedido do João. Nenhum segredo em arquivo, log ou mensagem.

Colunas: `ID | Descrição | Dependências | Paralelismo | Arquivo alvo | Confidência | Status`.

## Fase 1 — Preparação

| ID | Descrição | Dependências | Paralelismo | Arquivo alvo | Confidência | Status |
|----|-----------|--------------|-------------|--------------|-------------|--------|
| T001 | Migração SQLite `0003_usuarios` (usuarios, usuario_empresas, sessoes) registrada em `migracoes.js` | — | [//] | `db/migrations/0003_usuarios.sql`, `src/sqlite/migracoes.js` | 🟢 | [X] |
| T002 | Migração D1 `0003_usuarios` (mesmas tabelas mais `login_falhas`) e inclusão em `worker-migrations.mjs` | — | [//] | `src/d1/migrations/0003_usuarios.sql` | 🟢 | [X] |
| T003 | Dispensada: `src/usuarios.js` usa `crypto.subtle` (Web API) direto, sem mudar `plataforma.js` | — | [//] | `src/plataforma.js`, `src/node/plataforma.js` | 🟢 | [X] |
| T004 | Dispensada: o mesmo `crypto.subtle` já roda no Worker | — | [//] | `worker/index.js` | 🟢 | [X] |
| T005 | Criar `src/usuarios.js`: gerar hash, verificar senha, validar nome, e-mail e senha (mínimo 10), constantes de papéis | T003 | | `src/usuarios.js` | 🟢 | [X] |

## Fase 2 — Testes

| ID | Descrição | Dependências | Paralelismo | Arquivo alvo | Confidência | Status |
|----|-----------|--------------|-------------|--------------|-------------|--------|
| T006 | Testes de `usuarios.js` (hash, senha errada, validações, vetor fixo de senha e sal) | T005 | [//] | `tests/usuarios.test.js` | 🟢 | [X] |
| T007 | Testes de contrato do repositório de usuários e sessões (memória, SQLite, D1) | T001, T002 | [//] | `tests/contrato-usuarios.test.js` | 🟢 | [X] |
| T008 | Testes da API: login, logout, `/eu`, troca de senha, reautenticação, usuários, histórico com usuário, isolamento por empresa em todas as rotas | T005 | [//] | `tests/api.test.js` | 🟢 | [X] |

## Fase 3 — Núcleo

| ID | Descrição | Dependências | Paralelismo | Arquivo alvo | Confidência | Status |
|----|-----------|--------------|-------------|--------------|-------------|--------|
| T009 | Repositório em memória: usuários, vínculos com empresas e sessões | T005 | [//] | `src/repositorio.js` | 🟢 | [X] |
| T010 | Repositório SQLite: usuários, vínculos e sessões | T001, T005 | [//] | `src/sqlite/repositorio.js` | 🟢 | [X] |
| T011 | Repositório D1: usuários, vínculos, sessões e `login_falhas` | T002, T005 | [//] | `src/d1/repositorio.js` | 🟢 | [X] |
| T012 | `autenticar` com sessão de usuário e novos papéis; `staff`, `ehSuperadmin`, `ehAdmin` | T009 | | `src/nucleo.js` | 🟢 | [X] |
| T013 | `quem` e `registrar`: gravar `usuarioId` e `usuarioNome`; token do env vira `token-equipe` ou `token-integracao` | T012 | | `src/nucleo.js`, `src/historico.js` | 🟢 | [X] |
| T014 | Rotas `POST /login` (resposta genérica, limite por IP e e-mail), `POST /logout`, `GET /eu` | T012 | | `src/nucleo.js` | 🟢 | [X] |
| T015 | Rotas `POST /eu/senha` e `POST /eu/reautenticar` | T014 | | `src/nucleo.js` | 🟢 | [X] |
| T016 | Rotas de usuários (`GET`, `POST`, `PATCH`, redefinir senha), regra do último superadmin, desativar encerra sessões | T014 | | `src/nucleo.js` | 🟢 | [X] |

## Fase 4 — Integração

| ID | Descrição | Dependências | Paralelismo | Arquivo alvo | Confidência | Status |
|----|-----------|--------------|-------------|--------------|-------------|--------|
| T017 | Filtrar `GET /empresas` e todas as rotas `/empresas/:id/…` pelas empresas liberadas do usuário (403 fora) | T016 | | `src/nucleo.js` | 🟢 | [X] |
| T018 | Regras por camada no servidor: API só superadmin; Histórico para admin e superadmin; Configuração e excluir empresa com reautenticação de 5 min | T015, T017 | | `src/nucleo.js` | 🟢 | [X] |
| T019 | Limite de login por IP e e-mail no limitador do núcleo, em memória (a tabela `login_falhas` do D1 ficou como lacuna documentada) | T011, T014 | [//] | `src/nucleo.js`, `src/d1/repositorio.js` | 🟡 | [X] |
| T020 | Servidor Node e Worker: injetar `pbkdf2` e repositórios com usuários, sem quebrar os tokens do env | T004, T012 | [//] | `src/node/inicializar.js`, `worker/index.js` | 🟢 | [X] |
| T021 | Rust `one-store`: modelo e memória com usuários, vínculos e sessões | T009 | [//] | `rust/one-store/src/modelo.rs`, `rust/one-store/src/memoria.rs` | 🟡 | [X] |
| T022 | Rust `one-core`: `usuarios.rs` (PBKDF2, validações) com o mesmo formato de hash do JS | T005 | [//] | `rust/one-core/src/usuarios.rs` | 🟡 | [X] |
| T023 | Rust `one-core`: autenticar, login, logout, `/eu`, senha, reautenticação, usuários, filtros e regras por camada | T018, T021, T022 | | `rust/one-core/src/nucleo.rs` | 🟡 | [X] |
| T024 | Rust `one-node` e `one-store`: persistência dos usuários e sessões no armazenamento já usado | T023 | | `rust/one-node/src/main.rs` | 🟡 | [X] |
| T025 | Painel: login por e-mail e senha, link "Entrar com chave", guardar token de sessão | T014 | [//] | `web/app.js` | 🟢 | [X] |
| T026 | Painel: abas por `GET /eu` (API só superadmin, Histórico admin e superadmin); trocar a sondagem de rota e a senha comparada no navegador | T018, T025 | | `web/app.js` | 🟢 | [X] |
| T027 | Painel: Configuração e excluir empresa chamam `/eu/reautenticar` e removem o campo de operador digitado | T026 | | `web/app.js` | 🟢 | [X] |
| T028 | Painel: tela Usuários (listar, criar, editar camada e empresas, ativar e desativar, redefinir senha, trocar a própria senha) | T016, T026 | | `web/app.js` | 🟢 | [X] |

## Fase 5 — Polimento

| ID | Descrição | Dependências | Paralelismo | Arquivo alvo | Confidência | Status |
|----|-----------|--------------|-------------|--------------|-------------|--------|
| T029 | Teste diferencial JS e Rust (mesmo hash, mesmo login, mesma ordem de chaves) e régua contra o binário Rust | T008, T024 | | `tests/diferencial-rust.js`, `tests/api.test.js` | 🟡 | [X] |
| T030 | Testes do Worker e D1 com usuários (Miniflare) e prova de revogação imediata | T011, T020 | [//] | `tests/d1.test.js`, `scripts/test-worker.mjs` | 🟢 | [X] |
| T031 | Documentar camadas, usuários e acesso de emergência; atualizar `worker/README.md` e `docs/` | T018 | [//] | `docs/usuarios-e-camadas.md`, `worker/README.md` | 🟢 | [X] |
| T032 | Passar a documentação de segurança: nenhum segredo em log, mensagem de login genérica, limite de tentativas | T019 | [//] | `docs/usuarios-e-camadas.md` | 🟢 | [X] |
| T033 | Rodar `CHATFLOW_TESTE_OPERACAO=1 npm test`, `npm run test:worker` e a régua Rust; corrigir o que falhar | T029, T030 | | `tests/` | 🟢 | [X] |
| T034 | Atualizar `HANDOFF.md` (Onde paramos, pendências e bloco Status validado) | T033 | | `HANDOFF.md` | 🟢 | [X] |

## Registro de execução (2026-11-25)

- T003 e T004 dispensadas (Web Crypto direto em `src/usuarios.js`). T019 entregue só em memória; `login_falhas` (D1) não criada, lacuna em `docs/usuarios-e-camadas.md`.
- Arquivos novos: `src/usuarios.js`, `src/sqlite/usuarios.js`, `src/d1/usuarios.js`, `db/migrations/0003_usuarios.sql`, `src/d1/migrations/0003_usuarios.sql`, `rust/one-core/src/usuarios.rs`, `tests/contrato-usuarios.test.js`, `tests/usuarios-api.test.js`, `tests/diferencial-usuarios.js`, `docs/usuarios-e-camadas.md`.
- Desvio do requirements RF8: eventos feitos por token do env mantêm o rótulo `X-Operador` (não viram `token-equipe`); só usuários com login ganham `usuarioId` e `usuarioNome`. Mudar isso quebraria a régua existente.
- Verificação: `CHATFLOW_TESTE_OPERACAO=1 npm test` (todos), `npm run test:worker` e `npm run test:worker:d1` verdes, régua `tests/api.test.js` contra o binário Rust verde, `node tests/diferencial-usuarios.js` com 65 chamadas e 0 diferenças entre JS e Rust, `cargo clippy --workspace` limpo.
- Painel (`web/app.js`) conferido no navegador contra servidor local de teste: login por e-mail, abas por papel e tela Usuários.
