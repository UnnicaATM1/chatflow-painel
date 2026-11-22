import { abrirStoreWorker, criarWorker } from '../../worker/index.js';
import { addEmpresa } from '../../src/store.js';

export default criarWorker(async (env) => {
  const store = abrirStoreWorker(env);
  const semente = JSON.parse(env.TEST_SEMENTE);
  for (const empresa of semente) await addEmpresa(store, empresa);

  if (semente.some((empresa) => empresa.id === 'empresa_1')) {
    const hash = await store.plat.sha256Hex(env.TEST_CHAVE_EMPRESA);
    await store.chaveDefinir('empresa_1', {
      hash,
      prefixo: env.TEST_CHAVE_EMPRESA,
      criadaEm: new Date(store.plat.agora()).toISOString(),
    });
  }
  return store;
});
