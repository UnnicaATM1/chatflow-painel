# Fluxo ONE para o NicoChat

Pasta de fluxos "ONE" (workspace Unnicaflow, canal Chatflow). Aqui ficam os arquivos prontos para
criar ou importar no NicoChat. O NicoChat foi conectado como MCP depois que a sessão de trabalho
começou, então nada foi criado lá ainda: estes arquivos são o que falta colocar na pasta de fluxos dele.

## Como funciona

1. **Toda conversa nova** começa chamando o ONE (`one_contexto`): o NicoChat recebe o nome do agente,
   a personalidade, as habilidades, as restrições e um prompt pronto, tudo cadastrado no ONE.
2. A IA do NicoChat conversa usando esse prompt. Durante a conversa ela aciona funções do ONE:
   - cliente pergunta **preço, horário, pagamento, regra** → `one_buscar_conhecimento` (tabela de preços,
     textos e documentos cadastrados em Conhecimento; devolve só o que interessa);
   - cliente quer **reservar mesa** → `one_disponibilidade` (mesas livres por ambiente) e depois
     `one_reservar` (grava a reserva com nome e contato do cliente).
3. A resposta ao cliente é montada pela IA com os dados que o ONE devolveu.

O `#one` não faz parte do funcionamento: é só um jeito opcional de disparar um teste manual.

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

## Pendente

- Reabrir a sessão (`claude --continue`) para carregar as ferramentas do MCP do NicoChat e criar o fluxo
  na pasta de fluxos dele (Unnicaflow, canal Chatflow).
- Publicar o ONE em um endereço público (servidor ou túnel) para o NicoChat conseguir chamar.
- Adaptar `fluxo-one.json` e as functions ao formato de importação do NicoChat.
