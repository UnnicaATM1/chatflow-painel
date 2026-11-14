# KendjiOne

Design system do **ONE by KendjiOne**, a plataforma de inteligência operacional para hotéis, bares e restaurantes. Escuro na moldura, claro no trabalho, ciano onde a ação acontece.

Este sistema foi montado a partir de 9 telas do ambiente Hotel Demonstração (Atendimento, Gestão, Operação, A&B) e do PDF "Referência de telas" de 10/11/2026. As cores foram medidas pixel a pixel nos prints; a paleta de apoio (status, setores) segue a escala Tailwind que o app já usa. Nada aqui veio do código-fonte, então valores de tipografia e espaçamento são leituras visuais e devem ser conferidos com o front-end.

## Princípios

1. **A moldura é navy, o trabalho é claro.** A TopBar fica sempre em `navy-950`. O conteúdo vive em `surface-page` com painéis `surface-card`. O modo escuro (usado no A&B, que roda no salão) inverte só o conteúdo.
2. **Ciano é ação, não decoração.** `brand-500` aparece em botão primário, dia de hoje, aba ativa, barra lateral de cartão acionável e no FAB. Se tudo for ciano, nada é.
3. **Borda antes de sombra.** Cartões e painéis se separam por `border`; `shadow-card` é quase nulo. A única sombra visível é a do FAB.
4. **Números em mono.** Contagens, valores em R$, horários, UH e rótulos de seção (STATUS DO MÊS) usam a família `mono`. Isso dá ao app a cara de painel de operação.
5. **Cor carrega significado fixo.** Cada status, setor e prioridade tem um token. Não reaproveite a cor de um setor para outro assunto.

## Voz e conteúdo

O app fala com a equipe da casa, em português direto, frases curtas e no imperativo quando orienta.

- Títulos são o nome da coisa: "Chamados da Manutenção", "Mapa de mesas", "Conversas · Capi". O ponto médio separa módulo e contexto.
- Botões são verbos no infinitivo: Iniciar, Concluir, Encerrar, Arquivar, Descartar, Editar. Criação leva "+": "+ Nova tarefa", "+ Novo assunto".
- Estado vazio diz o que fazer e onde: "Cadastre um salão na aba **Configuração** antes de reservar mesa." Em coluna de quadro, "Nada aqui." basta.
- Datas: dd/mm em etiqueta (Prazo 19/11), dd/mm/aaaa em lista. Dias da semana em caixa alta curta: SEG, TER, QUA.
- Evite travessão em textos para cliente e em prompts de agente; use ponto, vírgula ou dois-pontos.
- O vocabulário ainda é de hotel (UH, Governança, enxoval). Em restaurante, troque por mesa, salão, cozinha, mantendo a estrutura.

## Fundamentos visuais

**Cor.** Três camadas:

| Camada | Tokens | Para quê |
|---|---|---|
| Marca | `brand-500`, `brand-50`, `brand-text`, `navy-950`, `navy-900`, `navy-700` | identidade e ação |
| Neutros | `surface-page`, `surface-card`, `surface-sunken`, `border`, `border-strong`, `ink`, `ink-muted`, `ink-subtle` | estrutura e texto |
| Semântica | `status-*` (eventos), `col-*` (trabalho), `sector-*`, `prio-*`, `danger` | significado |

**Tipografia.** Inter para a interface; JetBrains Mono para números e rótulos espaçados; Fraunces só em documentos e materiais comerciais (capa do PDF). Pesos: 400 texto, 600 título de cartão e botão, 700 título de página e contadores.

**Espaço.** Escala de 4px: `space-1` 4, `space-2` 8, `space-3` 12, `space-4` 16, `space-6` 24, `space-8` 32. Cartões com padding `space-4`, página com margem `space-6`.

**Forma.** Raios pequenos e consistentes: etiquetas `radius-sm`, botões `radius-md`, cartões `radius-lg`, painéis grandes `radius-xl`, chips e pílulas `radius-pill`. O ícone da marca é um quadrado arredondado com uma cápsula vazada: esse mesmo arredondamento justifica os cantos do sistema.

**Barra lateral.** Cartões de assunto levam 3px de `brand-500` à esquerda; linhas de tarefa levam 4px na cor da prioridade (`prio-alta`, `prio-urgente`, `prio-baixa`, ou `ink-muted` sem prioridade). É o jeito do app sinalizar urgência sem pintar o cartão inteiro.

## Status: qual usar

| Contexto | Componente | Cores |
|---|---|---|
| Eventos comerciais (Gestão › Eventos) | StatusLegend | `status-confirmado`, `status-realizado`, `status-pendente`, `status-negociacao`, `status-cancelado`, `status-noshow`, `status-interno` |
| Assuntos, Tarefas, Chamados | ColumnHeader, StatusPill | `col-pendente-*`, `col-andamento-*`, `col-aprovar-*`, `col-encerrado-*` |
| Logbook (contadores) | StatCard | ponto em `status-pendente`, `status-realizado`, `col-encerrado-fg` |

## Iconografia

Ícones de traço fino (1.5 a 2px), cantos arredondados, estilo Lucide: lupa da busca, sino, lua do tema, balão do chat, alfinete de local. Tamanho 16px em linha, 20 a 22px em botão de ícone. Cor herda do texto; no FAB o traço é `brand-500`. O app usa alguns emojis em botões (⚙️ Parâmetros, ✉ Minha chave, 📥 Arquivados); a recomendação é trocá-los por ícones de traço para manter consistência.

## Logos

Na pasta Logos: o lockup **ONE by KendjiOne** (usado na TopBar) e o wordmark **KendjiOne** com o ícone (usado em documentos), ambos recortados dos materiais originais sobre fundo navy. Use sempre sobre `navy-950`. Estes PNGs são de tela; peça os vetores (SVG) à KendjiOne antes de qualquer peça impressa.

## Acessibilidade: pontos em aberto

O app hoje tem três pares que reprovam contraste. Foram mantidos como estão, com alternativa pronta:

- Texto branco sobre `brand-500` (Iniciar, Concluir, + Nova tarefa): 1.7:1. Alternativa: texto `navy-950` (11.3:1), ativada com `accessible` no Button.
- Ciano como cor de texto sobre claro (aba ativa): 1.7:1. O sistema já usa `brand-text` (#007d75, 5.0:1) no tema claro.
- Laranja de Urgente e Controladoria (`prio-urgente`, `sector-controladoria`): 3.4 a 3.6:1. Passa como etiqueta contornada, não como texto corrido.

## Como usar

Carregue `tokens.css`, `components/bundle.css`, React 18 e `components/bundle.js`; os componentes ficam em `window.KendjiOne`. Envolva a área em `class="k1"` e defina `data-theme="light"` ou `"dark"` no `<html>`.
