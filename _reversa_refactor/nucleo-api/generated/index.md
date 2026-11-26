# Índice: nucleo-api

> GENERATED. Não editar à mão.

Atualizado em 2026-11-25. Modo de controle: autonomous. Rede de segurança: require-characterization.

| # | ID | Verbo | Confiança | Custo | Estado | Título |
|---|----|-------|-----------|-------|--------|--------|
| 1 | OPP-20261125-a3k7 | modularize | 🟢 | médio | applied | Quebrar tratar() em módulos de rotas |
| 2 | OPP-20261125-m2qd | restructure | 🟢 | baixo | applied | Unificar limite de tentativas e conferência de senha |
| 3 | OPP-20261125-x9ph | simplify | 🟢 | baixo | applied | Helpers para guardas de permissão e id da empresa |
| 4 | OPP-20261125-c5wn | standardize | 🟢 | baixo | applied | Indentação e nome único do hash |
| 5 | OPP-20261125-t8zr | decouple | 🟡 | alto | approved (permissões aplicadas em JS e Rust; tabela de rotas pendente) | Tabela declarativa de rotas JS x Rust |

Aplicadas nesta ordem: 4, 2, 3, 1 e, a pedido, a camada de permissões da 5 (src/permissoes.js e rust/one-core/src/permissoes.rs).
