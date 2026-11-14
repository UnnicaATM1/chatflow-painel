# 🔄 Handoff de Turno — Kendji ONE
> Última atualização: 2026-11-14 — por: Codex

## 📊 Status
<!-- STATUS_START -->
design-system: 60%
telas-referencia: 100%
frontend: 0%
backend: 15%
planejamento-tela-01: 100%
geral: 18%
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
Depois, `/reversa-new` expresso gerou `_reversa_sdd/` (brief, ideação, personas, PRD, 3 specs SDD), `_reversa_forward/001-agentes-reservas/` e o domínio MVP em `src/` com 5 testes passando. Stack real e API HTTP seguem indefinidas.

## ✅ Pendências ativas
- [ ] Definir com o João o objetivo do projeto (app novo, protótipo ou só o design system) e a stack
- [ ] Conferir tipografia e espaçamento do design system com o front-end real (valores são leituras visuais dos prints)
- [ ] Validar o plano da tela 01, os breakpoints propostos e as referências ausentes de conversa preenchida, histórico móvel e apagamentos
- [ ] Após definir stack e escopo, implementar o estado vazio desktop/celular da tela 01 usando `docs/plano-tela-01.md`

- [ ] Definir stack real e expor a API HTTP (leitura de config autenticada e reserva idempotente) sobre `src/`; persistência real no lugar da memória
- [ ] Revisar premissas 🟡 de `_reversa_sdd/prd.md` (duração 90 min, métricas, LGPD)

## 🧠 Aprendizados importantes
- Design system foi montado a partir de 9 telas do Hotel Demonstração (Atendimento, Gestão, Operação, A&B) e do PDF de 10/11/2026; nada veio do código-fonte.
- Paleta: moldura navy, trabalho claro, ciano (`brand-500`) só para ação; fontes Inter (UI), JetBrains Mono (números) e Fraunces (documentos).
- Tela 01 mostra três painéis no desktop (1440×900) e alternância Conversas/Histórico em painel compacto no celular (360×780).
- Logo real da TopBar está em `KendjiOne-Design-System/assets/Logos/one-lockup-dark.png`.

- Domínio MVP em `src/` (Node puro, memória): agentes e reservas isolados por loja, reserva idempotente por chave; testes: `node --test tests/dominio.test.js` (não passar a pasta).

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
