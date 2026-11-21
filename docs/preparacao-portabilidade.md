# Deixar o ONE pronto para portar (TASK-005)

Pedido do João: não é cotar, é **contar com a portabilidade e deixar pronto**. O destino futuro é a estrutura do Sites
(Worker ES module com `fetch`, D1 para registros, R2 para arquivos; ver `docs/portabilidade-worker.md`, etapa 2).
Esta tarefa NÃO porta nem publica: ela torna o código atual **independente do Node**, mantendo-o rodando em Node.

Executor: T01. Edita só `src/` e `tests/`. NÃO editar `web/` (é do T00). Sem dependências novas. Sem mudar o contrato HTTP.

## Regras de ouro

1. Todos os 39 testes continuam verdes a cada passo (`npm test`). O comportamento externo (rotas, status, JSON, cabeçalhos) não muda.
2. Nada de `node:*` nem `Buffer`/`process`/`fs`/`require` fora do adaptador Node (`src/node/`). O núcleo usa só JavaScript padrão e a Web API (`Request`, `Response`, `URL`, `TextEncoder`, `crypto.subtle`, `atob`/`btoa`, `Uint8Array`).
3. Commits pequenos por passo, sem segredos, sem push.

## Passos

**1. Plataforma injetável.** Criar `src/plataforma.js` com a interface que o núcleo usa e uma implementação Node em `src/node/plataforma.js`:
`agora()` (ms), `uuid()`, `aleatorio(bytes)` (base64url), `sha256Hex(texto)` (assíncrono), `iguaisTempoConstante(a, b)` (assíncrono ou sobre hashes), `base64Decodificar(str) -> Uint8Array`, `base64Codificar(bytes)`.
Trocar todo uso de `crypto`, `Buffer` e `Date.now()` em `src/*.js` por essa interface (o relógio injetável também serve aos testes de data).

**2. Núcleo como função pura de requisição.** Extrair de `src/api.js` o miolo para `src/nucleo.js`:
`async tratar(req, ctx) -> { status, headers, corpo }`, onde `req = { metodo, url, headers, corpo: Uint8Array|null }` e `ctx = { store/repositorios, plataforma, tokens, adminSenha, cors, limites }`.
Inclui roteamento, autenticação, CORS, limite de requisições, validações, histórico. O corpo grande é recusado também no núcleo (512 KiB; 6 MiB em arquivos). Erros viram `{ status, corpo: { erro } }` (contrato único; sem `res.writeHead`).

**3. Adaptador Node fino.** `src/node/servidor.js`: lê o corpo do `http.IncomingMessage` (com o limite), chama `tratar`, escreve a resposta. Servir `web/` (arquivos estáticos, lista fechada) fica SÓ aqui, porque no Worker os assets são do Sites. `src/server.js` vira a inicialização (variáveis de ambiente, demo, `listen`).

**4. Repositórios.** Esconder `store` atrás de funções de repositório em `src/repositorio.js` (empresas, agente, ambientes/mesas, reservas, idempotência, chaves de API, conhecimento, histórico), com implementação em memória hoje. Regra: o núcleo e os serviços (`reservas.js`, `agentes.js`, `conhecimento.js`, `mapa.js`, `contexto.js`, `historico.js`) não acessam `store.reservas`, `store.empresas.get(...)` etc. diretamente; chamam o repositório. Assim a versão D1 troca só essa camada. As funções do repositório podem ser `async` (D1 é assíncrono), então o núcleo deve usar `await` nelas.
O sumidouro de auditoria em arquivo (`CHATFLOW_HISTORICO_ARQUIVO`, usa `fs`) passa a ser um **sink injetado** pelo adaptador Node; o núcleo só chama `sink(evento)`.

**5. Operações atômicas nomeadas.** Mapear no repositório as operações que precisam de atomicidade no D1: reservar mesa (checar sobreposição + inserir + registrar idempotência), editar/cancelar/reativar reserva, desfazer, excluir empresa. Cada uma é UMA função do repositório (na versão em memória continua síncrona por dentro). Documentar em `docs/atomicidade.md` o que cada uma garante.

**6. Datas sem ambiguidade.** `new Date(\`${data}T${horario}:00\`)` depende do fuso do ambiente. Trocar por um cálculo explícito de minutos desde a meia-noite da data (sem fuso), com um fuso de negócio configurável (`CHATFLOW_FUSO`, padrão `America/Sao_Paulo`) só onde for preciso comparar com "agora". Testes de fronteira: reserva às 23:30 (cruza a meia-noite) e sobreposição exata de 90 minutos.

**7. Testes.** Um harness que chama `tratar()` direto (sem rede) e roda a mesma bateria de contrato; manter a bateria atual via servidor Node como teste de integração do adaptador. Teste de portabilidade: rodar o núcleo com uma `plataforma` alternativa baseada em `crypto.subtle` e provar o mesmo resultado; e um teste que falha se algum arquivo do núcleo (`src/*.js` fora de `src/node/`) contiver `require(`, `node:`, `Buffer` ou `process.`.

## Critérios de aceite

- `npm test` verde (os 39 atuais + os novos); o painel e o simulador (`nicochat/fluxos/ONE/simular-conversa.js`) continuam funcionando contra `node src/server.js` sem alteração.
- Teste de "núcleo sem Node" passando.
- `docs/atomicidade.md` e um parágrafo em `docs/portabilidade-worker.md` (seção "Estado depois da TASK-005") dizendo o que já está pronto e o que falta (D1, R2, adaptador `fetch`, assets, rate limit compartilhado).

## Entrega (`visao-msg send --type conclusao`, sem segredos)

Arquivos alterados por passo, resultado dos testes, o que ficou sem verificar. Atualize o `HANDOFF.md` mantendo o bloco Status.
