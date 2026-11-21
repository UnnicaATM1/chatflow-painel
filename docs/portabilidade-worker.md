# Portabilidade do ONE para Worker do Sites

TASK-004. Levantamento em 15/11/2026. Único artefato desta tarefa: este documento. Sem mudança de código, publicação, criação de recursos ou credenciais.

## Síntese e recomendação

**Recomendado para o teste imediato com o NicoChat:** manter a API Node em hospedagem HTTPS a definir, com o painel estático no Sites conforme [plano de publicação](publicacao-sites.md). Isso aproveita o transporte atual, mas não resolve a perda de dados em memória ao reiniciar.

**Recomendado como destino da portabilidade:** Worker com adaptador HTTP próprio, **D1 para dados estruturados e R2 para arquivos**. A skill Sites documenta o provisionamento desses dois bindings. Separar regras de negócio, repositórios persistentes e transporte permite manter Node e Worker durante a transição. Não é apenas trocar `listen` por `fetch`: requer persistência, controle de concorrência, auditoria e integração de acesso do Sites.

Estimativa preliminar de engenharia: **12 a 20 dias úteis de uma pessoa**, incluindo validação local e homologação de um ambiente de teste. Não é prazo fechado nem cotação financeira. Depende de confirmar runtime/build, concorrência de reservas, autenticação de serviço, volume e transferência dos dados atuais. A espera por acesso, decisões e homologação externa não está incluída.

## Fontes, grau de certeza e fotografia analisada

Fontes do projeto: [store](../src/store.js), [servidor](../src/server.js), [API](../src/api.js), [reservas](../src/reservas.js), [agentes](../src/agentes.js), [mapa](../src/mapa.js), [conhecimento](../src/conhecimento.js), [contexto](../src/contexto.js), [histórico](../src/historico.js), [testes de domínio](../tests/dominio.test.js), [testes de API](../tests/api.test.js), [painel](../web/app.js), [HTML](../web/index.html) e [configuração pública](../web/config.js).

Documentação local do plugin consultada, relativa à raiz `C:/Users/Joao Lopes/.codex/plugins/cache/openai-curated-remote/sites/1.1.6/skills/sites/`:

- `SKILL.md`: contrato do Worker, manifest, publicação e limite de 128 MB por isolate; conexões externas HTTP, sem TCP bruto.
- `references/storage.md`: D1/R2, bindings, migrações e operações SQL.
- `references/identity-and-secrets.md`: identidade, acesso de serviços e valores de runtime.
- `templates/worker-esm-starter/README.md`: contrato `fetch(request, env, ctx)` e empacotamento do starter mínimo.
- `templates/vinext-starter/README.md`: integração de build, ambiente local Worker e migrações D1.

“Observado” indica código ou documentação lida. “Proposta” indica desenho recomendado; não representa código implementado. “A confirmar” indica capacidade/contrato que essas fontes não demonstram. Não foi feita consulta à conta ou a serviços de hospedagem. Fotografia do HEAD durante a leitura: `e030362`; T01/T00 mantêm trabalho paralelo, portanto revalidar antes de implementar. Foram encontrados **39 casos declarados** nos dois arquivos de testes, não apenas os 25 originais. Essa contagem não afirma execução verde da revisão atual; nenhum teste foi executado nesta TASK-004.

## 1. Uso de Node e adaptação do runtime

| Uso observado | Arquivo real | Equivalente proposto / impacto no Worker |
|---|---|---|
| `node:http`, `http.createServer`, `listen` e porta | `src/api.js`, `src/server.js` | Substituir o ponto de entrada por ES module com default export contendo `fetch(request, env, ctx)`, contrato documentado pelo starter. Não há processo de servidor ouvindo `PORT` a administrar nesse modelo. |
| `req.method`, `req.url`, `req.headers`, eventos `data/end/error`, `destroy` | `src/api.js` | Adaptador sobre Request/Headers/ReadableStream. Proposta: ler JSON com limite efetivo por bytes, inclusive sem Content-Length, e produzir erros equivalentes. Não substituir por leitura integral sem limite. |
| `res.writeHead`, `res.end`, cálculo de tamanho JSON | `src/api.js` | Construir Response com status, cabeçalhos e corpo; usar codificação UTF-8 para tamanho quando necessário. Preservar JSON de erro, downloads, redirecionamento `/app` e status existentes. API Web concreta e tratamento de streaming a validar no runtime local. |
| `node:fs`, `node:path`, `__dirname`, leitura síncrona do painel | `src/api.js` | Remover acesso ao disco de runtime. Entregar assets pelo build/hosting documentado ou por handler específico validado; caminhos de API continuam separados dos assets. |
| `fs.appendFileSync` para trilha JSONL opcional | `src/historico.js` | Proposta: tabela de eventos D1; R2 para exportações. Não presumir que exista disco persistente ou append de objeto equivalente a arquivo. |
| `node:crypto`: SHA-256, comparação temporal, 32 bytes aleatórios e UUID | `src/api.js`, `src/historico.js` | Proposta: adaptador criptográfico com Web Crypto para digest e bytes aleatórios; operações assíncronas propagam `await`. UUID e comparação resistente a diferenças de tempo precisam de confirmação/testes no runtime escolhido. Não substituir `timingSafeEqual` por igualdade simples de strings. |
| `Buffer.from/concat/byteLength`, base64, UTF-8 e inspeção de bytes | `src/api.js`, `src/conhecimento.js` | Proposta: Uint8Array, TextEncoder/TextDecoder e conversão base64 testada. Verificar bytes de assinatura, tamanho, conteúdo vazio e download. Não assumir compatibilidade Node/Buffer sem verificar flags e build do Sites. |
| `process.env` | `src/server.js`, `src/store.js` | Injetar configuração por `env` do handler/bindings. A skill documenta valores de runtime e acesso server-side a bindings; não depender de leitura global de ambiente ao importar módulos. |
| CommonJS `require/module.exports` (incluindo require dentro de função) | Todos os nove módulos de `src/` | Converter para ESM ou validar bundler que compile o domínio CommonJS. O artefato final precisa ser ESM; suporte aos imports Node atuais não está garantido pela skill. |
| Date, `Date.now`, contadores e prazos | `src/api.js`, `src/reservas.js`, `src/historico.js` | Injetar relógio nos serviços; persistir prazos quando precisam valer entre requisições. Em reservas, a conversão de data/hora sem offset usa o ambiente: definir fuso da unidade e testes de fronteira. |
| Timers | Pesquisa em `src/` | Não foram encontrados `setTimeout` ou `setInterval`. Rate limit e bloqueio administrativo comparam timestamps ao receber requisição. Não há motivo observado para criar cron ou timer de processo. |

O domínio em `src/agentes.js`, `src/mapa.js`, partes de `src/reservas.js`, `src/conhecimento.js` e `src/contexto.js` pode reaproveitar validações e transformação de respostas. Entretanto, o acesso direto a Maps/arrays e mutações síncronas não vira persistência remota apenas com bundling. Recomendado extrair repositórios e tornar explícitas as operações assíncronas antes de ligar D1.

Limites atuais a preservar: corpo normal de 512 KiB e corpo de arquivo de 6 MiB na API; documento de até 4 MiB e até 200 itens de conhecimento por empresa no domínio. O limite documentado de 128 MB por isolate torna inadequado reconstruir todo o store e todos os arquivos base64 em cada chamada. Capacidade de upload, CPU, quotas, latência, custo e limites de D1/R2 da conta precisam de confirmação; não foram cotados.

## 2. Estado atual e persistência

### Escolha das tecnologias

| Opção | O que está confirmado pela skill Sites | Vantagem para o ONE / limite |
|---|---|---|
| **D1, recomendado para registros** | Binding lógico em `.openai/hosting.json`, normalmente `DB`; Sites provisiona e conecta. Uma instrução por `prepare()`, `batch()` para várias. Migrações aplicadas na publicação. | Adequação proposta: empresas, permissões, reservas, idempotência e auditoria consultáveis com SQL. Requer schema, índices, isolamento por empresa e comprovação de atomicidade do fluxo de reserva. A referência não define todos os detalhes transacionais necessários. |
| **R2, recomendado para bytes** | Binding lógico, normalmente `BUCKET`; arquivos enviados/gerados acessados server-side por env. | Adequação proposta: documentos e exportações, sem carregar base64 de todo o catálogo. Operações entre R2 e D1 não devem ser tratadas como uma transação única: prever pendências e limpeza de órfãos. |
| KV | Não documentado como binding suportado nesta versão da skill/manifest. | A confirmar antes de estimar uso. Não recomendado como requisito da primeira versão ou como fonte de verdade de reservas sem validar disponibilidade e garantias de concorrência. |
| Durable Objects | Não documentados como binding suportado nesta versão da skill/manifest. | Avaliar futuramente coordenação de mutações por empresa, se provisionamento e garantias forem confirmados. Não assumir que uma capacidade geral da Cloudflare está disponível via Sites. |
| Memória/localStorage | Código usa memória de processo; skill reserva armazenamento de navegador para preferências locais. | Não serve como persistência compartilhada dos registros. Proposta: memória apenas como cache descartável, sem fonte de verdade ou contadores autoritativos. |

Não se afirma que KV ou Durable Objects sejam impossíveis; o suporte via Sites não está demonstrado pelas referências consultadas. A recomendação D1 + R2 evita depender desses recursos não confirmados.

### Mapeamento dos dados

| Estado observado | Origem | Destino proposto e cuidado |
|---|---|---|
| `empresas: Map`, agente, permissões por campo e flags de módulos | `src/store.js`, `src/agentes.js`, `src/api.js` | D1: registros com identificador de empresa em toda consulta; preservar permissões, limites e desligamento de módulos. Ambiente e mesas podem ser tabelas relacionadas; escolher JSON apenas quando não prejudicar integridade/consulta. |
| `reservas: []`, horários de início/fim, nome e contato do cliente | `src/reservas.js` | D1 com índices por empresa/mesa/período. Hoje a verificação de conflito e inserção acontecem sem await no mesmo processo; em storage remoto isso pode intercalar. A reserva deve verificar e escrever com atomicidade comprovada. Apenas UNIQUE por mesa/data não resolve intervalos de 90 minutos que se sobrepõem. |
| `chaves: Map` para idempotência, incluindo resultados indisponíveis | `src/reservas.js` | D1 com unicidade por empresa + chave, resultado persistido e política de expiração a definir. Preservar reenvio idempotente após reinício; definir comparação do corpo ao reutilizar uma chave e comportamento em corrida. Não confundir esse Map com as chaves de acesso. |
| `seqReserva` e geração de ids de empresa por contagem/histórico | `src/reservas.js`, `src/api.js` | Sequências/identificadores persistentes e únicos, sem depender de quantidade de linhas ou de memória. Manter contrato de IDs numéricos enquanto necessário; se mudar para UUID, adaptar URLs e testes que convertem IDs com Number. |
| Itens de conhecimento, tabelas, texto, `proxConhecimento` e arquivo base64 | `src/conhecimento.js`, `src/store.js` | Metadados/texto/tabelas em D1; bytes em R2, com chave opaca vinculada à empresa. Download passa pela autorização da API; não tornar bucket público para simplificar. Preservar MIME, extensão permitida, assinatura, Content-Disposition, nosniff e sandbox. |
| Hash, prefixo e criação da chave de API por empresa | `src/api.js`, `src/store.js` | D1, indexar hash e escopo. Conservar retorno do segredo apenas na geração e revogação efetiva em todas as instâncias. Não persistir nem registrar valor bruto da chave. |
| `historico: []`, seq, UUID de boot, antes/depois, papel/operador, instantâneo de exclusão | `src/historico.js`, `src/api.js` | D1 append-only com identificador estável e referência para desfazer. Proposta: registrar mutação e evento na mesma unidade atômica quando possível; não responder sucesso antes da auditoria obrigatória. UUID de boot é de processo, não identidade durável do evento. |
| Arquivo JSONL opcional de auditoria | `src/historico.js` | Substituir por D1 e exportações para R2. Leitura atual do JSONL não reconstrói empresas/reservas: ele não é backup completo restaurável do store. Definir importação/exportação e retenção. |
| Baldes de rate limit e `tentativasAdmin` | `src/api.js` | Contadores e deadlines compartilhados, com política explícita de expiração. `tentativasAdmin` hoje é global ao store, com bloqueio após cinco erros por quinze minutos; definir se preservar ou particionar por ator/empresa. |

**Maior risco técnico:** concorrência entre reserva, reativação, edição de mesa, reenvio idempotente e auditoria. A skill documenta `batch()`, mas isso não comprova automaticamente que uma leitura seguida de escrita em chamadas separadas seja segura. Primeira prova técnica deve testar mutações simultâneas contra D1 local e homologado, ou rever o desenho de alocação com escritas condicionais. Se D1 não atender ao modelo escolhido, validar uma alternativa de coordenação antes de comprometer o prazo.

Migrações: a skill exige schema e SQL gerado/revisado, sem criar tabelas durante requests. Migrations aplicadas são imutáveis e uma publicação que falha pode já ter aplicado o schema. Dados de demonstração e backfills não pertencem às migrações. Inicialização normal não deve criar empresas a cada invocação; seeds somente em ambiente de teste e ação controlada.

## 3. Rate limit, CORS, saúde, segredos e painel

### Rate limit e IP

Observado em `src/api.js`: janela de um minuto, até 20 falhas de chave por IP e 300 chamadas por chave válida, com hash da autorização no contador e Retry-After. Saúde e preflight são tratados antes da autenticação. Há ainda proteção separada da senha administrativa.

Proposta para Worker: preservar o contrato HTTP, mas retirar contadores autoritativos de Map global. Para a primeira solução apenas com bindings documentados, avaliar contadores D1 com incremento condicional atômico, chave por identidade/janela e expiração lógica; medir custo e contenção antes de adotar. Durable Object ou limitador nativo só entram após confirmação no Sites. Um Map local não garante limite global entre isolates.

`req.socket.remoteAddress` não existe no handler fetch. A identidade/IP confiável precisa ser confirmada com o contrato de entrada da hospedagem; a skill não especifica um cabeçalho de IP canônico. Não usar X-Forwarded-For arbitrário nem transportar automaticamente a opção de proxy do Node como prova de confiança. Manter testes contra spoofing, reset de janela e isolamento por chave/IP.

### CORS e /saude

- Preservar lista exata de `CHATFLOW_CORS_ORIGENS`, Vary: Origin, métodos/cabeçalhos autorizados, max-age 600, OPTIONS 204, sem wildcard ou credenciais. Sem configuração, não enviar Access-Control-*.
- Mesmo domínio para painel/API pode dispensar CORS nas chamadas do próprio painel, mas clientes externos e a opção Node separado continuam exigindo contrato explícito. CORS não autentica o NicoChat.
- `GET /saude` deve continuar devolvendo somente `{ "ok": true }` sem autenticação da aplicação. Em Site privado, o gate da plataforma pode interceptar antes do Worker: “público” na aplicação não garante alcance externo. Validar com requisição de serviço no ambiente homologado, sem mudar audiência automaticamente.

### Segredos e acesso de serviços

Variáveis de equipe/integração, senha administrativa e configurações devem entrar via ambiente/bindings server-side. A skill exige ferramentas nativas para configurar runtime; valores não entram em source, bundle cliente ou `.openai/hosting.json`. A chave global legada de chat não deve ser habilitada na publicação planejada. Nenhum segredo foi gerado nesta tarefa.

A skill documenta identidade ChatGPT em cabeçalhos e, para serviços em Site privado, credencial própria em `OAI-Sites-Authorization` quando disponibilizada pela plataforma. Essa camada é separada do Bearer da API ONE e não fornece identidade de visitante. Confirmar audiência e como o NicoChat enviará ambas as autorizações, quando necessárias; não criar/rotacionar credenciais apenas para investigar. Um Site público também precisa da autorização da API em cada ação protegida.

O nome em X-Operador atualmente é um rótulo informado pelo cliente, não identidade comprovada. Ao associar identidade da plataforma, manter o escopo de empresa e os papéis da aplicação; não tratar login na plataforma como autorização de qualquer empresa.

### Painel como assets

Observado: `web/index.html` usa React/ReactDOM por CDN, bundle local, `web/config.js` e `web/app.js`. A configuração pública `apiBase` já permite API em outra origem; o painel usa Bearer e sessionStorage. O backend Node hoje serve uma lista fechada de arquivos sob `/app/`.

1. **Etapa imediata recomendada:** publicar apenas os arquivos públicos de `web/` como site estático, após a API Node estar homologada. A skill aceita diretório de assets com index.html e manifest `static.directory` suportado. O conteúdo de `web/` precisará ser preparado em um diretório de saída suportado; não enviar o repositório inteiro como assets. A correspondência entre raiz do site e `/app/`, URLs relativas, logo, config e downloads precisa de revisão.
2. **Destino unificado proposto:** Worker com API e painel na mesma origem, usando build compatível com o fluxo Sites e saída `dist/server/index.js`. O manifest desse modo omite `static`; não basta somar campos de site estático a um build Worker. Preservar `/app/`, rotas API, erros e prioridade de roteamento dos assets.
3. **Limite confirmado:** o starter Worker ESM mínimo copia somente seu módulo e manifest e proíbe adicionar arquivos de assets avulsos; essenciais devem ser embutidos. Portanto ele não empacota automaticamente o atual `web/`. Recomendado validar o build com integração Sites/Vinext e sua entrega de assets, preservando os arquivos públicos existentes; alternativa de embutir tudo exige um build próprio validado e não é o primeiro caminho recomendado para este painel.
4. `ASSETS.fetch`, regras de fallback de SPA, limites de arquivo, cache e funcionamento de assets com gate privado não foram demonstrados pelas referências lidas: confirmar antes de especificar esses mecanismos como disponíveis. Não prometer que a simples cópia de `web/` funciona no starter mínimo.
5. Arquivos de conhecimento em R2 continuam protegidos por API, separados dos assets públicos. Verificar links relativos gerados por `src/conhecimento.js` e `src/contexto.js` e os downloads via `web/app.js`, sobretudo enquanto painel e API tiverem origens diferentes.

## 4. Adaptação dos testes

Preservar os **25 casos originais** como regressão e incorporar os adicionados na TASK-003/integração do painel. A fotografia lida contém 5 testes de domínio e 34 de API, total 39; a base é móvel. Recontar no commit de início da portabilidade, sem descartar novos casos para voltar a 25.

| Camada | Arquivo atual | Adaptação proposta |
|---|---|---|
| Regras de domínio | `tests/dominio.test.js` | Manter validações, escopo por empresa, permissões, idempotência, disponibilidade e mapa. Adaptar imports ESM e fixtures; separar regras puras de testes de repositório. Adicionar await apenas quando a API de persistência o exigir. |
| Contrato HTTP | `tests/api.test.js` | Hoje `subir()` cria servidor em porta efêmera e chama fetch. Criar harness do handler com Request/Response ou runtime local Worker, preservando status, JSON, cabeçalhos, permissões, downloads e todas as operações. Teste direto do handler não substitui teste com D1/R2 reais locais. |
| Inicialização | `tests/api.test.js` | Casos que usam child_process/net para executar `src/server.js` continuam no adaptador Node. No Worker, verificar ambiente sem seed e seed explícito controlado, sem reaplicar por invocação e sem apagar dados de ambiente persistente. |
| Persistência | Novos testes futuros | Repositório em memória e D1 com contrato equivalente; recursos locais isolados por teste, aplicação de migrations e R2 de teste. A skill documenta ambiente local Miniflare/Wrangler pelo starter; escolha da biblioteca de testes ainda a confirmar. |
| Concorrência e segurança | Novos testes futuros | Duas reservas simultâneas para mesma mesa/período; mesma chave idempotente em duas chamadas; conflito em reativar/editar; revogar chave e ler em nova instância; não ler arquivo de outra empresa; falha de auditoria e rollback; upload inválido e acima do limite. |
| Operação | Homologação futura | Dados sobrevivem a nova instância/deploy; CORS permitido/negado e sem variável; OPTIONS, saúde, 21ª falha por IP, 301ª por chave e nova janela em múltiplas instâncias; acesso do NicoChat ao gate e HTTPS. |

Usar relógio injetável, fixtures sem credenciais de demonstração e nenhuma impressão de segredos. Fixtures do domínio devem ser pequenas; D1/R2 locais são diferentes dos recursos hospedados. Testes locais não comprovam gate, segredo, IP de entrada nem comportamento multi-instância de produção. Não criar contêineres/runtime ou executar testes nesta entrega documental enquanto o T01 é dono da TASK-003.

## 5. Etapas, esforço e riscos

Estimativa de dias úteis de execução, com uma pessoa já familiarizada com o código e apoio de revisão. Faixas incluem testes da respectiva etapa; paralelismo e aprendizado da plataforma podem alterar duração.

| Ordem | Entrega futura e critério para avançar | Esforço estimado |
|---|---|---|
| 1 | Prova local de Worker ESM, build com assets, bindings D1/R2, ambiente e acesso de serviço. Confirmar IP confiável e quotas sem publicar produção. | 1 a 2 dias |
| 2 | Separar transporte Node, serviços e repositórios; definir contrato de erro, relógio e crypto; manter testes Node. | 1 a 2 dias |
| 3 | Schema e migrations: empresas, agente/permissões, mesas, reservas, idempotência, chaves e eventos; desenho de concorrência validado por teste. | 2 a 3 dias |
| 4 | Implementar repositórios D1 e fluxos atômicos de reserva, edição, cancelamento/reativação, desfazer e auditoria. | 3 a 4 dias |
| 5 | Conhecimento em D1/R2, upload/download, validação de bytes e recuperação de falhas entre recursos. | 1 a 2 dias |
| 6 | Adaptador fetch, autenticação, env, saúde, CORS e rate limit compartilhado; revisão do gate de serviços. | 1 a 2 dias |
| 7 | Integrar assets e caminhos do painel, fechar paridade dos testes e regressão de concorrência/isolamento. | 2 a 3 dias |
| 8 | Preparar transferência de dados, plano de reversão, homologação HTTPS com cliente de serviço e relatório de aceite, quando autorizada. | 1 a 2 dias |
| | **Total preliminar** | **12 a 20 dias** |

### Riscos que alteram a estimativa

- **Concorrência/atomicidade:** prova D1 pode exigir outro desenho de alocação ou recurso de coordenação ainda não confirmado no Sites. É dependência crítica, não detalhe posterior.
- **Dados existentes:** memória não é exportação completa por si só; JSONL não restaura tudo. Transferir registros antes de desligar o Node, verificar contagens e documentos, evitar dois gravadores ativos sem coordenação e definir reversão com escritas novas.
- **128 MB e limites de execução:** base64 amplia consumo; `src/contexto.js` e busca de conhecimento varrem dados. Definir paginação/consultas e evitar carregar todo o catálogo a cada request. Quotas e custo continuam a confirmar.
- **Tempo/fuso:** datas sem offset em reservas podem mudar resultado entre ambientes. Homologar fuso, datas inválidas e sobreposição na fronteira de 90 minutos.
- **Auditoria e desfazer:** histórico copia dados pessoais e instantâneos; definir retenção, autorização, integridade e atomicidade com a operação. Append-only no código não comprova imutabilidade contra administrador do storage.
- **Plataforma e acesso:** privado pode bloquear NicoChat e saúde antes de entrar na aplicação; público exige preservar autorização própria. Confirmar acesso de serviço, não alterar audiência por conveniência.
- **Empacotamento:** CommonJS/Node não tem compatibilidade completa prometida pela skill; starter ESM simples não inclui `web/`. Validar cedo, sem reescrever a interface por pressuposto.

### Decisão proposta ao Arquiteto

Para validar rapidamente a integração, **recomendado seguir Node separado agora**, com persistência planejada e sem apresentar o armazenamento em memória como produção durável. Para o objetivo explícito do João de migrar depois, **recomendado preparar domínio/repositórios independentes do transporte e executar uma prova Worker + D1 + R2 antes de fechar compromisso de prazo**.

Portar agora é justificável se concentrar tudo no Sites e obter persistência forem prioridades maiores que a rapidez do primeiro teste. O custo de apenas hospedar o Node não foi estimado aqui, pois provedor, acesso e domínio não foram definidos. Mesmo no Node, adicionar banco exige trabalho próprio; os 12 a 20 dias incluem essa mudança e não são só custo do runtime.

## Pendências e verificação desta entrega

- Confirmar com Arquiteto a prioridade Node imediato versus portabilidade, build de assets, identidade/IP de entrada e acesso de serviço do NicoChat.
- Confirmar quotas/custos, estratégia atômica das reservas, fuso, retenção e exportação/importação dos dados em memória.
- Validar KV/Durable Objects apenas se se tornarem necessários; não incluídos como capacidade garantida do Sites.
- Único arquivo novo: `docs/portabilidade-worker.md`. Cada caminho de projeto citado e cada fonte local do plugin deve existir no disco; os links relativos são verificáveis sem acessar serviços.
- Levantamento sem migração, sem nova execução de testes de código e sem publicação. O handoff e os arquivos dos outros executores foram preservados; o coordenador pode incorporar este resultado à continuidade do projeto.

## Estado depois da TASK-005

O código de `src/` ficou **independente do Node**, ainda rodando em Node (48 testes seguem verdes). O que está pronto:

- **Plataforma injetável** (`src/plataforma.js`): relógio, uuid, aleatório, SHA-256, comparação em tempo constante e base64 entram por uma interface. Há duas implementações: `plataformaWeb()` (só Web API: `crypto.subtle`, `atob`/`btoa`, serve para Worker) e `src/node/plataforma.js` (`node:crypto`).
- **Núcleo como função de requisição** (`src/nucleo.js`): `tratar(req, ctx) -> { status, headers, corpo }`, com roteamento, autenticação, CORS, limite de requisições, validações e histórico. Um adaptador `fetch` de Worker só precisa montar o `req` a partir de um `Request`, chamar `tratar` e montar o `Response`.
- **Adaptador Node fino** (`src/node/servidor.js`) e inicialização (`src/node/inicializar.js`): lê o corpo, serve `web/` (só no Node; no Sites os assets são do Sites) e grava o histórico em arquivo (sink injetado).
- **Repositório** (`src/repositorio.js`): toda leitura e escrita de dados passa por funções `async`, com a versão em memória. Operações que exigem atomicidade têm nome próprio (ver `docs/atomicidade.md`).
- **Datas sem fuso** (`src/tempo.js`): sobreposição calculada em minutos absolutos (`Date.UTC`), sem `new Date('...T...')`. `CHATFLOW_FUSO` (padrão `America/Sao_Paulo`) é carregado, mas nenhuma regra compara reservas com "agora" ainda.
- **Testes**: o núcleo é chamado direto, sem rede; a mesma bateria roda com as duas plataformas e pelo servidor Node com transcrição idêntica; um teste falha se algum arquivo de `src/` (fora de `src/node/`) usar `require(`, `node:`, `Buffer` ou `process.`.

O que **falta** para publicar no Sites:

1. **D1**: escrever `src/d1/repositorio.js` com a mesma interface de `src/repositorio.js` (esquema, migrações, índices de sobreposição por mesa, `UNIQUE` de idempotência e de `ref_seq` do histórico).
2. **R2**: guardar os arquivos do conhecimento (hoje `arquivo.base64` dentro do item) e servir o download com os mesmos cabeçalhos.
3. **Adaptador `fetch`**: `Request` para `req` e `{ status, headers, corpo }` para `Response`; ler `CHATFLOW_*` do `env` do Worker; `ctx.ip` vem de `CF-Connecting-IP`.
4. **Assets**: publicar `web/` como estático do Sites (já é desacoplado por `web/config.js`); remover a dependência do servidor de arquivos do Node.
5. **Limite de requisições compartilhado**: hoje em memória por instância (Durable Object ou KV).
6. **Módulos**: confirmar se o Sites aceita ESM como está (`src/package.json` com `"type": "module"`) ou se precisa de bundle. Não verificado aqui.
7. **Bloqueio de senha do administrador** e **desfazer** atômicos (lacunas listadas em `docs/atomicidade.md`).
