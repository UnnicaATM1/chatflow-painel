---
schema_version: 1
id: OPP-20261125-c5wn
display_number: 4
context: nucleo-api
verb: standardize
title: Corrigir indentação e uso misto de hashChave e plat.sha256Hex
target:
  files: [src/nucleo.js]
  symbol: tratar (rotas de chave de API e login)
smell: linha com indentação a mais (`await store.chaveDefinir`, dentro do POST de chave) e dois nomes para o mesmo SHA-256 (`hashChave` e `plat.sha256Hex`)
roi:
  confidence: green
  impact: leitura e revisão; sem efeito em tempo de execução
  cost: low
  est_return: arquivo coerente, útil antes de extrair módulos
state: applied
traceability:
  soul: []
  specs: []
---

Mudança só de formatação e de nome local. Cuidado com o fim de linha: gravar mantendo LF (o teste "núcleo sem Node" quebra com CRLF).
