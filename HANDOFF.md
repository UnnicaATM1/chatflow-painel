# 🔄 Handoff de Turno — Kendji ONE
> Última atualização: 2026-11-14 — por: Claude Code

## 📊 Status
<!-- STATUS_START -->
design-system: 60%
telas-referencia: 100%
frontend: 0%
backend: 0%
geral: 10%
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
Projeto em fase inicial: só existem material de referência (9 prints desktop/celular + PDF "Referência de telas") e o design system KendjiOne (tokens + 14 componentes).
Nenhum código de app, stack ou escopo definidos ainda. Repositório git iniciado na raiz (branch main, 1 commit inicial, .gitignore com node_modules, dist, .env e arquivos de SO).

## ✅ Pendências ativas
- [ ] Definir com o João o objetivo do projeto (app novo, protótipo ou só o design system) e a stack
- [ ] Conferir tipografia e espaçamento do design system com o front-end real (valores são leituras visuais dos prints)
- [ ] Planejar a primeira tela a implementar a partir dos prints (sugestão: 01-atendimento-conversas)

## 🧠 Aprendizados importantes
- Design system foi montado a partir de 9 telas do Hotel Demonstração (Atendimento, Gestão, Operação, A&B) e do PDF de 10/11/2026; nada veio do código-fonte.
- Paleta: moldura navy, trabalho claro, ciano (`brand-500`) só para ação; fontes Inter (UI), JetBrains Mono (números) e Fraunces (documentos).

## 🚫 Armadilhas conhecidas
- Vocabulário dos prints é de hotel (UH, Governança, enxoval); para restaurante trocar por mesa/salão/cozinha mantendo a estrutura.
- Não usar travessão em textos para cliente e prompts de agente (regra do README do design system).

## 🔗 Referências rápidas
- Design system: `C:\Claude Code\DESENVOLVIMENTOS\Kendji ONE\KendjiOne-Design-System\` (README.md, tokens.json, components/)
- Prints: `Prints-telas-KendjiOne-demo\desktop` e `\celular` (9 telas cada)
- PDF: `Referencia-de-telas-KendjiOne-Unnica.pdf`

## 📚 Histórico recente
- 2026-11-14 — TASK-001 parte 1: git init + .gitignore + commit inicial
- 2026-11-14 — HANDOFF.md criado (projeto só com design system e referências visuais)
