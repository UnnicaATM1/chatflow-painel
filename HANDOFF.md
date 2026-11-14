# 🔄 Handoff de Turno — Kendji ONE
> Última atualização: 2026-11-14 — por: Codex

## 📊 Status
<!-- STATUS_START -->
design-system: 60%
telas-referencia: 100%
frontend: 62%
backend: 71%
planejamento-tela-01: 100%
geral: 59%
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
TASK-001 parte 2 concluída: `docs/plano-tela-01.md` documenta layout desktop/celular, componentes existentes, estados, responsividade, passos de implementação e lacunas da tela Atendimento · Conversas.
README, tokens, componentes/bundle e os dois prints foram lidos; sete componentes citados foram conferidos. Design system preservado.
Depois, `/reversa-new` expresso gerou `_reversa_sdd/` (brief, ideação, personas, PRD, 3 specs SDD), `_reversa_forward/001-agentes-reservas/` e o domínio MVP em `src/` e a API HTTP em `src/api.js`, com 9 testes passando. Persistência real e deploy seguem indefinidos.

## ✅ Pendências ativas
- [ ] Definir com o João o objetivo do projeto (app novo, protótipo ou só o design system) e a stack
- [ ] Conferir tipografia e espaçamento do design system com o front-end real (valores são leituras visuais dos prints)
- [ ] Validar o plano da tela 01, os breakpoints propostos e as referências ausentes de conversa preenchida, histórico móvel e apagamentos
- [ ] Após definir stack e escopo, implementar o estado vazio desktop/celular da tela 01 usando `docs/plano-tela-01.md`

- [ ] Persistência real (banco) no lugar da memória e deploy da API; hoje `src/api.js` roda com dados de demonstração em memória
- [ ] Trocar o `reservaId` (contador global, vaza o total de reservas entre empresas) por UUID ou id por empresa ao entrar o banco
- [ ] Combinar com a equipe de integração o contrato final da API e a emissão/rotação dos tokens
- [ ] Revisar premissas 🟡 de `_reversa_sdd/prd.md` (duração 90 min, métricas, LGPD)

- [ ] Front A&B/Atendimento: criar/remover ambientes e mesas, excluir reserva em definitivo (hoje só cancela e reativa), modo escuro do A&B e layout móvel (hoje só visualização, edição de mesa e campos do agente)
- [ ] Vendorizar React (hoje vem do unpkg) para funcionar sem internet no salão

- [ ] Rastreabilidade por pessoa real: hoje o histórico guarda o papel do token (confiável) e o nome digitado no login (`X-Operador`, só um rótulo); para auditoria forte, emitir um token por usuário
- [ ] Histórico e reservas vivem em memória; o arquivo `KENDJI_HISTORICO_ARQUIVO` (JSON por linha, horário em UTC) preserva a trilha, mas ao ir para banco migrar o histórico junto e impedir UPDATE/DELETE na tabela

- [ ] Chaves de API: guardar empresa.chave (hash) no banco, não em memória; em produção NÃO definir KENDJI_TOKEN_CHAT (chave global do chat vê todas as empresas); adicionar limite de requisições e HTTPS
- [ ] Remover ou renomear ambiente e remover mesa (hoje só criar); decidir o que fazer com reservas já ligadas a uma mesa removida

- [ ] Exclusão de empresa: trocar a senha do administrador por algo forte (a atual tem 6 caracteres; o bloqueio de 5 erros / 15 min mitiga, mas é fraca) e, quando houver contas, trocar a senha única por login real de administrador; avaliar "restaurar empresa excluída" a partir do instantâneo gravado no histórico

## 🧠 Aprendizados importantes
- Design system foi montado a partir de 9 telas do Hotel Demonstração (Atendimento, Gestão, Operação, A&B) e do PDF de 10/11/2026; nada veio do código-fonte.
- Paleta: moldura navy, trabalho claro, ciano (`brand-500`) só para ação; fontes Inter (UI), JetBrains Mono (números) e Fraunces (documentos).
- Tela 01 mostra três painéis no desktop (1440×900) e alternância Conversas/Histórico em painel compacto no celular (360×780).
- Logo real da TopBar está em `KendjiOne-Design-System/assets/Logos/one-lockup-dark.png`.

- Domínio MVP em `src/` (Node puro, memória): agentes e reservas isolados por empresa, reserva idempotente por chave; testes: `node --test tests/dominio.test.js` (não passar a pasta).

- API HTTP em `src/api.js` (Node puro): GET/PATCH `/empresas/:id/agente`, POST `/empresas/:id/reservas` (header Idempotency-Key), GET `/empresas/:id/mapa`; tokens Bearer por papel via env KENDJI_TOKEN_CHAT/CLIENTE/INTEGRACAO; rodar `node src/server.js`; testes `node --test tests/dominio.test.js tests/api.test.js`.

- Front em `web/` servido pela própria API em `/app/` (React UMD + bundle do design system copiado; não editar a cópia sem sincronizar com `KendjiOne-Design-System/`). Login por chave (sessionStorage). Telas: Reservas, Mapa de mesas, Configuração, Agentes. Testado no navegador com Empresa 1.

- Fluxo de reserva do agente: GET `/empresas/:id/disponibilidade?data&horario&pessoas` devolve mesas livres por ambiente (capacidade suficiente, janela de 90 min); depois POST `/empresas/:id/reservas` com `mesaId` (opcional) e Idempotency-Key. Se a mesa foi tomada, a resposta `indisponivel` já traz a disponibilidade atualizada. A tela Reservas tem "+ Nova reserva" manual com o mesmo fluxo.

- Edição de reserva: PATCH `/empresas/:id/reservas/:rid` (pessoas, data, horário, mesaId ou status confirmada/cancelada) e DELETE (cancela, libera a mesa; reserva fica na lista como Cancelada). Conflito devolve 409 com a disponibilidade. Na tela: − e + de pessoas, Editar (data, horário, pessoas e mesa), Cancelar e Reativar.
- Testes: rodar com `node --test --test-force-exit tests/dominio.test.js tests/api.test.js`; sem a flag, uma asserção falha deixa o servidor de teste aberto e o processo trava.

- Histórico de modificações (`src/historico.js`, só acrescenta): registra criação, edição, cancelamento, reativação, desfazer, edição de mesa e de campo do agente, com papel, operador, hora e antes/depois (só campos alterados). `GET /empresas/:id/historico?entidade=&id=` (equipe) e `POST /empresas/:id/historico/:seq/desfazer` (reservas). Desfazer confere campo a campo se houve mudança posterior; reenvio idempotente não gera evento duplicado. Na tela: aba Histórico, com campo "Seu nome" no login.

- Config do agente (`src/agentes.js`): 5 campos de texto livre com limite de caracteres: descricao 1000, personalidade (Personalidade e Objetivo da IA) 2000, habilidades 22000, produtos (Informações sobre Produtos e Serviços) 22000, restricoes 2000. Antes habilidades, produtos e restrições eram listas; agora são texto. `PATCH /empresas/:id/agente` aceita `{campos:{...}}` (tudo ou nada: permissão, tipo e limite são checados antes de gravar) e ainda `{campo,valor}`. Um evento de histórico por campo alterado. Restrições liberada para a equipe da empresa (`editavelPor`); por padrão, campo sem `editavelPor` é só da integração. Na tela: caixas que crescem com o texto, contador n / limite, um botão Salvar alterações para tudo.

- Nome da empresa é editável (Configuração → Nome da empresa, `PATCH /empresas/:id`, 1 a 60 caracteres, único entre as empresas, vai para o histórico). O agente ganhou o campo `nome` (Nome do agente, 100 caracteres), primeiro do bloco que o chat lê; o chat deve usá-lo para se apresentar.

- Decisão do João: cada empresa (antes chamada de loja) é independente, com agente, reservas e chave de API próprios, e podem existir quantas empresas forem precisas. Criar empresa: `POST /empresas {nome}` (botão "+ Nova empresa"); nasce com agente vazio e sem ambientes (criar em Configuração: `POST /empresas/:id/ambientes`, `POST /empresas/:id/mesas`).
- Chave de API por empresa (`k1_…`): `POST /empresas/:id/api/chave` gera ou gira (só equipe de integração; aparece uma vez; só o hash fica), `DELETE` revoga, `GET /empresas/:id/api` mostra status. A chave só acessa as rotas da própria empresa e só as do chat (ler agente, disponibilidade, criar reserva); qualquer outra rota devolve 403. A aba API do painel tem endereços, exemplo de curl e **Testar conexão** (4 checagens só de leitura, mostra o JSON que o chat recebe). Segredo nunca vai para o histórico.

- O termo "loja" foi trocado por "empresa" em tudo: tela, código, testes e API. Rotas `/empresas/...` e ids `empresa_1`, `empresa_2`... O prefixo antigo `/lojas` e os ids `L1` foram removidos, sem alias: qualquer cliente da API que use o contrato antigo recebe 404.
- Excluir empresa: `POST /empresas/:id/excluir {senha, confirmarNome}` (equipe da empresa ou integração; a chave de API da própria empresa não consegue). A senha do administrador vem da variável de ambiente `KENDJI_ADMIN_SENHA`; sem ela a exclusão fica desativada (503). Nunca gravar a senha em código, teste ou HANDOFF. 5 senhas erradas bloqueiam novas tentativas por 15 min; cada tentativa negada vai para o histórico. Exclusão é irreversível e apaga reservas e chave; o evento `excluida` guarda um instantâneo completo (agente, ambientes, mesas, reservas) e `GET /historico/excluidas` lista o resumo. Ids de empresa e de reserva nunca são reaproveitados.

## 🚫 Armadilhas conhecidas
- Vocabulário dos prints é de hotel (UH, Governança, enxoval); para restaurante trocar por mesa/salão/cozinha mantendo a estrutura.
- Não usar travessão em textos para cliente e prompts de agente (regra do README do design system).
- TopBar não implementa layout móvel no bundle; ChatFab não encaminha onClick nem fixa posição; EmptyState adiciona tracejado ausente no print.

## 🔗 Referências rápidas
- Design system: `C:\Claude Code\DESENVOLVIMENTOS\Kendji ONE\KendjiOne-Design-System\` (README.md, tokens.json, components/)
- Prints: `Prints-telas-KendjiOne-demo\desktop` e `\celular` (9 telas cada)
- PDF: `Referencia-de-telas-KendjiOne-Unnica.pdf`
- Plano tela 01: `docs/plano-tela-01.md`

## 📚 Histórico recente
- 2026-11-14 — TASK-001 parte 2: plano documental da tela 01 e verificação dos sete componentes citados; sem código ou mudanças no design system
- 2026-11-14 — TASK-001 parte 1: git init + .gitignore + commit inicial
- 2026-11-14 — HANDOFF.md criado (projeto só com design system e referências visuais)
