---
schema_version: 1
id: OPP-20261125-a3k7
display_number: 1
context: nucleo-api
verb: modularize
title: Quebrar tratar() (cerca de 465 linhas) em módulos de rotas
target:
  files: [src/nucleo.js]
  symbol: tratar
smell: função deus; login, sessão, usuários, empresas, agente, histórico e mesas no mesmo corpo e no mesmo escopo de variáveis
roi:
  confidence: green
  impact: todo pedido da API passa por aqui e é o arquivo que mais muda (9 commits em 90 dias); cada rota nova aumenta o risco de regressão de permissão
  cost: medium
  est_return: rotas de sessão e de usuários isoladas em arquivos próprios, revisão de permissão por arquivo e menos conflito entre features
state: applied
traceability:
  soul: []
  specs: [_reversa_forward/002-usuarios-por-camada/interfaces/usuarios-http.md]
---

`tratar()` vai da linha 292 ao fim do arquivo (757). As rotas `/login`, `/logout`, `/eu*` e `/usuarios*` (linhas 302 a 435) compartilham variáveis (`doUsuario`, `superadmin`, `staff`) com as demais. Proposta: extrair `src/rotas/sessao.js` e `src/rotas/usuarios.js` recebendo um contexto de requisição já resolvido, e manter `tratar()` só como despachante. `src/nucleo.js` fica fora de `src/node/`, então os novos arquivos seguem a regra do núcleo sem Node (sem `node:`, `Buffer` nem `process`).

Rede de segurança existente: `tests/usuarios-api.test.js` (27), `tests/contrato-usuarios.test.js` (15), `tests/api.test.js` e o diferencial `tests/diferencial-usuarios.js` (65 chamadas JS x Rust).
