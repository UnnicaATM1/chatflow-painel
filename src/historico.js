// Histórico de modificações: só acrescenta (append-only). Não existe função para alterar ou apagar eventos.
// Cada evento registra quem (papel do token + operador informado), quando, o quê e antes/depois.
// A gravação em si (e o sink de auditoria) é do repositório.

export async function registrar(store, ev) {
  return store.historicoAcrescentar(ev);
}

// Só os campos que mudaram, com valor antes e depois.
export function diff(antes, depois) {
  const a = {}, d = {};
  for (const k of new Set([...Object.keys(antes || {}), ...Object.keys(depois || {})])) {
    if (JSON.stringify((antes || {})[k]) !== JSON.stringify((depois || {})[k])) { a[k] = (antes || {})[k]; d[k] = (depois || {})[k]; }
  }
  return { antes: a, depois: d };
}

export async function listar(store, empresaId, filtros) {
  return store.historicoListar(empresaId, filtros);
}
