# Fluxo ONE para o NicoChat

Pasta de fluxos "ONE" (workspace Unnicaflow, canal Chatflow). Aqui ficam os arquivos prontos para
criar ou importar no NicoChat. O NicoChat foi conectado como MCP depois que a sessão de trabalho
começou. Estes arquivos são o modelo neutro; a montagem que está no ar está descrita mais abaixo.

## Como funciona

1. **Toda conversa nova** começa chamando o ONE (`one_contexto`): o NicoChat recebe o nome do agente,
   a personalidade, as habilidades, as restrições e um prompt pronto, tudo cadastrado no ONE.
2. A IA do NicoChat conversa usando esse prompt. Durante a conversa ela aciona funções do ONE:
   - cliente pergunta **preço, horário, pagamento, regra** → `one_buscar_conhecimento` (tabela de preços,
     textos e documentos cadastrados em Conhecimento; devolve só o que interessa);
   - cliente quer **reservar mesa** → `one_disponibilidade` (mesas livres por ambiente) e depois
     `one_reservar` (grava a reserva com nome e contato do cliente).
3. A resposta ao cliente é montada pela IA com os dados que o ONE devolveu.

No desenho de produção, toda conversa nova busca o contexto. Na fase de teste atual, quem inicia o fluxo é o `#one`.

## O que tem aqui

| Arquivo | Para quê |
|---|---|
| `fluxo-one.json` | O fluxo: gatilho (toda conversa nova), passos, quando chamar cada função e regras |
| `functions/one_contexto.json` | Contexto completo do agente e prompt pronto |
| `functions/one_buscar_conhecimento.json` | Busca no conhecimento (preços, horários, regras, documentos) |
| `functions/one_disponibilidade.json` | Mesas livres por ambiente (só empresas com reservas) |
| `functions/one_reservar.json` | Registra a reserva, com `Idempotency-Key`, nome e contato do cliente |
| `simular-conversa.js` | Simula uma conversa inteira contra o ONE, sem precisar do NicoChat |
| `simular-nicochat.js` | Checagem rápida de cada função e do isolamento entre empresas |

A aba **API** do ONE gera as mesmas functions já preenchidas com o id da empresa e o endereço informado.

## Variáveis (uma cópia do fluxo por empresa)

- `URL_ONE`: endereço PÚBLICO do ONE. `127.0.0.1` só existe no computador de desenvolvimento e o
  NicoChat roda na nuvem, então não funciona.
- `EMPRESA_ID`: por exemplo `empresa_1`.
- `CHAVE_API`: chave `k1_...` gerada na aba API da empresa. Guarde como segredo do NicoChat. A chave
  de uma empresa não funciona nas outras (403).
- `contato.nome` e `contato.telefone`: dados do contato que o NicoChat já tem, enviados na reserva.

## Testar sem o NicoChat

```
node nicochat/fluxos/ONE/simular-conversa.js --empresa empresa_1 --chave k1_... --nome "Carlos Lima" --contato "+55 11 91234-5678"
node nicochat/fluxos/ONE/simular-conversa.js --empresa empresa_1 --chave k1_... --reservar \
     --fala "quanto custa a lasanha?" --fala "quero mesa para 2 amanhã às 20h" --fala "mesa S1" --fala "confirmo"
```

Sem `--reservar` a reserva NÃO é gravada. Sem `--fala`, roda uma conversa de exemplo. A parte que a IA do
NicoChat faz (entender a frase) é por palavras-chave aqui, só para provar a comunicação. Códigos de saída:
0 tudo certo, 1 falha, 2 faltou argumento.

## Montagem que funcionou no NicoChat (PARK FOZ, 2026-11-26)

Padrão a repetir em cada canal (um canal por empresa):

1. Hotword `start_with #one` abre o sub-fluxo de conversa.
2. GET `{{one_url}}/empresas/{{one_empresa}}/contexto` com o cabeçalho `Authorization: Bearer {{one_chave}}`.
   `one_url`, `one_empresa` e `one_chave` são campos do bot (do canal). A chave é colada só na tela do NicoChat.
3. Mapeamentos da resposta:

| Caminho | Variável do contato | Tipo |
|---|---|---|
| `$.agente` | `one_agente` | JSON (`array`, até 20.000 caracteres) |
| `$.empresa.nome` | `one_empresa_nome` | texto |
| `$.recursos.reservas` | `one_reservas` | texto |

4. Rota `2` vai para o bloco Agente de IA. Rotas `0`, `4`, `5` e a saída padrão avisam a falha, esperam a
   próxima mensagem e consultam de novo. Confira as ligações na versão publicada.
5. Nos textos do agente, use o ID da variável, como `{{<id de one_agente> :: $.nome}}`. Cada canal tem IDs
   próprios. No teste, o nome da variável não foi substituído quando o agente foi editado pelo MCP.
6. Regras do agente: apresentar-se só na primeira resposta; nunca enviar marcador sem valor. Reservas:
   `one_reservas` chega como `1` (não como a palavra `true`); a regra aceita `1` ou `true` e só bloqueia mesas
   quando o valor está vazio, `0` ou `false`.
7. Descrição das mesas (`descricao` vem na disponibilidade):
   - no workflow de disponibilidade, o texto do "Resultado da função AI" manda usar a `descricao`;
   - o `function_prompt` de `check_table_availability` e as habilidades mandam citar a descrição, indicar até 3
     mesas conforme a preferência e não inventar característica; a restrição 8 aceita a descrição como fonte;
   - o campo "information" do agente inclui a última consulta (`{{<id de one_disp> :: $}}`, com data, horário e
     pessoas), para a descrição valer também nas mensagens seguintes. Sem isso, o agente respondeu que ia
     confirmar com a equipe um item que estava na descrição.
8. Bloco do agente com `idle_minutes: 1440`. Com 30, depois de uma pausa o agente padrão do canal assumiu a
   conversa e descreveu a mesa com características inventadas. Depois do prazo, é preciso enviar `#one` de novo.

O que não funcionou: gravar a resposta inteira (`$`) em uma variável Long JSON e ler com `:: $.caminho`.

Disponibilidade com descrição: provada em sandbox em 2026-11-27 (indicou cabanas perto da piscina pela
descrição; na mensagem seguinte descreveu outra mesa; disse que a descrição não menciona o que não está nela).
Ainda sem prova de ponta a ponta: busca no conhecimento e reserva.

## Reserva pela conversa (montada em 2026-11-27)

1. O agente pergunta, uma coisa por vez: data, horário e pessoas; mesa; nome da reserva (o nome do perfil é só
   sugestão); telefone (usa o do canal se confirmado; no canal web não existe); se há algo que a equipe precise saber.
2. Envia o resumo e só executa `book_table` depois do "sim".
3. Parâmetros novos de `book_table`: `customer_name`, `customer_phone`, `notes` (todos obrigatórios; sem
   observação, `notes` é `SEM_OBS`). Todos os parâmetros das duas funções com `memory: 0`, para não reaproveitar
   valores de uma conversa anterior.
4. No workflow, antes do POST, o bloco "Preparar dados da reserva" sorteia um número
   (`set_value` `rand_num`; `rand_text` gravou o formato literalmente), troca aspas e barras invertidas por
   caracteres seguros e transforma `SEM_OBS` em vazio.
5. POST com `nomeCliente`, `contato`, `observacao`; `Idempotency-Key: one-{{user_ns}}-{{<sorteio>}}`.
6. O resultado manda enviar a confirmação com código, local e descrição, data com dia da semana, horário, pessoas,
   nome, telefone e observação.
7. O site grava `observacao` (uma linha, até 300 caracteres; migração `0005`) e a mostra na lista de reservas e no
   detalhe do mapa. O `/contexto` troca `{{data_hora_atual}}` pela data e hora do fuso do negócio. **Os dois só
   valem no site depois de publicar**; antes disso o site ignora a observação.

Provado em sandbox: conversa até o resumo (sem confirmar) e o workflow com data inválida (o site leu o corpo e a
chave; nenhuma reserva criada). Falta a prova de uma reserva real de ponta a ponta.

Limite conhecido: com o site novo, nome acima de 80, contato acima de 40 ou observação acima de 300
caracteres dão 400; o resultado de falha não mostra o motivo ao agente e a equipe não é avisada.

## Pendente

- Cadastrar o conhecimento e testar a busca; testar a reserva (grava de verdade na empresa).
- Repetir a montagem nos canais das outras empresas.
