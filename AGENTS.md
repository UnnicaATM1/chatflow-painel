# AGENTS — Kendji ONE

## Handoff de Turno (continuidade com Claude Code e Gemini CLI)

Todo projeto deve ter um handoff compartilhado de continuidade em `HANDOFF.md` na
raiz, lido e escrito também pelo Claude Code (via `CLAUDE.md`) e pelo Gemini CLI
(via `GEMINI.md`), quando esses harnesses existirem no projeto.

- No início de qualquer sessão, verifique se `HANDOFF.md` existe na raiz do
  projeto atual. Se não existir, crie usando a estrutura abaixo antes de
  começar a trabalhar (seções: Status, Onde paramos, Pendências ativas,
  Aprendizados importantes, Armadilhas conhecidas, Referências rápidas).
- Leia `HANDOFF.md` antes de agir.
- Ao encerrar a sessão ou concluir uma tarefa relevante, atualize `HANDOFF.md`:
  sobrescreva "Onde paramos", remova pendências concluídas do checklist, e
  registre aprendizados/armadilhas novos em 1 linha objetiva cada.
- Se o `geral` do bloco Status estiver abaixo de 100%, "Pendências ativas"
  NUNCA fica vazia: ao concluir uma tarefa, gere e registre o(s) próximo(s)
  passo(s) concretos para avançar o projeto rumo aos 100%, mesmo sem pedido
  explícito do usuário. Só feche sem pendências quando `geral: 100%`.
- SEMPRE mantenha o bloco `## 📊 Status` (entre os marcadores `<!-- STATUS_START -->`
  e `<!-- STATUS_END -->`) atualizado com o percentual real de conclusão por
  área do projeto (ex.: backend, frontend, docs, e outras áreas/módulos que
  existirem), mais uma linha `geral` com o progresso total. Esse bloco é lido
  por uma ferramenta externa do usuário para gerar dashboards de progresso —
  o formato `nome-da-area: numero%` não pode ser alterado nem enfeitado com
  texto adicional na mesma linha.
- Nunca copie o conteúdo do handoff para dentro deste arquivo — apenas mantenha
  `HANDOFF.md` atualizado.

Template para criar `HANDOFF.md` quando não existir:

```
# 🔄 Handoff de Turno — [Nome do Projeto]
> Última atualização: [DATA] — por: [Claude Code / Codex / Gemini]

## 📊 Status
<!-- STATUS_START -->
backend: [0-100]%
frontend: [0-100]%
docs: [0-100]%
geral: [0-100]%
<!-- STATUS_END -->

## 📍 Onde paramos
[1 a 3 linhas. Estado real, sem enrolação.]

## ✅ Pendências ativas
- [ ] [Tarefa — contexto mínimo necessário]

## 🧠 Aprendizados importantes
- [Decisão técnica, convenção ou gotcha]

## 🚫 Armadilhas conhecidas
- [Algo que já causou erro/retrabalho]

## 🔗 Referências rápidas
- [IDs, workspaces, paths que se repetem]
```
