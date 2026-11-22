'use strict';

const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { Miniflare } = require('miniflare');
const { criarStoreD1 } = require('../../src/d1/repositorio');

const pasta = join(__dirname, '../../src/d1/migrations');

function instrucoes(sql) {
  const comandos = [];
  let linhas = [];
  for (const linha of sql.split(/\r?\n/)) {
    if (!linha.trim() || linha.trimStart().startsWith('--')) continue;
    linhas.push(linha);
    const gatilho = linhas[0].startsWith('CREATE TRIGGER');
    if (gatilho ? linha === 'END;' : linha.trimEnd().endsWith(';')) {
      comandos.push(linhas.join('\n'));
      linhas = [];
    }
  }
  if (linhas.length) throw new Error('instrução de migração sem terminador');
  return comandos;
}

async function abrirD1(t, opcoesMiniflare = {}, migrar = true) {
  const runtime = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response(null); } };',
    compatibilityDate: '2025-01-01',
    d1Databases: { DB: 'chatflow' },
    r2Buckets: { BUCKET: 'chatflow-anexos' },
    ...opcoesMiniflare,
  });
  let fechamento;
  const fechar = () => fechamento ??= runtime.dispose();
  t.after(fechar);
  const { DB, BUCKET } = await runtime.getBindings();
  if (migrar) {
    for (const arquivo of readdirSync(pasta).sort()) {
      const sql = readFileSync(join(pasta, arquivo), 'utf8');
      await DB.batch(instrucoes(sql).map((comando) => DB.prepare(comando)));
    }
  }
  return { DB, BUCKET, fechar, abrir: (opcoes) => criarStoreD1({ DB, BUCKET }, opcoes) };
}

module.exports = { abrirD1 };
