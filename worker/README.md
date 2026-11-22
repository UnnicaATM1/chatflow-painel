# Worker do ChatFlow Painel

`npm run build:worker` empacota o módulo ESM em `dist/server/index.js` e copia o manifesto para `dist/.openai/hosting.json`. O ESM incorpora os arquivos de `web/` e `web/vendor/` para o formato do starter do Sites. A raiz redireciona para `/app/` e o painel chama a API na mesma origem.

`npm run test:worker` roda a régua HTTP de `tests/api.test.js` no Miniflare em memória. `npm run test:worker:d1` roda a mesma régua com D1 e R2 locais, aplica o SQL empacotado e verifica a reabertura após reinício. A fixture semeia uma chave da empresa para os cenários de chat e fica fora do artefato publicado. Os testes do executável Node e os testes internos do núcleo continuam em `npm test`.

Configure `CHATFLOW_TOKEN_CLIENTE`, `CHATFLOW_TOKEN_INTEGRACAO` e `CHATFLOW_ADMIN_SENHA` nos valores de runtime do Sites. `CHATFLOW_CORS_ORIGENS` é uma lista opcional separada por vírgulas e `CHATFLOW_FUSO` define o fuso do negócio. A API do NicoChat usa a chave da própria empresa.

O manifesto declara os bindings `DB` e `BUCKET`. O build inclui as migrações entregues pelo banco em `dist/.openai/drizzle/`. Em runtime, o Worker usa D1 para registros e R2 privado para anexos. Com ambos os bindings ausentes, usa memória para validar o transporte e perde os dados em reinícios.

Os contadores de limite valem por isolate, inclusive com D1. O limite por IP usa o cabeçalho `CF-Connecting-IP` do ingresso Cloudflare e agrupa requisições quando ele estiver ausente.
