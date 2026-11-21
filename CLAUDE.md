# CLAUDE — ChatFlow Painel

## Handoff de Turno (continuidade com Codex e Gemini CLI)

Todo projeto deve ter um handoff compartilhado de continuidade em `HANDOFF.md` na
raiz, lido e escrito também pelo Codex (via `AGENTS.md`) e pelo Gemini CLI (via
`GEMINI.md`), quando esses harnesses existirem no projeto.

- No início de qualquer sessão, verifique se `HANDOFF.md` existe na raiz do
  projeto atual. Se não existir, crie a partir do template da skill
  `handoff-turno` antes de começar a trabalhar.
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
