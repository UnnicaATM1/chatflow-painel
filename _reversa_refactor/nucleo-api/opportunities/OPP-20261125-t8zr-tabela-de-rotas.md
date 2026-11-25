---
schema_version: 1
id: OPP-20261125-t8zr
display_number: 5
context: nucleo-api
verb: decouple
title: Tabela declarativa de rotas e permissões compartilhada entre JS e Rust
target:
  files: [src/nucleo.js, rust/one-core/src/nucleo.rs]
  symbol: tratar
smell: as mesmas regras de rota e de camada existem escritas à mão em dois idiomas; a paridade só é garantida pelo diferencial
roi:
  confidence: yellow
  impact: cada regra nova (como as camadas da feature 002) precisa ser escrita duas vezes; risco de divergência silenciosa
  cost: high
  est_return: uma descrição (método, caminho, camada mínima, exige reautenticação) validada por teste nos dois lados
state: proposed
traceability:
  soul: []
  specs: [_reversa_forward/002-usuarios-por-camada/interfaces/usuarios-http.md]
---

Só vale depois de modularizar o JS (OPP-20261125-a3k7). Confiança 🟡: a paridade é provada pelo diferencial de usuários, mas as demais rotas dependem de `tests/api.test.js` contra o binário Rust. Rust persistente (pendência do HANDOFF) deve vir antes ou junto.
