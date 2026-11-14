# SDD agente-config  (score estimado 85)
Entrada: loja_id. Saída: {descricao, habilidades[], produtos[], restricoes[]}. Somente leitura via token; 404 loja inexistente; 401 sem token. Edição: `atualizar(loja_id, campo, valor, papel)` respeita permissões por campo (papel cliente|integracao). Isolamento por loja.
