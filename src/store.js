// Ponto de entrada do armazenamento. Hoje: repositório em memória (src/repositorio.js).
import { criarRepositorioMemoria } from './repositorio.js';

// opcoes: { plat, sink } (ver criarRepositorioMemoria)
export function criarStore(opcoes) {
  return criarRepositorioMemoria(opcoes);
}

// modulos: quais recursos a empresa usa (nem todo negócio tem mesas). Padrão: tudo ligado.
export async function addEmpresa(store, dados) {
  return store.empresaCriar(dados);
}
