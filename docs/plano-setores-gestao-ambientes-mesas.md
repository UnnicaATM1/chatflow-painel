# Plano por setores: gestão de ambientes, mesas e exclusão definitiva de reserva

Arquiteto: T00. Data: 2026-11-21. Origem: pendências ativas do HANDOFF.md ("Front A&B/Atendimento" e "Remover ou renomear ambiente e remover mesa").

## Setores

- Banco de dados (T002): operações do repositório (memória e SQLite), migração se preciso, fechamento da TASK-014 (reconfirmar O1/O2 sem o T05, que não existe neste ambiente) e script de backup/restauração SQLite + `.arquivos/`.
- Frontend e Backend (T001): rotas HTTP em `src/` (JS), paridade em `rust/`, painel `web/`, vendorizar React, trocar `window.confirm` da aba API.

## Decisões de regra (Arquiteto, sem depender do João)

- Remover mesa com reserva ATIVA (confirmada, hoje ou futura) é recusado com 409. Reservas canceladas ou passadas ficam com `mesaId: null` e o histórico guarda o `mesaId` antigo.
- Remover ambiente exige que todas as mesas dele estejam removíveis pela regra acima; senão 409 e nada é gravado (tudo ou nada). Remover o ambiente remove as mesas dele.
- Renomear ambiente: nome único dentro da empresa, 1 a 60 caracteres.
- Excluir reserva em definitivo: só reserva já cancelada. Reserva ativa devolve 409 (cancelar antes).
- Tudo vai para o histórico (só equipe e integração; chave de API da empresa recebe 403).

## Contrato A: repositório (Banco de dados entrega, Frontend e Backend consome)

Mesmas assinaturas no repositório em memória e no SQLite, todas `async`, atômicas:

- `ambienteRenomear(empresaId, ambienteId, nome)` devolve o ambiente atualizado ou `{erro:"nome_duplicado"|"nao_encontrado"}`.
- `ambienteRemover(empresaId, ambienteId)` devolve `{ok:true, mesasRemovidas:[ids]}` ou `{erro:"nao_encontrado"}` ou `{erro:"mesa_com_reserva", reservas:[reservaId...]}` (nada gravado).
- `mesaRemover(empresaId, mesaId)` devolve `{ok:true, reservasDesligadas:[reservaId...]}` ou `{erro:"nao_encontrado"}` ou `{erro:"mesa_com_reserva", reservas:[...]}`.
- `reservaExcluir(empresaId, reservaId)` devolve `{ok:true, reserva:<instantâneo>}` ou `{erro:"nao_encontrada"}` ou `{erro:"reserva_ativa"}`.
- O `reservaId` público continua sendo o código por empresa e `reservas_codigos` preserva o código emitido (nunca reaproveitar).
- SQLite: `reservas.mesa_id` aceita NULL (migração nova em `src/sqlite/migracoes.js` se hoje for NOT NULL, preservando dados).

## Contrato B: HTTP (Frontend e Backend entrega; JSON na ordem de chaves igual no JS e no Rust)

- `PATCH /empresas/:id/ambientes/:ambienteId` corpo `{nome}` devolve 200 com o ambiente; 409 `nome já usado`; 404.
- `DELETE /empresas/:id/ambientes/:ambienteId` devolve 200 `{ok:true, mesasRemovidas}`; 409 `{erro, reservas}`; 404.
- `DELETE /empresas/:id/mesas/:mesaId` devolve 200 `{ok:true, reservasDesligadas}`; 409 `{erro, reservas}`; 404.
- `DELETE /empresas/:id/reservas/:rid?definitivo=1` devolve 200 `{ok:true}`; 409 se ativa; sem `definitivo=1` mantém o comportamento atual (cancela).
- Papéis: equipe e integração; chave da empresa 403. Módulo `reservas` desligado devolve 404, como hoje.
- Histórico: eventos `ambiente_renomeado`, `ambiente_removido`, `mesa_removida`, `reserva_excluida` com antes/depois; `reserva_excluida` guarda instantâneo completo (dado pessoal, ver LGPD).

## Critérios de aceite gerais

- `npm test` verde em memória e SQLite (inclusive `CHATFLOW_TESTE_OPERACAO=1`), régua de contrato `tests/api.test.js` verde contra JS e contra o binário Rust.
- Nenhum arquivo do design system alterado fora do que o painel já copia.
- HANDOFF.md atualizado por quem concluir, com o bloco Status validado.

## Ordem

1. Banco (TASK-001) entrega Contrato A. 2. Frontend e Backend (TASK-002) começa pelo painel e pelas rotas contra o contrato; integra quando o app liberar a dependência. 3. Arquiteto valida o encaixe e fecha.
