# Plano: ChatFlow inteiro no Sites (Worker + D1 + R2)

Arquiteto: T00. Data: 2026-11-22. Decisão do João: considerar apenas `https://chatflow-painel.joaolopes.chatgpt.site/` como hospedagem. O Sites só roda estático ou Worker ES module com `fetch(request, env, ctx)`; não há processo Node. Hoje o painel está no ar sem API, e o login mostra "Chave inválida" porque a chamada cai na plataforma (401).

Base: `docs/portabilidade-worker.md` (TASK-004), `docs/atomicidade.md`, skill Sites em `C:/Users/Joao Lopes/.codex/plugins/cache/openai-curated-remote/sites/1.1.7/skills/sites/` (SKILL.md, references/storage.md, references/identity-and-secrets.md, templates/worker-esm-starter). Leiam antes de agir. Quem tem o plugin Sites (Codex) publica; os demais preparam o código.

## Setores

- Banco de dados (T002 coordena): `src/d1/repositorio.js` com a mesma interface de `src/repositorio.js` e `src/sqlite/repositorio.js` (inclui Contrato A), schema D1 a partir de `db/migrations/0001` e `0002`, arquivos de conhecimento no R2, prova de concorrência.
- Frontend e Backend (T001 coordena): `worker/index.js` com adaptador `Request`/`Response` sobre `tratar()` de `src/nucleo.js`, entrega do painel `web/` (assets), tokens por `env`, `/saude`, build ESM, manifesto e publicação no Sites.

## Contrato C: repositório D1 (Banco entrega, Backend consome)

- Exporta `criarStoreD1(env)` devolvendo o mesmo objeto de repositório (todas as funções async, mesmos retornos e mesma ordem de chaves JSON dos outros dois repositórios).
- `tests/` existentes (contrato-a, sqlite, api) rodam também contra o D1 local (miniflare ou `wrangler`/runtime local do starter), sem mudar as asserções.
- D1 não tem transação interativa: usar `batch()` e escritas condicionais. Reserva (verificar conflito de 90 min e inserir), reativação, edição de mesa, idempotência e histórico precisam de atomicidade comprovada por teste concorrente. Se `batch()` não bastar, documentar a lacuna em `docs/atomicidade.md` e propor o desenho antes de seguir.
- Migrações só no schema (sem seeds). Demonstração apenas com `CHATFLOW_DEMO=1`.
- R2: bytes dos anexos com chave opaca por empresa; download passa pela autorização da API; nunca bucket público.

## Contrato D: Worker (Backend entrega)

- `export default { fetch(request, env, ctx) }`. Corpo lido sob demanda com limite por bytes (512 KiB normal, 6 MiB arquivo), como hoje.
- Configuração por `env`: `CHATFLOW_TOKEN_CLIENTE`, `CHATFLOW_TOKEN_INTEGRACAO`, `CHATFLOW_ADMIN_SENHA`, `CHATFLOW_CORS_ORIGENS`, `CHATFLOW_FUSO`. Sem `CHATFLOW_TOKEN_CHAT`. Segredos só em valores de runtime do Sites, nunca no repositório.
- Mesma origem: o painel e a API no mesmo host, `apiBase` vazio. `GET /saude` sem autenticação devolve `{ "ok": true }`.
- Tudo fora de `src/node/` já é JS padrão e Web API; o Worker não pode importar `src/node/`, `node:` nem `Buffer`.
- Limite de requisições compartilhado (hoje em memória do processo): usar D1 ou aceitar por isolate e documentar o limite.

## Critérios de aceite

1. `https://chatflow-painel.joaolopes.chatgpt.site/saude` responde 200 e `GET /empresas` sem chave responde 401.
2. Login no painel com a chave de equipe funciona; criar empresa, reserva, editar, cancelar, excluir definitivo, ambiente e mesa funcionam e sobrevivem a novo acesso (persistência real).
3. Régua `tests/api.test.js` verde contra o Worker local; `CHATFLOW_TESTE_OPERACAO=1 npm test` continua verde (130/130).
4. Teste concorrente de reserva sem dupla marcação.
5. HANDOFF atualizado, bloco Status validado. Sem commit nem push sem pedido do João. Sem segredos em arquivo ou mensagem.

## Riscos para reportar cedo

- Sites exigir login da plataforma na frente de tudo (o site já devolve 401 para quem não está logado): confirmar se `/empresas/...` chamada pelo NicoChat (nuvem, sem sessão) passa; se não, reportar ao T00 antes de seguir.
- D1 sem transação interativa; limite de 128 MB por isolate; KV e Durable Objects não suportados.
- Estimativa original: 12 a 20 dias úteis de uma pessoa. Entregar em marcos: (1) Worker com D1 só leitura/login, (2) reservas e histórico, (3) conhecimento no R2.
