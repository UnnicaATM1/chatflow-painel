# Fluxo ONE para o NicoChat

Pasta de fluxos "ONE" (workspace Unnicaflow, canal Chatflow). Aqui ficam os arquivos prontos para
importar ou recriar no NicoChat. O NicoChat ainda não está conectado como MCP a esta sessão, então
nada foi criado lá: estes arquivos são o que falta colocar na pasta de fluxos do NicoChat.

## O que tem aqui

| Arquivo | Para quê |
|---|---|
| `fluxo-one.json` | O fluxo: gatilho `#one`, passos e regras (formato neutro, adapte ao NicoChat) |
| `functions/one_contexto.json` | Traz o contexto completo do agente e o prompt pronto |
| `functions/one_disponibilidade.json` | Mesas livres por ambiente (só empresas com reservas) |
| `functions/one_reservar.json` | Registra a reserva, com `Idempotency-Key` |
| `simular-nicochat.js` | Simula o fluxo contra a API do ONE, sem precisar do NicoChat |

A aba **API** do ONE gera as mesmas functions já preenchidas com o id da empresa e o endereço
informado (botão "Copiar todas as functions").

## Variáveis (uma cópia do fluxo por empresa)

- `URL_ONE`: endereço PÚBLICO do ONE. `127.0.0.1` só existe no computador de desenvolvimento e o
  NicoChat roda na nuvem, então não funciona.
- `EMPRESA_ID`: por exemplo `empresa_1`.
- `CHAVE_API`: chave `k1_...` gerada na aba API da empresa. Guarde como segredo do NicoChat. A chave
  de uma empresa não funciona nas outras (403).

## Como o fluxo roda

1. O cliente manda uma mensagem que começa com `#one` (sem diferenciar maiúsculas).
2. O fluxo chama `one_contexto` e recebe `prompt` (agente + base de conhecimento + regras de reserva).
3. A IA do NicoChat responde usando esse prompt como instrução de sistema.
4. Se a empresa usa reservas, a IA chama `one_disponibilidade` e depois `one_reservar`, e só confirma
   ao cliente quando a resposta for `confirmada`.

## Testar sem o NicoChat

```
node nicochat/fluxos/ONE/simular-nicochat.js --url http://127.0.0.1:3456 --empresa empresa_1 --chave k1_...
node nicochat/fluxos/ONE/simular-nicochat.js --empresa empresa_1 --chave k1_... --reservar
```

Sem `--reservar` só lê. Com `--reservar` registra uma reserva de teste (amanhã, 20:00, 2 pessoas),
reenvia a mesma chave para provar que não duplica e confere o isolamento entre empresas. A reserva de
teste fica no ONE até a equipe cancelar no Workspace. Códigos de saída: 0 tudo certo, 1 falha, 2 faltou
argumento.

## Pendente

- Conectar o MCP do NicoChat à sessão para criar o fluxo ONE direto na pasta de fluxos dele.
- Publicar o ONE em um endereço público (servidor ou túnel) para o NicoChat conseguir chamar.
- Adaptar `fluxo-one.json` e as functions ao formato de importação do NicoChat.
