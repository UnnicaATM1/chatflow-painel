# 🔄 Handoff de Turno — ChatFlow Painel
> Última atualização: 2026-11-25 — por: Claude (T00)

## 📊 Status

<!-- STATUS_START -->
design-system: 60%
telas-referencia: 100%
frontend: 80%
backend: 96%
planejamento-tela-01: 100%
api-rust: 96%
worker-sites: 95%
usuarios-camadas: 90%
geral: 78%
<!-- STATUS_END -->

Regras deste bloco, sempre seguir:
- Uma linha por área/módulo relevante do projeto (adicione ou remova linhas
  conforme as pastas reais do projeto — não force áreas que não existem).
- Formato fixo: `nome-da-area: numero%` — sem texto extra na linha, para
  permitir leitura automática por ferramentas externas.
- `geral` é sempre a última linha e reflete o progresso real do projeto como
  um todo, não uma média simples das áreas.
- Atualize os percentuais toda vez que uma pendência relevante for concluída
  ou criada — nunca deixe desatualizado por mais de uma sessão de trabalho.

## 📍 Onde paramos

Feature 002 (usuários com senha própria por camada) está em `main` (commit 2f6cd4f). Depois dela, o menu "Alimentos e Bebidas" do painel virou "Estrutura de Negócio" e o Reversa Refactor aplicou 4 melhorias no `src/nucleo.js` (registro em `_reversa_refactor/nucleo-api/`): padronização, helpers de limite de login e de senha, `semPermissao()` e `idDe()`, e extração das rotas de sessão e de usuários para `src/rotas-sessao.js` e `src/rotas-usuarios.js`. Além disso nasceu a camada de permissões `src/permissoes.js`: uma tabela `PERMISSOES` (ação para lista de camadas) e `podeFazer(papel, ação)`; para liberar ou bloquear algo para uma camada basta editar a lista da ação ali. A matriz fica guardada em `tests/permissoes.test.js`. Verificação: `CHATFLOW_TESTE_OPERACAO=1 npm test` (196), `npm run test:worker` (41), `npm run test:worker:d1` (42) e `node tests/diferencial-usuarios.js` (65 chamadas JS x Rust, 0 diferenças) verdes.
Site `https://chatflow-painel.joaolopes.chatgpt.site`: precisa republicar com o commit mais novo para ter usuários, a aba Usuários e o menu novo (a migração `0003_usuarios` vai no artefato). Os três usuários de teste (equipe, admin, superadmin) já entraram; o admin só entrou depois de redefinir a senha. NicoChat: `one_url` já aponta para o site e os 4 fluxos ONE estão publicados; `#one` segue inativa até `one_chave` (chave `k1_…` da PARK FOZ, gerada na aba API por superadmin) e `one_empresa` estarem certos.

## ✅ Pendências ativas

- [ ] Camada de permissões em Rust: espelhar a tabela de `src/permissoes.js` em `rust/one-core` (hoje o Rust repete as regras à mão; o diferencial garante a paridade, mas uma regra nova precisa ser escrita nos dois lados). Opportunity OPP-20261125-t8zr em `_reversa_refactor/nucleo-api/`.
- [ ] Refactor restante do `src/nucleo.js` (rotas de empresa, agente, reservas e conhecimento ainda dentro de `tratar()`): rodar `/reversa-refactor` de novo no contexto `nucleo-api`.
- [ ] TASK-004: validar login com João no domínio e testar criação, reabertura e limpeza de uma empresa e reserva de homologação.
- [ ] Bloqueante antes de clientes reais ou do NicoChat: rotacionar `CHATFLOW_TOKEN_CLIENTE`, `CHATFLOW_TOKEN_INTEGRACAO` e `CHATFLOW_ADMIN_SENHA` para valores fortes e distintos. Com a mesma senha, a credencial da equipe também pode confirmar a exclusão de empresas.
- [ ] Homologar HTTPS, proxy, volume SQLite, encerramento e recuperação após kill -9 em contêiner e restauração conjunta do banco e dos anexos conforme `docs/publicacao-producao.md`
- [ ] Definir com o João o objetivo do projeto (app novo, protótipo ou só o design system) e a stack
- [ ] Conferir tipografia e espaçamento do design system com o front-end real (valores são leituras visuais dos prints)
- [ ] Validar o plano da tela 01, os breakpoints propostos e as referências ausentes de conversa preenchida, histórico móvel e apagamentos
- [ ] Após definir stack e escopo, implementar o estado vazio desktop/celular da tela 01 usando `docs/plano-01-atendimento-conversas.md`

- [ ] Validar escrita no R2 e download autorizado de anexo no Sites publicado. O binding D1 e as tabelas migradas foram confirmados pelo plugin.
- [ ] Combinar com a equipe de integração o contrato final da API e a emissão/rotação dos tokens
- [ ] Revisar premissas 🟡 de `_reversa_sdd/prd.md` (duração 90 min, métricas, LGPD)

- [ ] Homologar no painel A&B/Atendimento as rotas de gestão de ambientes e mesas e de exclusão definitiva, incluindo 409 com os códigos de reserva ativos
- [ ] Front A&B/Atendimento: validar modo escuro e layout móvel

- [ ] Publicar a feature 002 no Sites (republicar o commit) e, com `CHATFLOW_TOKEN_INTEGRACAO` forte, criar o primeiro superadmin em `POST /usuarios` (ou na aba Usuários) e depois os usuários de cada empresa; só então aposentar o uso diário dos tokens do env (ficam como acesso de emergência). Eventos feitos por token do env ainda usam o rótulo `X-Operador`.
- [ ] Usuários: limite de tentativas de login é em memória por isolate (tabela `login_falhas` no D1 não foi feita) e não há recuperação de senha por e-mail; no Rust os usuários ficam só em memória

- [ ] Configurar HTTPS e chaves de API por empresa no deploy, com o token global de chat desativado
- [ ] Exclusão de empresa: trocar a senha do administrador por algo forte (a atual tem 6 caracteres; o bloqueio de 5 erros / 15 min mitiga, mas é fraca) e, quando houver contas, trocar a senha única por login real de administrador; avaliar "restaurar empresa excluída" a partir do instantâneo gravado no histórico

- [ ] LGPD: a reserva agora guarda nome e contato do cliente (e o histórico copia esses dados): definir prazo de retenção, base legal e como apagar a pedido do titular antes de usar com clientes reais
- [ ] Busca no conhecimento é por palavras (sem IA): se o catálogo crescer ou as perguntas fugirem das palavras cadastradas, avaliar busca semântica
- [ ] Base de conhecimento: separar os arquivos no R2 para o D1 e extrair texto de PDF, Word e Excel
- [ ] Trocar os `window.confirm` da aba API (gerar nova chave, revogar) por confirmação na própria tela, como já é feito ao excluir item e empresa

- [ ] NicoChat (montado pelo MCP, workspace Unnica Flow 119255, canal ChatFlow `f124625`, pasta ONE `f124625fd5394059`). DESENHO FINAL: toda conversa começa no fluxo `ONE - Conversa (#one)` (`f124625s5116871`): GET `/empresas/{{one_empresa}}/contexto` com Bearer `{{one_chave}}`, resposta inteira (`$`) em `one_ctx` (Long JSON), depois bloco Agente de IA **Nico ONE** (`f124625ag168951`, gpt-5.4-mini). Os campos do agente leem `{{one_ctx :: $.agente.personalidade}}` etc. (testado: o NicoChat renderiza `{{var :: $.caminho}}` de Long JSON). 3 functions de IA (`f124625af261165` search_company_knowledge, `...167` check_table_availability, `...169` book_table) apontam para 3 workflows (`f124625s5116857` buscar, `...859` disponibilidade, `...861` reservar) que chamam a API e terminam em `ai_function_result`. Variáveis do canal: `one_url` (hoje marcador `https://ENDERECO-PUBLICO-DO-ONE`), `one_empresa` (`empresa_1`), `one_chave` (marcador). Variáveis de contato: one_ctx, one_busca, one_disp, one_reserva, one_consulta, one_data, one_horario, one_pessoas, one_mesa, one_ambiente. Palavra-chave `#one` (contains, `f124625s5116871`) criada INATIVA. Nada publicado: tudo em rascunho. FALTA, nesta ordem: (1) ONE com endereço público; (2) gerar a chave da empresa na aba API do ONE; (3) trocar os valores de `one_url` e `one_chave` (variáveis do canal); (4) publicar os 4 fluxos (`channel_sub_flow_publish`); (5) ativar a palavra-chave `#one`; (6) testar. Os 4 "Fluxos de Função" antigos (one_contexto, one_buscar_conhecimento, one_disponibilidade, one_reservar) e `ONE TESTE - leitura de variaveis (temporario)` na pasta ONE estão SUPERADOS e podem ser apagados na tela (o MCP não apaga fluxo). Avisos: o `sandbox_message_send` passa a mensagem de aquecimento pelo fluxo de entrada do canal (UCF - Entrada Atendimento): o teste de 15/11 acionou o agente real do João com um contato de teste (já apagado) e chamou a function save_qualification; para testar de novo, preferir `start_at` em fluxo isolado e checar o `path[]`
- [ ] Publicar o ONE em endereço público (servidor ou túnel): o NicoChat roda na nuvem e não alcança `127.0.0.1`. Depois, testar de verdade o gatilho `#one` ponta a ponta

- [ ] Publicação (decisão do João): o `/sites` só aceita estático ou Worker (ES module com `fetch`), sem processo Node persistente. Para o teste com o NicoChat: API Node em hospedagem que mantém processo ligado (a definir pelo João) e painel `web/` estático no `/sites`. TASK-002 (publicar) BLOQUEADA até o João informar a hospedagem e o endereço; TASK-003 (T01, CONCLUÍDA e validada, 39/39 testes, commits e50ec5b, 36998fd e a639d62): `src/` preparado com package.json, `/saude`, CORS por `CHATFLOW_CORS_ORIGENS`, rate limit, demo só com `CHATFLOW_DEMO=1`, `.env.example`, `config.js` na lista estática e redirect de `/app` para `/app/`; TASK-004 (T02): cotar a portabilidade do ONE para Worker (docs/portabilidade-worker.md). Plano completo em `docs/publicacao-sites.md`

- [ ] Medir a vazão do D1 sob contenção da revisão global e acompanhar as lacunas documentadas em `docs/atomicidade.md`.

- [ ] Rust (decisão do João: o ONE deve ser todo em Rust; a stack em Node foi escolha minha sem confirmar, o projeto não tinha stack definida): TASK-007 com o T01, fase 1 = só a API em `rust/` (crates one-core, one-store, one-node), guiada por `docs/migracao-rust.md`. Premissas assumidas porque o João não respondeu ao escopo: painel em Rust (Leptos/Dioxus) só na fase 2 com OK dele; o JavaScript atual segue intocado e rodando o teste do NicoChat; a versão Rust só substitui quando passar nos testes de contrato HTTP (os 51 testes de `tests/` viram independentes da implementação). Confirmar com o João: alcance (API só ou API e painel), e se o destino final é o Worker do Sites (workers-rs)

- [ ] Rust: decidir com o João se o binário Rust passa a ser a API do teste com o NicoChat (hoje só o JavaScript roda). Fase 2 (painel em Rust, WebAssembly com Leptos ou Dioxus) muda o design system e só começa com o OK do João. Depois: adaptador Worker (`workers-rs`), D1/R2 no `one-store`, e desligar o JavaScript. Falta um teste de carga de verdade e de longa duração no binário Rust.

- [ ] Definir validade e teto de idempotência para o uso do NicoChat e planejar limpeza periódica no D1

## 🧠 Aprendizados importantes

- Permissões: toda decisão de camada vive em `src/permissoes.js` (`podeFazer(papel, 'ação')`); não escreva `papel === 'equipe'` nem listas de papéis no núcleo. Módulos novos de rotas ficam em `src/` (não em subpasta) para o teste "núcleo sem Node" varrer o arquivo.

- Usuários: token de sessão `s1_…` (só o hash fica guardado), PBKDF2-SHA256 100000 iterações por `crypto.subtle` em `src/usuarios.js` (o teto do Workers); equipe e admin reautenticam por 5 min para PATCH de empresa e módulos; excluir empresa usa a senha do próprio usuário. Em Python no Windows, gravar arquivo com `open(..., 'w')` troca LF por CRLF e quebra o teste "núcleo sem Node": use `newline=''`.

- O Worker usa os bindings `DB` e `BUCKET` do Sites. Com os dois ausentes, o modo local usa memória. O rate limit continua por isolate com D1.
- D1 não tem transação interativa: o repositório calcula os efeitos e envia um batch cuja primeira instrução avança uma revisão global só se ela não mudou (CHECK nomeado reverte o lote); em conflito repete até 40 vezes. Limite conhecido: escritas simultâneas de empresas diferentes disputam a mesma revisão.
- Reserva "ativa" para remover mesa ou ambiente = confirmada com fim maior que agora no relógio de parede da empresa (fuso de negócio). `ambienteId` do Contrato A é o nome do ambiente. A migração 0002 recria a tabela reservas e os gatilhos; novas migrações começam em 0003.
- O `reservaId` público é um código por empresa. `reservas_codigos` preserva os códigos emitidos após exclusão da empresa. O UUID interno fica fora do HTTP.

- Backup e restauração do SQLite precisam incluir o banco e seu diretório "<arquivo-sqlite>.arquivos/".
- SQLite usa uma fila por arquivo no processo Node para evitar bloquear o loop enquanto uma transação assíncrona aguarda a limpeza ou o histórico.
- Design system foi montado a partir de 9 telas do Hotel Demonstração (Atendimento, Gestão, Operação, A&B) e do PDF de 10/11/2026; nada veio do código-fonte.
- Paleta: moldura navy, trabalho claro, ciano (`brand-500`) só para ação; fontes Inter (UI), JetBrains Mono (números) e Fraunces (documentos).
- Tela 01 mostra três painéis no desktop (1440×900) e alternância Conversas/Histórico em painel compacto no celular (360×780).
- Logo real da TopBar: `web/logo-chatflow.png` (original ChatFlow, não alterar; texto "Painel" abaixo, alinhado à direita). A marca Kendji ONE foi descontinuada; o produto é ChatFlow Painel.

- Domínio MVP em `src/` (Node puro, memória): agentes e reservas isolados por empresa, reserva idempotente por chave; testes: `node --test tests/dominio.test.js` (não passar a pasta).

- API HTTP em `src/api.js` (Node puro): GET/PATCH `/empresas/:id/agente`, POST `/empresas/:id/reservas` (header Idempotency-Key), GET `/empresas/:id/mapa`; tokens Bearer por papel via env CHATFLOW_TOKEN_CHAT/CLIENTE/INTEGRACAO; rodar `node src/server.js`; testes `node --test tests/dominio.test.js tests/api.test.js`.

- Front em `web/` servido pela própria API em `/app/` (React UMD + bundle do design system copiado; não editar a cópia sem sincronizar com `ChatFlow-Design-System/`). Login por chave (sessionStorage). Telas: Reservas, Mapa de mesas, Configuração, Agentes. Testado no navegador com Empresa 1.

- Fluxo de reserva do agente: GET `/empresas/:id/disponibilidade?data&horario&pessoas` devolve mesas livres por ambiente (capacidade suficiente, janela de 90 min); depois POST `/empresas/:id/reservas` com `mesaId` (opcional) e Idempotency-Key. Se a mesa foi tomada, a resposta `indisponivel` já traz a disponibilidade atualizada. A tela Reservas tem "+ Nova reserva" manual com o mesmo fluxo.

- Edição de reserva: PATCH `/empresas/:id/reservas/:rid` (pessoas, data, horário, mesaId ou status confirmada/cancelada) e DELETE (cancela, libera a mesa; reserva fica na lista como Cancelada). Conflito devolve 409 com a disponibilidade. Na tela: − e + de pessoas, Editar (data, horário, pessoas e mesa), Cancelar e Reativar.
- Testes: rodar com `node --test --test-force-exit tests/dominio.test.js tests/api.test.js`; sem a flag, uma asserção falha deixa o servidor de teste aberto e o processo trava.

- Histórico de modificações (`src/historico.js`, só acrescenta): registra criação, edição, cancelamento, reativação, desfazer, edição de mesa e de campo do agente, com papel, operador, hora e antes/depois (só campos alterados). `GET /empresas/:id/historico?entidade=&id=` (equipe) e `POST /empresas/:id/historico/:seq/desfazer` (reservas). Desfazer confere campo a campo se houve mudança posterior; reenvio idempotente não gera evento duplicado. Na tela: aba Histórico, com campo "Seu nome" no login.

- Config do agente (`src/agentes.js`): 5 campos de texto livre com limite de caracteres: descricao 1000, personalidade (Personalidade e Objetivo da IA) 2000, habilidades 22000, produtos (Informações sobre Produtos e Serviços) 22000, restricoes 2000. Antes habilidades, produtos e restrições eram listas; agora são texto. `PATCH /empresas/:id/agente` aceita `{campos:{...}}` (tudo ou nada: permissão, tipo e limite são checados antes de gravar) e ainda `{campo,valor}`. Um evento de histórico por campo alterado. Restrições liberada para a equipe da empresa (`editavelPor`); por padrão, campo sem `editavelPor` é só da integração. Na tela: caixas que crescem com o texto, contador n / limite, um botão Salvar alterações para tudo.

- Nome da empresa é editável (Configuração → Nome da empresa, `PATCH /empresas/:id`, 1 a 60 caracteres, único entre as empresas, vai para o histórico). O agente ganhou o campo `nome` (Nome do agente, 100 caracteres), primeiro do bloco que o chat lê; o chat deve usá-lo para se apresentar.

- Decisão do João: cada empresa (antes chamada de loja) é independente, com agente, reservas e chave de API próprios, e podem existir quantas empresas forem precisas. Criar empresa: `POST /empresas {nome}` (botão "+ Nova empresa"); nasce com agente vazio e sem ambientes (criar em Configuração: `POST /empresas/:id/ambientes`, `POST /empresas/:id/mesas`).
- Chave de API por empresa (`k1_…`): `POST /empresas/:id/api/chave` gera ou gira (só equipe de integração; aparece uma vez; só o hash fica), `DELETE` revoga, `GET /empresas/:id/api` mostra status. A chave só acessa as rotas da própria empresa e só as do chat (ler agente, disponibilidade, criar reserva); qualquer outra rota devolve 403. A aba API do painel tem endereços, exemplo de curl e **Testar conexão** (4 checagens só de leitura, mostra o JSON que o chat recebe). Segredo nunca vai para o histórico.

- O termo "loja" foi trocado por "empresa" em tudo: tela, código, testes e API. Rotas `/empresas/...` e ids `empresa_1`, `empresa_2`... O prefixo antigo `/lojas` e os ids `L1` foram removidos, sem alias: qualquer cliente da API que use o contrato antigo recebe 404.
- Excluir empresa: `POST /empresas/:id/excluir {senha, confirmarNome}` (equipe da empresa ou integração; a chave de API da própria empresa não consegue). A senha do administrador vem da variável de ambiente `CHATFLOW_ADMIN_SENHA`; sem ela a exclusão fica desativada (503). Nunca gravar a senha em código, teste ou HANDOFF. 5 senhas erradas bloqueiam novas tentativas por 15 min; cada tentativa negada vai para o histórico. Exclusão é irreversível e apaga reservas e chave; o evento `excluida` guarda um instantâneo completo (agente, ambientes, mesas, reservas) e `GET /historico/excluidas` lista o resumo. Ids de empresa e de reserva nunca são reaproveitados.

- Recursos por empresa (`modulos`): `reservas` e `conhecimento`, ligáveis na criação (`POST /empresas {nome, modulos}`) e depois em Configuração (`PATCH /empresas/:id/modulos`). Desligado, a aba some e a API responde 404 `recurso "..." não habilitado para esta empresa`; os dados ficam guardados. `GET /empresas/:id/recursos` (aceita a chave da empresa) diz ao sistema de conversa o que existe e os endereços. Empresa sem mesas (ex.: oficina com tabela de preços) usa só agente e conhecimento.
- Base de conhecimento (`src/conhecimento.js`): itens `texto` (até 50.000 caracteres), `tabela` (até 20 colunas, 1.000 linhas, 500 caracteres por célula) e `documento` (.txt, .md, .csv, .pdf, .docx, .xlsx até 4 MB; o conteúdo é checado pelos primeiros bytes, nada de HTML/SVG). `GET /empresas/:id/conhecimento` devolve tudo de uma vez (a chave da empresa só lê); `.../conhecimento/:itemId` e `.../:itemId/arquivo` (anexo, `nosniff`, `CSP sandbox`). POST/PATCH/DELETE só para a equipe; tipo do item não muda. Tudo vai para o histórico (sem os bytes do arquivo). Na tela: aba Conhecimento com editor de tabela, colar de planilha (TAB, `;` ou `,`) e upload.
- Terminal do Windows (Git Bash) não envia UTF-8 em `curl -d` com acentos: o texto chega corrompido. Para semear dados de demonstração use um script Node, não `curl`.

- Desenho final da integração NicoChat (decisão do João): `#one` NÃO é gatilho de produção, só serve para disparar teste manual. TODA conversa nova do cliente começa chamando `GET /empresas/:id/contexto`; depois a IA do NicoChat aciona funções: `one_buscar_conhecimento` (`GET /empresas/:id/conhecimento/buscar?q=`) quando o cliente pergunta preço, horário, pagamento ou regra; `one_disponibilidade` e `one_reservar` quando quer mesa. A reserva guarda `nomeCliente` (até 80) e `contato` (até 40) vindos do contato do NicoChat; aparecem no Workspace, no mapa e no histórico (dado pessoal: ver LGPD nas pendências). A busca (`conhecimento.buscar`) ignora acento, maiúsculas e plural, devolve só as linhas de tabela e os parágrafos que casam, e responde catálogo quando a pergunta é genérica. O prompt só embute o conhecimento se ele couber em 6.000 caracteres; acima disso instrui a IA a usar a busca. `simular-conversa.js` roda uma conversa inteira contra o ONE (`--reservar` grava de verdade).
- Integração NicoChat (fluxo ONE, versão anterior com #one): `GET /empresas/:id/contexto` (aceita a chave da empresa) devolve numa chamada o agente, os recursos, a base de conhecimento e um `prompt` de sistema montado em `src/contexto.js` (sem travessões, regra do design system para prompts de agente). Pasta `nicochat/fluxos/ONE/` com fluxo, 3 functions e `simular-nicochat.js` (simula o fluxo contra a API; com `--reservar` grava uma reserva de teste; usa `process.exitCode`, nunca `process.exit`, porque o Node no Windows aborta com erro do libuv). A aba API gera as functions por empresa e mostra o prompt. Formato de importação do NicoChat ainda não conhecido: os JSON são neutros.

- Painel desacoplado da API: `web/config.js` define `window.CHATFLOW_CONFIG.apiBase` (vazio = mesma origem). O painel usa caminhos relativos (`tokens.css`, `app.js`, `logo-chatflow.png`), então roda em `/app/` e em qualquer pasta estática. `/app` sem barra quebraria os assets: o servidor deve redirecionar para `/app/`.

- Arquitetura de `src/` depois da TASK-005: tudo fora de `src/node/` é JavaScript padrão + Web API (um teste falha se aparecer `require(`, `node:`, `Buffer` ou `process.` lá). Serviços recebem o repositório (`store`) e usam só as funções dele, sempre com `await`. `criarStore()` devolve o repositório em memória; `addEmpresa(store, dados)` é async. `src/api.js` só reexporta `criarServidor`; `src/server.js` só importa `src/node/inicializar.js` (variáveis de ambiente, demo, `listen`). Os testes continuam em CommonJS e carregam o ESM com `require` (precisa de Node 20.19 ou mais novo; hoje 24).
- Datas: `inicio` e `fim` são minutos de relógio de parede. Para remover mesa ou ambiente, a reserva confirmada bloqueia a operação até `fim`, comparado com a hora local em `CHATFLOW_FUSO`.
- Nas rotas de gestão, `ambienteId` é o nome atual codificado na URL. Remover mesa desvincula reservas elegíveis com `mesaId: null` e registra o vínculo anterior. Excluir reserva definitivamente exige cancelamento, preserva o código emitido e registra o instantâneo sem o UUID interno.
- Teste ponta a ponta local: a porta 3456 costuma estar ocupada por outro servidor do ONE (versão antiga, de outra sessão); suba o seu em outra porta (`PORT=3911`) e mate só o PID que você iniciou.

- Régua de contrato: `tests/api.test.js` roda em processo (padrão) ou contra qualquer binário com `CHATFLOW_SERVIDOR='["comando","arg"]'` (array JSON, sem shell). `CHATFLOW_SEMENTE_ARQUIVO` (JSON com empresas iniciais) existe nos dois servidores só para isso. Testes marcados `INTERNO` ficam pulados no modo externo. Rust: `rust/README.md`.
- Rust: a API devolve JSON com a ordem das chaves do JavaScript (`serde_json` com `preserve_order`); eventos de histórico são montados com `evento()` para repetir a ordem de `{ ...a, ...b }`. `Map::remove` embaralha a ordem: use `shift_remove`. `dyn FonteCorpo` precisa de `Send + Sync` para o axum aceitar o handler.

- Rust: `Repositorio::empresa_obter` devolve cópia; por isso o conhecimento (documentos de até 4 MB) fica fora de `Empresa`, em `Estado.conhecimento`. Não coloque dados grandes dentro de `Empresa`. A prova de wasm exige `#[unsafe(no_mangle)]`, então o crate `one-wasm-prova` não herda o `unsafe_code = forbid` do workspace.
- Em Windows, o teste de carga lê a memória com `Get-Process`; matar processos por nome (`pkill`, `Stop-Process -Name`) pode derrubar o servidor de outra sessão: mate só o PID que você subiu.

## 🚫 Armadilhas conhecidas

- No workerd, responder antes de consumir um corpo recusado pode causar reset HTTP. O Worker descarta sob `waitUntil` com teto e sem armazenar os bytes excedentes.
- No Windows, os testes do servidor emitem os eventos de sinal por IPC, pois child.kill encerra o processo sem executar o manipulador.

- A revisão alterou a migração inicial. Arquivos criados com o rascunho anterior já marcam user_version=1 e exigem migração própria para receber o esquema revisado preservando dados.
- Vocabulário dos prints é de hotel (UH, Governança, enxoval); para restaurante trocar por mesa/salão/cozinha mantendo a estrutura.
- Não usar travessão em textos para cliente e prompts de agente (regra do README do design system).
- TopBar não implementa layout móvel no bundle; ChatFab não encaminha onClick nem fixa posição; EmptyState adiciona tracejado ausente no print.

## 🔗 Referências rápidas

- Design system: `C:\Claude Code\DESENVOLVIMENTOS\Kendji ONE\ChatFlow-Design-System\` (README.md, tokens.json, components/)
- Prints: `Prints-telas-ChatFlow-demo\desktop` e `\celular` (9 telas cada)
- PDF: `Referencia-de-telas-ChatFlow-Unnica.pdf`
- Plano tela 01: `docs/plano-01-atendimento-conversas.md` (versão completa com PDF e dados necessários; `docs/plano-tela-01.md` é a primeira versão)

## 📚 Histórico recente

- 2026-11-22 — TASK-003 (Banco): repositório D1 e anexos no R2 (Contrato C), testes Miniflare com concorrência, 151/151
- 2026-11-21 — TASK-001 (Banco): Contrato A em memória e SQLite, migração 0002 (mesa_id nulo), TASK-014 reconfirmada, backup e restauração com npm run
- 2026-11-21 — TASK-013: roteiro de produção, ambiente SQLite explícito e verificação local de persistência após reinício
- 2026-11-21 — TASK-010: docs de persistência (D1, R2, LGPD, id de reserva), limpeza de idempotência em SQL com testes e revisão do esquema e do repositório SQLite do T04
- 2026-11-15 — TASK-009: idempotência com validade e teto (JS e Rust), 5 testes novos no JS e 6 no Rust; memória sob carga estabilizada
- 2026-11-15 — TASK-008: one-core em wasm32 (prova executada no Node), CHATFLOW_FUSO no Rust, teste de carga (60 s, 5000 conexões, 0 erros) e achado de crescimento de memória por idempotência
- 2026-11-15 — TASK-007 fase 1: API do ONE em Rust (workspace `rust/`), régua de contrato HTTP independente da implementação, 34/34 JS e Rust, 109 requisições sem diferença
- 2026-11-15 — TASK-006: o corpo só é lido depois de autenticar (`req.lerCorpo(limite)` sob demanda; 413 com JSON no limite da rota; corpo não pedido é descartado, não guardado); 51 testes
- 2026-11-15 — TASK-005: ONE pronto para portar (ESM, plataforma injetável, núcleo `tratar`, adaptador Node, repositório com operações atômicas, datas sem fuso, testes de portabilidade); 48 testes, simulador do NicoChat verificado contra `node src/server.js`
- 2026-11-14 — TASK-001 reaberta pelo usuário: plano completo em `docs/plano-01-atendimento-conversas.md` (PDF, dados necessários, contratos a definir), validado pelo T001
- 2026-11-14 — TASK-001 parte 2: plano documental da tela 01 e verificação dos sete componentes citados; sem código ou mudanças no design system
- 2026-11-14 — TASK-001 parte 1: git init + .gitignore + commit inicial
- 2026-11-14 — HANDOFF.md criado (projeto só com design system e referências visuais)
