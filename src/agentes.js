// Campos do agente (todos texto livre) e limite de caracteres de cada um.
const LIMITES = {
  nome: 100, // Nome do agente
  descricao: 1000,
  personalidade: 2000, // Personalidade e Objetivo da IA
  habilidades: 22000,
  produtos: 22000, // Informações sobre Produtos e Serviços
  restricoes: 2000,
};
const CAMPOS = Object.keys(LIMITES);

function erro(msg, codigo) {
  return Object.assign(new Error(msg), { codigo });
}

// Registro da empresa (somente leitura) ou 404.
export async function empresa(store, id) {
  const l = await store.empresaObter(id);
  if (!l) throw erro('empresa inexistente', 404);
  return l;
}

// Leitura somente leitura: devolve o bloco inteiro da empresa, sempre com os campos.
export async function lerConfig(store, empresaId) {
  const a = (await empresa(store, empresaId)).agente;
  const out = {};
  for (const c of CAMPOS) out[c] = typeof a[c] === 'string' ? a[c] : '';
  return out;
}

function tamanho(texto) {
  return [...texto].length; // caracteres reais (não quebra emoji ao meio)
}

function checar(a, campo, valor, papel) {
  if (!CAMPOS.includes(campo)) throw erro(`campo inválido: ${campo}`, 400);
  // agente.editavelPor: { campo: ['cliente', 'integracao'] }; padrão: só integração.
  const permitidos = (a.editavelPor && a.editavelPor[campo]) || ['integracao'];
  if (!permitidos.includes(papel)) throw erro(`sem permissão para editar ${campo}`, 403);
  if (typeof valor !== 'string') throw erro(`${campo} deve ser texto`, 400);
  if (tamanho(valor) > LIMITES[campo]) throw erro(`${campo} passa do limite de ${LIMITES[campo]} caracteres`, 400);
}

// Salva vários campos de uma vez, tudo ou nada: se um falhar, nenhum é gravado.
export async function atualizarVarios(store, empresaId, mudancas, papel) {
  const a = (await empresa(store, empresaId)).agente;
  const campos = Object.keys(mudancas || {});
  if (campos.length === 0) throw erro('nenhum campo informado', 400);
  for (const c of campos) checar(a, c, mudancas[c], papel);
  await store.agenteAtualizar(empresaId, Object.fromEntries(campos.map((c) => [c, mudancas[c]])));
}

export async function atualizar(store, empresaId, campo, valor, papel) {
  return atualizarVarios(store, empresaId, { [campo]: valor }, papel);
}

export { LIMITES };
