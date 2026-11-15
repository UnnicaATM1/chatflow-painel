// Prova de que o one-core (API do ONE em Rust) roda em WebAssembly: carrega o .wasm no Node e chama `prova()`,
// que exercita a API de ponta a ponta dentro do módulo. Não faz parte do npm test (precisa do alvo wasm32).
//
//   cd rust && rustup target add wasm32-unknown-unknown && cargo build -p one-wasm-prova --target wasm32-unknown-unknown --release
//   node tests/wasm-prova.js        (ou ONE_WASM=caminho/do/arquivo.wasm)
//
// Sai com código 0 quando prova() devolve 0; senão, mostra o número da verificação que falhou.
const fs = require('node:fs');
const path = require('node:path');

const arq = process.env.ONE_WASM || path.join(__dirname, '..', 'rust', 'target', 'wasm32-unknown-unknown', 'release', 'one_wasm_prova.wasm');

(async () => {
  const bytes = fs.readFileSync(arq);
  const modulo = await WebAssembly.compile(bytes);
  const importados = WebAssembly.Module.imports(modulo);
  const instance = await WebAssembly.instantiate(modulo, {});
  const r = instance.exports.prova();
  console.log(`one_wasm_prova.wasm: ${bytes.length} bytes, ${importados.length} importações do ambiente (${importados.map((i) => `${i.module}.${i.name}`).join(', ') || 'nenhuma'})`);
  console.log(r === 0 ? 'prova() = 0: a API inteira rodou e respondeu como esperado dentro do WebAssembly' : `prova() = ${r}: a verificação ${r} falhou`);
  process.exitCode = r === 0 ? 0 : 1;
})().catch((e) => { console.error('falha ao rodar o wasm:', e.message); process.exitCode = 1; });
