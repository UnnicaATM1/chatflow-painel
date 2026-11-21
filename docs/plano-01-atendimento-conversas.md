# Plano da tela 01: Atendimento · Conversas

Data: 14/11/2026. TASK-001, parte 2. Entrega documental, sem implementação.

Este é o arquivo solicitado pelo advisor T001. Consolida o plano anterior de `plano-tela-01.md`, acrescenta a leitura do PDF e explicita os dados necessários. Não altera o design system, o código ou o HANDOFF.md.

## Fontes e limites

- [README do design system](../ChatFlow-Design-System/README.md), [tokens.json](../ChatFlow-Design-System/tokens.json), READMEs dos componentes e implementação em [bundle.js](../ChatFlow-Design-System/components/bundle.js) e [bundle.css](../ChatFlow-Design-System/components/bundle.css).
- [Print desktop](../Prints-telas-ChatFlow-demo/desktop/01-atendimento-conversas.png): 1440 × 900 px.
- [Print celular](../Prints-telas-ChatFlow-demo/celular/01-atendimento-conversas.png): 360 × 780 px.
- [Referência de telas para a Unnica](../Referencia-de-telas-ChatFlow-Unnica.pdf), de 10/11/2026: 10 páginas físicas lidas; orientação na página física 2 (rodapé 1/9), tela 01 na página física 3 (rodapé 2/9), também conferida visualmente.

Os dois prints mostram o estado vazio. Medidas abaixo são aproximações visuais, não especificações extraídas do aplicativo. Estados com mensagens, interações e larguras intermediárias são propostas de implementação e precisam de validação. O design system também foi extraído de referências visuais, sem código-fonte do produto.

### O que o PDF confirma

- A tela serve para a equipe acompanhar o atendimento do agente de IA no WhatsApp e assumir a conversa quando necessário.
- Ao assumir, o agente interrompe sua atuação imediatamente. O retorno ocorre após 30 minutos sem mensagem da equipe. O PDF é mais específico que a expressão “sem escrever” do print: recomendado tomar mensagem efetivamente enviada pela equipe como hipótese inicial, validando o evento e o relógio no servidor.
- Confirma as cinco abas Conversas, Contatos, Painel, Conteúdo e Agentes, os períodos Hoje/7 dias/30 dias e a ausência de conversas abertas na demonstração.
- A orientação avisa que os dados são fictícios, o vocabulário de hotel está em adaptação para restaurante e o material não define endpoints nem contrato de integração. Portanto, os campos e operações propostos abaixo são requisitos de planejamento, não uma API existente ou homologada.
- As demais páginas contextualizam eventos, agenda, assuntos, tarefas, logbook, manutenção e reservas. Elas não fornecem o desenho de conversa preenchida, erro, carregamento ou histórico móvel.

### Contexto atual do repositório

O plano original foi escrito antes da implementação do MVP. Na revisão atual já existem `src/` e `web/`, com API Node e interface React para outros fluxos, conforme o handoff. A pesquisa textual nesses diretórios não identificou implementação da tela de conversas; referências a “sistema de conversa” no contexto/conhecimento não demonstram suporte a caixa de entrada, mensagens ou transferência de atendimento. Recomendado aproveitar a estrutura existente e confirmar seus contratos, sem iniciar outra aplicação apenas para esta tela.

## Layout desktop observado

1. Barra global navy, cerca de 56 px de altura: marca ONE, unidade “Hotel Demonstração”, módulos Gestão, Operação, Atendimento (ativo), Controle, Pessoas e Negócio, busca global, “Olá, Revisor” e avatar RP.
2. Subnavegação branca até aproximadamente y=102: Conversas (ativa), Contatos, Painel, Conteúdo e Agentes. Sublinhado ciano na aba ativa.
3. Cabeçalho da página sobre fundo claro: título “Conversas · Capi”, explicação à esquerda e botão secundário “Apagamentos registrados” à direita. Texto observado: “As conversas do WhatsApp do concierge. O Capi responde sozinho; quando precisar, assuma a conversa e ele cala na hora. Sem você escrever por 30 minutos, a conversa volta para ele.”
4. Área de trabalho a partir de y≈219, com margens laterais de 16 px e intervalos de 16 px. Três painéis brancos de borda fina, raio próximo de 12 px e base alinhada em y≈849:

| Painel | Geometria aproximada no print | Conteúdo observado |
|---|---|---|
| Lista de conversas | x=16, largura=360 px | Faixa superior “Nenhuma conversa aberta.”, divisória e corpo vazio |
| Conversa selecionada | x=392, largura=696 px | Mensagem centralizada “Escolha uma conversa para acompanhar.” |
| Histórico de atendimento | x=1104, largura=320 px | Título, filtros Hoje (ativo), 7 dias e 30 dias, seletor “Todos os atendimentos”, divisória e “Nenhuma conversa neste período.” |

5. Botão flutuante de chat navy com borda/ícone ciano, cerca de 52 px, canto inferior direito, aproximadamente 16 px das bordas. Não confundir este assistente global com o painel de conversa do concierge.

## Layout celular observado

1. Cabeçalho navy em múltiplas linhas, aproximadamente 126 px no total. Primeira linha com marca e avatar RP. Segunda com unidade e seletor “Concierge”. Abaixo, indicação contextual “› Conversas”. Os módulos, a busca extensa e a saudação do desktop não aparecem.
2. Subnavegação branca de uma linha, até y≈173. Conversas ativa, Contatos, Painel e Conteúdo visíveis; Agentes fica fora da área capturada. Manter a aba na sequência com rolagem horizontal, conforme o componente, sem concluir que ela foi removida.
3. Conteúdo com margens próximas de 12 px. Título em y≈195, explicação em várias linhas e botão “Apagamentos registrados” abaixo, alinhado à esquerda. O botão não ocupa a largura inteira.
4. Um único painel em x≈12, y≈369, largura≈336 px e altura≈101 px no estado vazio. Cabeçalho com duas opções em pílulas: Conversas ativa em navy e Histórico inativa contornada. Divisória, depois “Nenhuma conversa aberta.” com padding de aproximadamente 16 px.
5. O painel central e o histórico lateral do desktop não aparecem simultaneamente. Não há composer de mensagens nem altura mínima de painel até o fim da tela neste estado. O fundo claro segue até a base; FAB próximo de 16 px das bordas.

## Componentes existentes a reutilizar

Todos os nomes desta tabela existem como diretórios em `ChatFlow-Design-System/components/`, com `README.md` e `preview.html`, e são exportados por `window.ChatFlow` no bundle. “Adaptação” significa composição/estilo no futuro aplicativo consumidor, sem alterar o design system nesta tarefa.

| Componente real e referência | Uso previsto e API verificada | Limite relevante |
|---|---|---|
| [TopBar](../ChatFlow-Design-System/components/TopBar/README.md) | Moldura desktop; `active="Atendimento"`, `unit`, `user`, `initials`, `logoSrc` e `modules` | Unidade é um `span`, busca é uma `div` e links usam `href="#"`. Não há comportamento de seleção/busca nem layout móvel implementado no CSS. O cabeçalho celular exige composição específica no consumidor. |
| [Tabs](../ChatFlow-Design-System/components/Tabs/README.md) | Subnavegação; `items`, `value="Conversas"`, `onChange` | Já oferece rolagem horizontal e `aria-selected`; roteamento, associação aos painéis e navegação por setas precisam ser planejados no consumidor. |
| [Button](../ChatFlow-Design-System/components/Button/README.md) | “Apagamentos registrados” com `variant="secondary"` e `onClick` | Destino e conteúdo desse fluxo não estão nos prints. Para futuras ações primárias, recomendado `accessible` para texto navy sobre ciano. |
| [Segmented](../ChatFlow-Design-System/components/Segmented/README.md) | Alternância móvel Conversas/Histórico; `items`, `value`, `onChange` | Semântica de grupo com `aria-pressed`, não abas completas; visual atual tem trilho cinza e raios menores que as pílulas do print. Prever estilo local no consumidor. |
| [FilterChip](../ChatFlow-Design-System/components/FilterChip/README.md) | Períodos do histórico: Hoje, 7 dias, 30 dias; `active`, `onClick`, texto em `children`, sem `count` | O consumidor garante seleção exclusiva e aplica filtro; o componente não consulta dados. |
| [ChatFab](../ChatFlow-Design-System/components/ChatFab/README.md) | Assistente global, `label="Abrir chat"` | Tem aparência e nome acessível, mas não recebe/encaminha `onClick` e não define posição fixa. Planejar integração no consumidor; não presumir que já abre chat. |

### Reuso parcial e elementos ausentes

- [EmptyState](../ChatFlow-Design-System/components/EmptyState/README.md) existe e recebe `children`, mas aplica borda tracejada, padding e texto centralizado. Os vazios do print têm texto simples sem caixa tracejada. Recomendado usar texto semântico na composição dos painéis para fidelidade; reservar esse componente para vazios explicativos futuros ou avaliar estilo local. Não aplicá-lo diretamente como se reproduzisse o print.
- `.k1-panel` é uma classe utilitária real em `bundle.css`, não um componente React exportado. Pode orientar superfície/borda/raio dos três painéis, ajustando padding por região no consumidor.
- Não existem componentes dedicados para lista de conversas, linha de conversa, mensagens, composer, seletor de atendimento, cabeçalho móvel Concierge, modal de apagamentos ou painel de histórico. São lacunas do aplicativo a planejar, sem criar código agora.
- Componentes de tarefas, assuntos e status de eventos existentes no catálogo não devem ser usados para inventar estados do atendimento. Não há equivalência documentada entre status de tarefa e controle humano/Capi.

## Tokens e decisões visuais

- Moldura: `navy-950` (#020e1a); campos sobre navy: `navy-900` e bordas `navy-700`.
- Página clara: `surface-page` (#f5f6f8); painéis: `surface-card` (#ffffff); divisórias: `border`; campos/botão contornado: `border-strong`.
- Texto: `ink` para títulos e ações, `ink-muted` para explicação e vazios. Recomendado `brand-text` (#007d75) no texto da aba ativa para legibilidade; manter `brand-500` no sublinhado e destaque do FAB. O ciano claro do print não deve ser copiado como texto de baixo contraste.
- Fonte Inter para interface, título `page-title` (22/28, 700), corpo de apoio `body-sm` (13/19). Horários/contagens futuros em JetBrains Mono. Fraunces não participa desta tela.
- Ritmo a partir de `space-1` a `space-6`; os prints apresentam margens de aproximadamente 16 px no desktop e 12 px no celular, apesar da recomendação geral de 24 px do README. Recomendado priorizar estas referências da tela e registrar a diferença na revisão visual.
- Painéis com `radius-xl`; botão secundário com `radius-md`; períodos, alternância móvel e FAB com `radius-pill` quando ajustados no consumidor. Borda antes de sombra; `shadow-fab` apenas no botão flutuante.

## Estados e transições a prever

| Estado | Evidência ou proposta | Comportamento planejado |
|---|---|---|
| Nenhuma conversa aberta | Observado nos dois prints | Mostrar a frase da lista; desktop mantém o painel central com orientação. Celular mantém painel compacto em Conversas. |
| Nenhuma conversa selecionada | Observado no desktop | Orientação central “Escolha uma conversa para acompanhar.”, sem composer. |
| Histórico vazio | Observado no desktop | Hoje ativo, seletor “Todos os atendimentos” e frase “Nenhuma conversa neste período.” |
| Alternância móvel | Controle observado; Histórico aberto não foi capturado | Proposta: trocar o conteúdo do painel entre lista e histórico, preservando período e seleção. |
| Lista preenchida / conversa aberta | Proposta, sem referência visual | Selecionar conversa exibe mensagens. No celular, recomendado abrir um detalhe com ação Voltar para a lista, preservando posição de rolagem. Validar linha, remetente, horário, não lidas e ordenação. |
| Capi ativo / atendimento humano | Regra descrita no texto da página | Capi responde automaticamente; assumir silencia o Capi imediatamente; após 30 min sem escrita humana o controle retorna ao Capi. Validar contrato do servidor, significado de “escrever”, persistência e indicador visual antes de implementar. Não criar temporizador apenas local como fonte de verdade. |
| Carregando | Proposta necessária para integração | Exibir indicador textual “Carregando conversas…” ou equivalente por região, com `aria-busy`, mantendo o layout. Não mostrar frases de vazio antes da resposta. Em atualização, preservar conteúdo já disponível e evitar disparos duplicados. |
| Erro / nova tentativa | Proposta necessária para integração | Estados independentes para lista, mensagens e histórico; informar “Não foi possível carregar as conversas.” e disponibilizar “Tentar novamente”. Falha não equivale a lista vazia. Preservar filtros e seleção; erro de autorização exige tratar acesso/sessão. Anunciar alterações sem mover foco arbitrariamente. |
| Envio pendente / enviado / erro | Proposta para detalhe futuro | Preservar rascunho, evitar duplicação e permitir recuperação de falha; depender do contrato de mensagens. |
| Apagamentos registrados / assistente aberto | Apenas gatilhos visíveis | Definir navegação, conteúdo, permissão, foco ao abrir/fechar e retorno. Não inferir exclusão de conversa a partir do rótulo do botão. |

## Responsividade proposta

Recomendado implementar por disponibilidade de espaço, validando inicialmente as larguras de referência 1440 e 360 px. O design system não define breakpoints. Como hipótese inicial de trabalho, usar três painéis a partir de 1200 px, composição de uma área por vez abaixo de 768 px e uma composição intermediária de dois painéis entre essas larguras, com histórico acessível por alternância. Esses limites não foram observados nos prints e exigem revisão em 768, 1024 e 1200 px.

- Desktop: lista perto de 360 px, histórico perto de 320 px e conversa flexível, com `min-width` que preserve leitura. Ajustar ao espaço real, evitando overflow da página e colisão da busca global com os módulos.
- Celular: cabeçalho em linhas, nenhuma grade de três colunas comprimida; título/explicação quebram naturalmente e ação fica abaixo. Alternância com duas opções ocupando a largura interna do painel; subnavegação rola sem quebrar linha.
- Detalhe móvel futuro: teclado virtual, mensagens longas, retorno à lista e rascunho precisam de validação. Recomendado rolagem do histórico de mensagens dentro do detalhe, preservando acesso ao composer e às ações.
- FAB: fixar no consumidor, respeitando área segura do aparelho e mantendo respiro para não cobrir conteúdo ou composer. README recomenda 24 px das bordas; prints mostram aproximadamente 16 px. Recomendado começar com 16 px para reproduzir esta tela e validar a divergência visual.
- Acessibilidade: rótulo associado ao seletor do histórico, foco visível, controles operáveis por teclado, indicação de seleção além da cor e alvos de toque recomendados de pelo menos 44 px. O estilo compacto atual precisará de revisão local. Campos, links e seletores da barra devem ter semântica funcional, além da aparência.

## Dados necessários e contratos a definir

Os nomes abaixo são conceituais, propostos para orientar a integração. Não são nomes de campos ou endpoints confirmados pelo PDF. Recomendado validar o modelo com o responsável pela API antes de programar o fluxo preenchido.

| Grupo | Dados mínimos propostos | Finalidade e regra a confirmar |
|---|---|---|
| Contexto e acesso | Identificadores de empresa/unidade, nome da unidade, usuário autenticado, nome/iniciais, agente e permissões | Preencher moldura e limitar consultas/ações à unidade autorizada; o isolamento deve ocorrer no servidor. |
| Lista de conversas | Identificador estável da conversa, contato (identificador e nome exibido), canal, resumo/horário da última mensagem, contagem de não lidas, situação aberta/encerrada | Identificar e ordenar as linhas sem expor o telefone completo desnecessariamente. Conteúdo e aparência da linha ainda precisam de referência. |
| Controle do atendimento | Conversa, controlador atual (agente/equipe), atendente quando aplicável, instante da última mensagem humana, prazo de retorno, versão do estado | Exibir quem atende e evitar duas tomadas de controle inconsistentes. Servidor deve informar o estado autoritativo e resolver concorrência. |
| Mensagens | Identificador interno e identificador do provedor quando houver, conversa, autoria (cliente/equipe/agente), texto, tipo, horário e estado de envio | Renderizar e ordenar mensagens, deduplicar eventos e recuperar falhas. Anexos, áudio, recibos de leitura e respostas encadeadas são escopo a confirmar. |
| Histórico de atendimento | Identificador da sessão de atendimento, conversa/contato, início/fim, responsável/controlador e situação | Filtrar sessões no período e permitir abrir o registro, se autorizado. Definir diferença entre atendimento e conversa. |
| Filtros | Período selecionado, início/fim calculados, fuso da unidade, tipo de atendimento, opções do seletor | Definir se Hoje usa calendário local, se 7/30 dias incluem hoje e quais opções existem além de “Todos os atendimentos”. |
| Apagamentos registrados | Identificador do evento, entidade afetada, data/hora, autor e metadados autorizados | O rótulo do botão não esclarece o que foi apagado nem o conteúdo consultável. Confirmar modelo, permissões e retenção sem presumir restauração ou exclusão nesta tela. |
| Paginação e sincronização | Cursor/limite, existência de mais itens, versão/horário da atualização e estado da conexão | Carregar histórico e mensagens sem perder posição; decidir entre eventos em tempo real e consultas periódicas, com reconexão e deduplicação. |
| Falhas e operações | Categoria de erro, indicação de recuperação, identificador da operação de envio, confirmação de sucesso | Separar erro de rede, sessão expirada, ausência de permissão e conflito. Recomendado chave idempotente no envio para evitar mensagens repetidas, conforme suporte do provedor. |

Operações a contratar: consultar lista, consultar detalhe/mensagens, consultar histórico filtrado, assumir atendimento, enviar mensagem humana e consultar apagamentos autorizados. Validar também atualização após o retorno automático ao agente. Não inventar URLs ou inferir essas operações a partir dos endpoints de reservas.

Estado local de interface: aba do módulo, Conversas/Histórico no celular, conversa selecionada, filtros, rascunho, posição de rolagem e estado de cada requisição. Separar esse estado do controle de atendimento mantido no servidor. Troca de unidade deve invalidar seleção e dados da unidade anterior.

Dados de validação recomendados para a implementação futura: lista vazia, lista preenchida, histórico sem resultados, textos e nomes longos, mensagem recebida durante seleção, falha de carregamento por região, falha/reenvio sem duplicar mensagem, perda de conexão e disputa de tomada de atendimento. Para os 30 minutos, testar antes/no limite e nova mensagem humana reiniciando o prazo, conforme regra homologada.

## Passos de implementação futuros

1. Confirmar como integrar esta tela ao aplicativo Node/React já existente, o escopo da primeira entrega, a navegação e os contratos de dados. Recomendado iniciar pelo estado vazio fiel aos dois prints, depois integrar os estados com conversa.
2. Preparar o consumo dos tokens e do bundle no aplicativo, respeitando `.k1` e tema claro, sem editar o pacote do design system. Confirmar React 18 ou estratégia de integração conforme README e disponibilidade de fontes/logo.
3. Compor moldura desktop, cabeçalho móvel e subnavegação; conectar navegação real e seletores quando os contratos existirem.
4. Compor cabeçalho da página e três painéis desktop; reproduzir vazios, divisórias, alturas e proporções observadas.
5. Compor a alternância móvel e o histórico reutilizando o mesmo estado de filtros; não duplicar requisições apenas por haver duas composições responsivas.
6. Integrar lista, detalhe, mensagens e histórico com carregamento, erro e recuperação independentes; definir paginação, atualização e preservação de seleção/rascunho.
7. Integrar assumir atendimento e retorno ao Capi com estado autoritativo do servidor; implementar apagamentos e assistente após esclarecer fluxos e permissões.
8. Revisar com capturas em 1440 × 900 e 360 × 780, mais larguras intermediárias. Conferir textos, ausência de overflow horizontal global, alternância móvel, foco/teclado, contraste, seletor do histórico e comportamento do FAB. Verificar carregamento, falha, vazio e conversa preenchida com dados controlados.

## Lacunas a resolver antes de fechar a tela

- Confirmar escopo específico do atendimento e integração à estrutura atual de `src/` e `web/`; a existência da API de reservas/contexto não comprova os contratos necessários para conversas.
- Sem exemplos visuais de conversa preenchida, histórico móvel aberto, composer, seleção humana/Capi, menus da barra ou apagamentos. Solicitar referências ou validar a proposta com o responsável.
- Definir API, autenticação, unidade corrente, permissões, origem WhatsApp, atualização em tempo real, ordenação, paginação, busca e fuso dos horários.
- Definir se Hoje/7 dias/30 dias são intervalos corridos ou calendários, inclusão das extremidades e opções além de “Todos os atendimentos”.
- Confirmar a regra dos 30 minutos, registro de intervenções, conflitos entre atendentes e indisponibilidade da conexão.
- README da TopBar promete menu e busca compacta móvel, mas o bundle não os implementa; o print usa “Concierge”, diferente do módulo “Atendimento” desktop. Validar a relação entre módulo e contexto antes de definir navegação.
- `ChatFab` é apenas visual no bundle atual. Definir integração sem presumir suporte a callback ou posicionamento pronto.
- Logo oficial ChatFlow em `web/logo-chatflow.png` (sem alteração). Revisar fontes externas para o ambiente de execução.
- Tipografia, espaçamento, breakpoints e variantes de pílula ainda requerem conferência; esta tarefa não altera tokens nem componentes para resolver diferenças.

## Verificação dos componentes citados

Lista conferida contra os diretórios, READMEs, previews e exports do bundle:

| Nome | Diretório existente |
|---|---|
| TopBar | `ChatFlow-Design-System/components/TopBar/` |
| Tabs | `ChatFlow-Design-System/components/Tabs/` |
| Button | `ChatFlow-Design-System/components/Button/` |
| Segmented | `ChatFlow-Design-System/components/Segmented/` |
| FilterChip | `ChatFlow-Design-System/components/FilterChip/` |
| ChatFab | `ChatFlow-Design-System/components/ChatFab/` |
| EmptyState (reuso parcial, não aplicado diretamente ao vazio do print) | `ChatFlow-Design-System/components/EmptyState/` |

Critérios documentais: desktop e celular cobertos; layout, componentes reais, estados, responsividade, passos e lacunas descritos. Validação de execução e comparação visual do futuro aplicativo permanecem fora desta entrega documental.
