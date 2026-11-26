---
schema_version: 1
id: OPP-20261125-m2qd
verb: restructure
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
    file: src/nucleo.js
    purpose: helpers limitarLogin e senhaDoUsuarioConfere no lugar do trecho repetido em /login, /eu/reautenticar, /eu/senha e excluir
approval:
  by: user
  at: 2026-11-25
reversible_via: [CHG-001.diff]
---

Rede de segurança: `CHATFLOW_TESTE_OPERACAO=1 npm test` (193 testes) verde antes e depois, `npm run test:worker` (41), `npm run test:worker:d1` (42) e `node tests/diferencial-usuarios.js` (65 chamadas JS x Rust, 0 diferenças) verdes ao final da rodada.

Respostas 429 e 403 idênticas; o diferencial JS x Rust continua com 0 diferenças.
