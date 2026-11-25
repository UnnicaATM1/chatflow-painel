---
schema_version: 1
id: OPP-20261125-x9ph
display_number: 3
context: nucleo-api
verb: simplify
title: Trocar as guardas repetidas "if (!staff) ... 403" e o decodeURIComponent do id por helpers
target:
  files: [src/nucleo.js]
  symbol: tratar
smell: 20 repetições de `if (!staff) return resp(403, ...)` e 11 de `decodeURIComponent(partes[1])`; as variações de guarda (superadmin, reautenticar, empresa liberada) ficam escondidas no meio de cada rota
roi:
  confidence: green
  impact: permissão é o ponto mais perigoso de esquecer ao criar rota nova; centralizar reduz o risco
  cost: low
  est_return: guardas nomeadas (`exigirStaff`, `exigirSuperadmin`, `exigirReautenticacao`) e `empresaId` calculado uma vez
state: proposed
traceability:
  soul: []
  specs: [docs/usuarios-e-camadas.md#camadas]
---

Não mudar nenhuma regra: só dar nome e ponto único às guardas que já existem. Fazer depois da OPP-20261125-a3k7 ou junto dela, pois as guardas serão usadas pelos módulos extraídos.
