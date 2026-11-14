# SDD agente-config  (score estimado 85)
Entrada: empresa_id. Saída: {descricao, habilidades[], produtos[], restricoes[]}. Somente leitura via token; 404 empresa inexistente; 401 sem token. Edição: `atualizar(empresa_id, campo, valor, papel)` respeita permissões por campo (papel cliente|integracao). Isolamento por empresa.
