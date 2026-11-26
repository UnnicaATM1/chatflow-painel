---
schema_version: 1
id: OPP-20261125-t8zr
verb: decouple
state: applied
safety_net:
  kind: existing
  green_before: true
  green_after: true
preservation:
  method: tests
  evidence: [safety-net/depois.txt, CHG-001.diff]
measurement:
  before: ver oportunidade
  after: ver oportunidade
change_set:
  - chg: CHG-001
    file: src/permissoes.js, src/nucleo.js, src/rotas-usuarios.js, tests/permissoes.test.js
    purpose: camada de permissões: uma tabela PERMISSOES (ação para lista de camadas) e podeFazer(papel, ação), usada por todas as guardas do núcleo
approval:
  by: user
  at: 2026-11-25
reversible_via: [CHG-001.diff]
---

Rede de segurança: `CHATFLOW_TESTE_OPERACAO=1 npm test` (196 testes) verde antes e depois, `npm run test:worker` (41), `npm run test:worker:d1` (42) e `node tests/diferencial-usuarios.js` (65 chamadas JS x Rust, 0 diferenças) verdes ao final da rodada.

Parte JS aplicada a pedido do João (acessível para editar permissões). A tabela espelhada em Rust (rust/one-core) ainda não existe.
