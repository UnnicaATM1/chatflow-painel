# 🔄 Handoff de Turno — Kendji ONE
> Última atualização: 2026-11-14 — por: Codex

## 📊 Status
<!-- STATUS_START -->
design-system: 60%
telas-referencia: 100%
frontend: 45%
backend: 55%
planejamento-tela-01: 100%
geral: 46%
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
- [ ] Trocar o `reservaId` (contador global, vaza o total de reservas entre lojas) por UUID ou id por loja ao entrar o banco
- [ ] Combinar com a equipe de integração o contrato final da API e a emissão/rotação dos tokens
- [ ] Revisar premissas 🟡 de `_reversa_sdd/prd.md` (duração 90 min, métricas, LGPD)

- [ ] Front A&B/Atendimento: criar/remover ambientes e mesas, excluir reserva em definitivo (hoje só cancela e reativa), modo escuro do A&B e layout móvel (hoje só visualização, edição de mesa e campos do agente)
- [ ] Vendorizar React (hoje vem do unpkg) para funcionar sem internet no salão

- [ ] Rastreabilidade por pessoa real: hoje o histórico guarda o papel do token (confiável) e o nome digitado no login (`X-Operador`, só um rótulo); para auditoria forte, emitir um token por usuário
- [ ] Histórico e reservas vivem em memória; o arquivo `KENDJI_HISTORICO_ARQUIVO` (JSON por linha, horário em UTC) preserva a trilha, mas ao ir para banco migrar o histórico junto e impedir UPDATE/DELETE na tabela

## 🧠 Aprendizados importantes
- Design system foi montado a partir de 9 telas do Hotel Demonstração (Atendimento, Gestão, Operação, A&B) e do PDF de 10/11/2026; nada veio do código-fonte.
- Paleta: moldura navy, trabalho claro, ciano (`brand-500`) só para ação; fontes Inter (UI), JetBrains Mono (números) e Fraunces (documentos).
- Tela 01 mostra três painéis no desktop (1440×900) e alternância Conversas/Histórico em painel compacto no celular (360×780).
- Logo real da TopBar está em `KendjiOne-Design-System/assets/Logos/one-lockup-dark.png`.

- Domínio MVP em `src/` (Node puro, memória): agentes e reservas isolados por loja, reserva idempotente por chave; testes: `node --test tests/dominio.test.js` (não passar a pasta).

- API HTTP em `src/api.js` (Node puro): GET/PATCH `/lojas/:id/agente`, POST `/lojas/:id/reservas` (header Idempotency-Key), GET `/lojas/:id/mapa`; tokens Bearer por papel via env KENDJI_TOKEN_CHAT/CLIENTE/INTEGRACAO; rodar `node src/server.js`; testes `node --test tests/dominio.test.js tests/api.test.js`.

- Front em `web/` servido pela própria API em `/app/` (React UMD + bundle do design system copiado; não editar a cópia sem sincronizar com `KendjiOne-Design-System/`). Login por chave (sessionStorage). Telas: Reservas, Mapa de mesas, Configuração, Agentes. Testado no navegador com Loja 1.

- Fluxo de reserva do agente: GET `/lojas/:id/disponibilidade?data&horario&pessoas` devolve mesas livres por ambiente (capacidade suficiente, janela de 90 min); depois POST `/lojas/:id/reservas` com `mesaId` (opcional) e Idempotency-Key. Se a mesa foi tomada, a resposta `indisponivel` já traz a disponibilidade atualizada. A tela Reservas tem "+ Nova reserva" manual com o mesmo fluxo.

- Edição de reserva: PATCH `/lojas/:id/reservas/:rid` (pessoas, data, horário, mesaId ou status confirmada/cancelada) e DELETE (cancela, libera a mesa; reserva fica na lista como Cancelada). Conflito devolve 409 com a disponibilidade. Na tela: − e + de pessoas, Editar (data, horário, pessoas e mesa), Cancelar e Reativar.
- Testes: rodar com `node --test --test-force-exit tests/dominio.test.js tests/api.test.js`; sem a flag, uma asserção falha deixa o servidor de teste aberto e o processo trava.

- Histórico de modificações (`src/historico.js`, só acrescenta): registra criação, edição, cancelamento, reativação, desfazer, edição de mesa e de campo do agente, com papel, operador, hora e antes/depois (só campos alterados). `GET /lojas/:id/historico?entidade=&id=` (equipe) e `POST /lojas/:id/historico/:seq/desfazer` (reservas). Desfazer confere campo a campo se houve mudança posterior; reenvio idempotente não gera evento duplicado. Na tela: aba Histórico, com campo "Seu nome" no login.

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
