// CAMADA DE PERMISSÕES: o único lugar onde se decide QUEM pode fazer O QUÊ na API.
//
// Para liberar ou bloquear uma ação para uma camada, edite só a lista da ação em PERMISSOES abaixo.
// O núcleo (src/nucleo.js e src/rotas-*.js) pergunta com podeFazer(papel, 'acao') e não tem lista própria.
//
// Camadas (papéis) que existem:
//   equipe       usuário com login, só nas empresas liberadas para ele
//   admin        usuário com login, só nas empresas liberadas para ele
//   superadmin   usuário com login, todas as empresas
//   cliente      chave de acesso do painel (variável CHATFLOW_TOKEN_CLIENTE), sem login individual
//   integracao   chave de integração (CHATFLOW_TOKEN_INTEGRACAO), equivale a superadmin
//   chat         chave `k1_…` de uma empresa: NÃO está em nenhuma lista aqui; só alcança as rotas de chat daquela empresa
//
// Regras que NÃO são lista de camadas e continuam no código do núcleo: escopo por empresa (usuário só vê as empresas
// liberadas), reautenticação de 5 minutos e a senha pedida para excluir empresa.
// Mudou a tabela? Rode `npm test` (tests/permissoes.test.js guarda a matriz esperada) e atualize docs/usuarios-e-camadas.md.

const TODOS_DO_PAINEL = ['equipe', 'admin', 'superadmin', 'cliente', 'integracao'];
const DE_ADMIN_PARA_CIMA = ['admin', 'superadmin', 'cliente', 'integracao'];
const SO_SUPERADMIN = ['superadmin', 'integracao'];

export const PERMISSOES = Object.freeze({
  // Operar o painel: reservas, mesas, agente, conhecimento, ambientes.
  'painel.usar': TODOS_DO_PAINEL,
  // Histórico de alterações e desfazer (a equipe não vê).
  'historico.ver': DE_ADMIN_PARA_CIMA,
  'historico.desfazer': DE_ADMIN_PARA_CIMA,
  // Resumo das empresas excluídas.
  'historico.excluidas': ['superadmin', 'integracao', 'cliente'],
  // Criar empresa nova.
  'empresa.criar': ['superadmin', 'integracao', 'cliente'],
  // Excluir empresa (ainda exige a senha própria do usuário; token do env usa CHATFLOW_ADMIN_SENHA).
  'empresa.excluir': DE_ADMIN_PARA_CIMA,
  // Aba API: gerar, ver e revogar a chave `k1_…` de uma empresa.
  'api.gerir': SO_SUPERADMIN,
  // Aba Usuários: criar usuários, trocar camada, ativar/desativar, redefinir senha.
  'usuarios.gerir': SO_SUPERADMIN,
  // Ver todas as empresas, sem precisar de liberação por empresa.
  'empresas.todas': SO_SUPERADMIN,
  // Abrir Configuração (renomear empresa, módulos) sem digitar a senha de novo.
  'configuracao.sem-senha': SO_SUPERADMIN,
});

export function podeFazer(papel, acao) {
  const lista = PERMISSOES[acao];
  if (!lista) throw new Error(`ação de permissão desconhecida: ${acao}`);
  return lista.includes(papel);
}
