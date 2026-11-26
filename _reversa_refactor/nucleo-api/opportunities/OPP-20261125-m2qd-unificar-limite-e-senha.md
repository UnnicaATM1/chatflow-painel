---
schema_version: 1
id: OPP-20261125-m2qd
display_number: 2
context: nucleo-api
verb: restructure
title: Unificar o limite de tentativas e a conferência de senha repetidos nas rotas /eu
target:
  files: [src/nucleo.js]
  symbol: tratar (POST /login, /eu/reautenticar, /eu/senha)
smell: duplicação; o mesmo trecho de limite por e-mail (429 com Retry-After) e de conferência da senha atual aparece em 3 rotas
roi:
  confidence: green
  impact: regra de segurança sensível copiada em vários lugares pode divergir; hoje são 4 chamadas a limiteLogin.contar
  cost: low
  est_return: um helper para o limite e outro para conferir a senha do usuário logado, com uma única mensagem e um único cabeçalho Retry-After
state: applied
traceability:
  soul: []
  specs: [docs/usuarios-e-camadas.md#segurança]
---

Extrair `limitarLogin(ctx, chaves)` (devolve a resposta 429 ou `null`) e `senhaConfere(ctx, usuarioId, senha)`. Comportamento externo idêntico (status, corpo e cabeçalhos), o que o diferencial JS x Rust já compara.
