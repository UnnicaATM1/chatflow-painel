# Publicação do ONE: arquitetura em duas partes

Decisão do João: o `/sites` não roda servidor Node (só estático ou Worker da Cloudflare). Então o ONE é publicado separado:

| Parte | O que é | Onde vai |
|---|---|---|
| **Painel** | `web/` (HTML, JS, CSS, logo). Estático. | `/sites` |
| **API** | `src/server.js` (Node, sem dependências), usada pelo painel e pelo NicoChat | Hospedagem que mantém Node ligado (a definir pelo João; para o teste com o NicoChat qualquer uma com HTTPS) |

O painel (no `/sites`) chama a API por outro endereço. Por isso a API precisa de **CORS** e o painel de um endereço de API configurável.

Direção futura (dita pelo João): o ONE deve acabar indo inteiro para a estrutura do Sites (Worker ES module com `fetch`). A cotação dessa portabilidade é a TASK-004; esta tarefa NÃO porta nada.

Executores: parte A é do T02 (Codex); parte C é do T00; parte B só depois de o João informar a hospedagem. Leia `HANDOFF.md` e `AGENTS.md` antes de agir.

## Parte A: preparar o código (T02, TASK-003, pode começar agora)

Edite `src/` e `package.json`; NÃO edite `web/` (é do T00). Mantenha os testes passando (hoje 25) e acrescente testes para o que criar.

1. `package.json` com `"scripts": { "start": "node src/server.js", "test": "node --test --test-force-exit tests/dominio.test.js tests/api.test.js" }` e `"engines": { "node": ">=20" }`.
2. `GET /saude` sem autenticação devolvendo `{ "ok": true }` e nada mais.
3. **CORS** com lista exata de origens em `KENDJI_CORS_ORIGENS` (separadas por vírgula). Responder `OPTIONS` (preflight) com 204. Só devolver `Access-Control-Allow-Origin` quando a origem da requisição estiver na lista (nunca `*`, nunca credenciais/cookies). Permitir os cabeçalhos `Authorization`, `Content-Type`, `Idempotency-Key`, `X-Operador` e os métodos `GET, POST, PATCH, DELETE, OPTIONS`; `Access-Control-Max-Age: 600`; `Vary: Origin`. Sem a variável, não enviar nenhum cabeçalho CORS (comportamento atual). Testes: origem permitida, origem negada, preflight, sem variável.
4. **Limite de requisições** em memória: no máximo 20 tentativas com chave inválida por minuto por IP (depois 429) e 300 requisições por minuto por chave válida. Use `X-Forwarded-For` só se `KENDJI_CONFIAR_PROXY=1`.
5. As 3 empresas de demonstração que `src/server.js` cria hoje só existem com `KENDJI_DEMO=1`. Em produção o servidor começa vazio.
6. `.env.example` com os NOMES das variáveis (`PORT`, `KENDJI_TOKEN_CLIENTE`, `KENDJI_TOKEN_INTEGRACAO`, `KENDJI_ADMIN_SENHA`, `KENDJI_HISTORICO_ARQUIVO`, `KENDJI_CORS_ORIGENS`, `KENDJI_CONFIAR_PROXY`, `KENDJI_DEMO`) e valores vazios. Sem segredos.

Aceite da parte A: testes verdes; `GET /saude` 200; a 21ª tentativa seguida com chave errada em 1 minuto devolve 429; servidor sem `KENDJI_DEMO` começa com `GET /empresas` igual a `[]`.

## Parte B: publicar a API (BLOQUEADA até o João informar a hospedagem Node e o endereço)

Antes de publicar qualquer coisa, confirme com o João: qual hospedagem Node, como acessar e o endereço final. Regras obrigatórias:

1. **Nunca** usar as chaves de demonstração (`demo-equipe`, `demo-integracao`, `demo-chat`) nem a senha de administrador da demonstração.
2. Gerar valores novos e fortes (pelo menos 32 bytes aleatórios, por exemplo `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`) para `KENDJI_TOKEN_CLIENTE`, `KENDJI_TOKEN_INTEGRACAO` e `KENDJI_ADMIN_SENHA`.
3. **Não** definir `KENDJI_TOKEN_CHAT` (chave global que enxerga todas as empresas).
4. Colocar esses valores só nas variáveis de ambiente/segredos da hospedagem. Nunca em arquivo do repositório, commit, log ou mensagem do `visao-msg`. Guardar uma cópia para o João num arquivo FORA do repositório e informar apenas o CAMINHO.
5. Só HTTPS. `KENDJI_CORS_ORIGENS` com o endereço exato do painel no `/sites`.
6. Não alterar o NicoChat nem outros projetos. Não fazer `git push`.
7. Verificar sem vazar segredo (`curl -H "Authorization: Bearer $VARIAVEL"` mostrando só o código HTTP).

Aceite da parte B: `https://<api>/saude` 200; `GET /empresas` sem chave 401 e com `demo-integracao` 401; com a nova chave de integração devolve `[]`; CORS aceita só o endereço do painel.

Limitação a informar ao João: empresas, reservas, conhecimento e chaves das empresas ficam em memória e somem quando o processo reinicia (só o histórico pode ir para arquivo). Serve para o teste com o NicoChat; produção real exige banco ou armazenamento (ver TASK-004).

## Parte C: painel estático (T00)

`web/config.js` define o endereço da API (`window.ONE_CONFIG.apiBase`); vazio significa mesma origem (como hoje). O painel prefixa todas as chamadas com esse endereço. Publicar `web/` no `/sites` só depois da Parte B, com `apiBase` apontando para a API.

## Entrega (`visao-msg send --type conclusao`, sem segredos)

Arquivos alterados, resultado de cada critério de aceite, o que ficou sem verificar. Atualize o `HANDOFF.md` (bloco Status intacto) e faça commit local (sem push), sem segredos.
