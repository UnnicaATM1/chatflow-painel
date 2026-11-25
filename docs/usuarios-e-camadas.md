# Usuários e camadas de acesso

Cada pessoa entra com **e-mail e senha próprios**. O servidor sabe quem é e grava isso no Histórico; o nome nunca vem do navegador.

## Camadas

| Camada | Vê | Pode |
|---|---|---|
| `equipe` | só as empresas liberadas para ela | operar reservas, agente e conhecimento. Configuração (renomear empresa e módulos) pede a senha de novo (vale 5 min). Sem API, Histórico, Usuários nem criar empresa. |
| `admin` | só as empresas liberadas | tudo da equipe, mais Histórico (e desfazer) e excluir empresa digitando a própria senha. Sem API, Usuários nem criar empresa. |
| `superadmin` | todas as empresas | tudo, mais aba API (gera a chave `k1_…`), Usuários, criar empresa, `GET /historico/excluidas`. Configuração abre direto. |

Tudo é imposto no servidor (`src/nucleo.js` e `rust/one-core/src/nucleo.rs`), não só na tela.

## Acesso de emergência e integrações (não mudaram)

- `CHATFLOW_TOKEN_CLIENTE` (papel `cliente`) e `CHATFLOW_TOKEN_INTEGRACAO` (papel `integracao`, equivale a superadmin) continuam valendo. O primeiro superadmin é criado usando o token de integração em `POST /usuarios`.
- `CHATFLOW_ADMIN_SENHA` só vale para excluir empresa com token do env. Usuário logado confirma com a própria senha.
- A chave `k1_…` da empresa só alcança as rotas de chat daquela empresa.
- Eventos feitos com token do env continuam usando o rótulo `X-Operador` (não prova identidade). Para usuários com login o cabeçalho é ignorado.

## Rotas (Contrato F)

`POST /login`, `POST /logout`, `GET /eu`, `POST /eu/senha`, `POST /eu/reautenticar`; só superadmin: `GET/POST /usuarios`, `PATCH /usuarios/:id`, `POST /usuarios/:id/senha`. Detalhes em `_reversa_forward/002-usuarios-por-camada/interfaces/usuarios-http.md`.

## Segurança

- Senha: PBKDF2-SHA256, sal de 16 bytes por usuário, 100000 iterações (teto do Workers), comparação em tempo constante; mínimo de 10 caracteres.
- Sessão: token opaco `s1_…` de 32 bytes aleatórios, só o hash SHA-256 fica guardado, validade de 12 h. Desativar usuário, mudar a camada, redefinir a senha ou trocar a própria senha encerra as sessões (a atual é mantida na troca).
- Login: resposta sempre `e-mail ou senha inválidos` (mesmo tempo de derivação com e-mail inexistente). Limite de 10 tentativas por minuto por e-mail e por IP.
- Nunca ficar sem superadmin ativo (409).
- Nenhuma senha, hash ou token vai para log, histórico ou mensagem.

## Lacunas conhecidas

- O limite de tentativas de login fica em memória do processo (no Worker, por isolate), como o limitador de requisições. Uma tabela `login_falhas` no D1 fecharia isso; não foi feita.
- Sem recuperação de senha por e-mail: o superadmin redefine.
- No Rust os usuários ficam só em memória, como o resto do repositório Rust (fase 2).
- Sessões expiradas ficam na tabela até a pessoa entrar de novo; `sessoesExpiradasRemover` existe nos repositórios para uma limpeza periódica.
