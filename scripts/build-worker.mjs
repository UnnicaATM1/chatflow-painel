import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { empacotarMigracoes } from './worker-migrations.mjs';

const raiz = new URL('../', import.meta.url);
const tipos = {
  css: 'text/css; charset=utf-8',
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  png: 'image/png',
};

async function listarAssets(dir, prefixo = '') {
  const nomes = [];
  for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const nome = prefixo + item.name;
    if (item.isDirectory()) {
      nomes.push(...await listarAssets(new URL(nome + '/', new URL('web/', raiz)), nome + '/'));
    } else if (item.isFile()) {
      const tipo = tipos[nome.split('.').at(-1)];
      if (!tipo) throw new Error(`Tipo de asset do painel desconhecido: ${nome}`);
      nomes.push([nome, { tipo, bytes: (await readFile(new URL(nome, new URL('web/', raiz)))).toString('base64') }]);
    }
  }
  return nomes;
}

export async function buildWorker(entrada, saida) {
  await build({
    entryPoints: [fileURLToPath(new URL(entrada, raiz))],
    outfile: fileURLToPath(new URL(saida, raiz)),
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    plugins: [{
      name: 'painel',
      setup(builder) {
        builder.onResolve({ filter: /^chatflow:assets$/ }, ({ path }) => ({ path, namespace: 'painel' }));
        builder.onLoad({ filter: /.*/, namespace: 'painel' }, async () => {
          const assets = await listarAssets(new URL('web/', raiz));
          return {
            contents: `export default new Map(${JSON.stringify(assets)}.map(([nome, asset]) => [
              nome, { tipo: asset.tipo, bytes: Uint8Array.from(atob(asset.bytes), c => c.charCodeAt(0)) }
            ]));`,
          };
        });
      },
    }],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildWorker('worker/index.js', 'dist/server/index.js');
  await mkdir(new URL('dist/.openai/', raiz), { recursive: true });
  await copyFile(new URL('.openai/hosting.json', raiz), new URL('dist/.openai/hosting.json', raiz));
  await empacotarMigracoes(
    new URL('src/d1/migrations/', raiz),
    new URL('dist/.openai/drizzle/', raiz),
  );
  const codigo = await readFile(new URL('dist/server/index.js', raiz));
  const artefato = await import('data:text/javascript;base64,' + codigo.toString('base64'));
  if (typeof artefato.default?.fetch !== 'function') throw new Error('O Worker deve exportar default.fetch');
}
