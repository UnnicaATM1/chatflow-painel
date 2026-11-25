# Requirements 002 — Usuários com senha própria por camada

Fontes: `docs/plano-usuarios.md`, `docs/plano-worker-sites.md`, `_reversa_sdd/prd.md`, `_reversa_sdd/sdd/agente-config.md`, `src/nucleo.js` (autenticar, quem, rotas), `web/app.js`, feature 001 (`_reversa_forward/001-agentes-reservas`). Decisões do João em 2026-11-25: cada pessoa tem senha particular; nada de nome digitado no Histórico; Rust paritário (a API em `rust/` recebe a mesma funcionalidade, o site no Sites segue em Worker JS).

## Problema 🟢
Hoje há uma senha compartilhada por camada (`CHATFLOW_TOKEN_CLIENTE`, `CHATFLOW_TOKEN_INTEGRACAO`) e o nome no Histórico é um rótulo digitado (`X-Operador`). Qualquer pessoa pode agir em nome de outra, e revogar uma pessoa exige trocar a senha de todos.

## Requisitos funcionais
- RF1 🟢 Login por e-mail e senha; sessão com token aleatório (só o hash guardado), validade de 12 h.
- RF2 🟢 Três camadas: `equipe`, `admin`, `superadmin`; cada usuário vê só as empresas liberadas para ele (superadmin vê todas).
- RF3 🟢 Superadmin cria, edita (nome, camada, empresas), desativa e redefine a senha de usuários; desativar encerra as sessões; nunca remover o último superadmin ativo (409).
- RF4 🟢 Histórico grava `usuarioId` e `usuarioNome` vindos do servidor; o `operador` digitado deixa de ser aceito quando há sessão.
- RF5 🟢 Abas API e Histórico: API só superadmin; Histórico para admin e superadmin. Aba Configuração: equipe e admin reautenticam com a própria senha (`POST /eu/reautenticar`); superadmin abre direto. Tudo imposto pelo servidor, não só pela tela.
- RF6 🟢 Excluir empresa exige reautenticação do próprio admin ou superadmin (nos últimos 5 min), no lugar de `CHATFLOW_ADMIN_SENHA`.
- RF7 🟢 Troca da própria senha (`POST /eu/senha`) derruba as outras sessões. Senha mínima de 10 caracteres.
- RF8 🟢 Tokens do env (`CHATFLOW_TOKEN_CLIENTE`, `CHATFLOW_TOKEN_INTEGRACAO`) e chave `k1_…` da empresa continuam válidos (acesso de emergência e integração). Eventos feitos por eles gravam `token-equipe` ou `token-integracao`.
- RF9 🟢 Tela Usuários no painel (só superadmin) e login por e-mail e senha, com link "Entrar com chave".

## Requisitos não funcionais
- RNF1 🟢 PBKDF2-SHA256 (Web Crypto), sal por usuário, 100000 iterações (teto do Workers), comparação em tempo constante.
- RNF2 🟢 Resposta de login genérica ("e-mail ou senha inválidos"); limite de tentativas por IP e por e-mail.
- RNF3 🟢 Mesma interface nos repositórios memória, SQLite e D1; paridade JS e Rust validada por `tests/api.test.js`; migrações novas sem seeds.
- RNF4 🟢 Nenhuma senha, hash ou token em log, repositório ou mensagem entre agentes.
- RNF5 🟡 Dentro de `src/` fora de `src/node/` só JS padrão e Web API (regra do Worker).

## Fora de escopo
Recuperação de senha por e-mail; login social; MFA; migração do site para Rust/WASM (etapa separada, decisão do João de manter JS no Sites).

## Critérios de aceite
1. `CHATFLOW_TESTE_OPERACAO=1 npm test`, régua contra JS e Rust, testes Worker/D1 verdes.
2. Dois usuários da mesma empresa geram eventos com nomes distintos; ninguém se passa por outro.
3. Equipe não acessa API, Histórico nem empresas não liberadas, nem por chamada direta.
4. Desativar usuário derruba a sessão na hora.
5. Sem segredos em arquivo, log ou mensagem.

## Premissas no lugar de dúvidas
- [DÚVIDA] 🟡 Identificador de login: e-mail (premissa adotada).
- [DÚVIDA] 🟡 Recuperação de senha: só o superadmin redefine (premissa adotada).
- [DÚVIDA] 🟡 Validade da sessão: 12 h (premissa adotada).
