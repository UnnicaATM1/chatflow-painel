# Plano: usuários com senha própria por camada

Arquiteto: T00. Data: 2026-11-25. Decisão do João: cada pessoa tem login e senha particulares. Hoje há uma senha compartilhada por camada (`CHATFLOW_TOKEN_CLIENTE`, `CHATFLOW_TOKEN_INTEGRACAO`) e o nome no Histórico é um rótulo digitado (`X-Operador`), sem prova de identidade. Objetivo: Histórico confiável, acesso individual e revogável.

## Camadas (papéis)

- `equipe` (hoje "cliente"): entra no painel das empresas liberadas para o usuário; Configuração exige reautenticação; sem abas API e Histórico.
- `admin`: como equipe, mais Histórico das empresas liberadas e exclusão de empresa (digitando a própria senha, no lugar da `CHATFLOW_ADMIN_SENHA` compartilhada). Configuração exige reautenticação. Sem aba API.
- `superadmin` (hoje "integração"): todas as empresas, aba API (gera a chave `k1_…`), Histórico, tela Usuários, Configuração aberta.
- Chave da empresa `k1_…` continua como está (só rotas de chat daquela empresa).
- Tokens do env (`CHATFLOW_TOKEN_CLIENTE`, `CHATFLOW_TOKEN_INTEGRACAO`) continuam válidos como acesso de emergência (break-glass) e para integrações: papéis `cliente` e `integracao` atuais. O primeiro superadmin nasce usando o token de integração na tela Usuários. Eventos feitos por token do env gravam `usuario: "token-integracao"` ou `"token-equipe"`, nunca um nome digitado.

## Contrato E: dados (Banco entrega, Backend consome)

Mesma interface nos repositórios memória, SQLite e D1 (todas async, mesmo retorno e mesma ordem de chaves JSON):

- `usuarioCriar({nome, email, papel, senhaHash, salt, iteracoes, empresas:[ids]})` devolve o usuário sem hash, ou `{erro:"email_duplicado"}`.
- `usuarioPorEmail(email)` (inclui hash, para login), `usuarioObter(id)`, `usuarioListar()`, `usuarioAtualizar(id, {nome?, papel?, ativo?, empresas?})`, `usuarioSenhaDefinir(id, {senhaHash, salt, iteracoes})`.
- `sessaoCriar({tokenHash, usuarioId, expiraEm})`, `sessaoPorHash(tokenHash)` (devolve usuário e papel, ignora expiradas e usuário inativo), `sessaoRemover(tokenHash)`, `sessoesRemoverDoUsuario(id)` (ao desativar ou trocar senha).
- Tabelas: `usuarios(id, nome, email único minúsculo, senha_hash, salt, iteracoes, papel CHECK, ativo, criado_em, ultimo_login)`, `usuario_empresas(usuario_id, empresa_id)`, `sessoes(token_hash PK, usuario_id, criada_em, expira_em)`. Migrações novas (SQLite e D1), sem seeds.
- Histórico: gravar `usuarioId` e `usuarioNome` do servidor em cada evento; o campo `operador` digitado deixa de ser usado quando há sessão.

## Contrato F: HTTP (Backend entrega; JSON na mesma ordem em JS e Rust)

- `POST /login {email, senha}` devolve 200 `{token, usuario:{id,nome,email,papel,empresas}}`; 401 genérico ("e-mail ou senha inválidos", sem dizer qual). Limite por IP e por e-mail (bloqueio temporário após falhas). Sessão de 12 h. Token de sessão aleatório de 32 bytes; só o hash fica guardado.
- `POST /logout`; `GET /eu`; `POST /eu/senha {atual, nova}` (derruba as outras sessões); `POST /eu/reautenticar {senha}` devolve `{ok:true}` ou 403 (usado pela aba Configuração e pela exclusão de empresa).
- Só superadmin: `GET /usuarios`, `POST /usuarios` (cria com senha provisória definida por ele), `PATCH /usuarios/:id` (nome, papel, ativo, empresas), `POST /usuarios/:id/senha` (redefine). Desativar encerra as sessões. Impedir remover o último superadmin ativo (409).
- Hash de senha: PBKDF2-SHA256 via Web Crypto (funciona no Worker e no Node), sal único por usuário, 100000 iterações (limite do Workers), comparação em tempo constante. Senha mínima de 10 caracteres.
- Autorização: filtrar `GET /empresas` e todas as rotas `/empresas/:id/…` pelas empresas liberadas do usuário (403 fora delas). Regras de papel das rotas atuais mantidas (API e Histórico só superadmin; admin e superadmin veem Histórico das suas empresas; excluir empresa exige `/eu/reautenticar` válido nos últimos 5 minutos).
- Compatibilidade: sem `Authorization: Bearer <token de sessão>`, tudo continua como hoje (tokens do env e chave `k1_…`).

## Painel (Frontend)

- Login por e-mail e senha (mantém um link "Entrar com chave" para o acesso de emergência do env).
- Tela **Usuários** (só superadmin): listar, criar, editar papel e empresas, ativar e desativar, redefinir senha.
- Configuração pede a senha própria (chama `/eu/reautenticar`, não compara no navegador). Abas API e Histórico por papel, vindas de `GET /eu` (sem sondar rotas).
- Nome no Histórico vem do servidor; remover o campo de operador digitado.

## Setores

- Banco de dados (T002): Contrato E em memória, SQLite e D1, migrações, testes de contrato e concorrência de sessões.
- Frontend e Backend (T001): Contrato F em JS e Rust, painel, testes da régua `tests/api.test.js`.

## Critérios de aceite

1. `CHATFLOW_TESTE_OPERACAO=1 npm test` verde, régua de contrato verde contra JS e Rust, testes do Worker/D1 verdes.
2. Dois usuários com a mesma empresa geram eventos com nomes distintos no Histórico, sem possibilidade de se passar por outro.
3. Usuário `equipe` não acessa API, Histórico nem empresas não liberadas, nem pelo servidor (testado nas rotas, não só na tela).
4. Desativar um usuário derruba a sessão na hora.
5. Nenhuma senha, hash ou token em log, repositório ou mensagem entre agentes.
6. HANDOFF atualizado, bloco Status validado. Sem commit nem push sem pedido do João.

## Riscos

- PBKDF2 a 100000 iterações é o teto do Workers; documentar e revisar se o Sites subir o limite.
- Limite de tentativas de login em memória por isolate no Worker; usar D1 para o contador, ou documentar a lacuna.
- Esqueceu a senha: só o superadmin redefine; sem recuperação por e-mail nesta fase.
- Esforço estimado: 5 a 8 dias úteis de uma pessoa, entregue em marcos: (1) dados e login, (2) autorização por empresa, (3) tela Usuários e Histórico.
