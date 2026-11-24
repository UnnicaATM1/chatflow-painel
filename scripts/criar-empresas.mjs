// Cria as 3 empresas do Grupo Beto Cunha e gera a chave de API de cada uma.
// Uso (PowerShell):  $env:CHATFLOW_CHAVE_INTEGRACAO = Read-Host "chave"; node scripts/criar-empresas.mjs
// A chave de integração vem do ambiente (nunca fica em arquivo). As chaves das empresas vão para um .env FORA do repositório e não são impressas.
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const base = (process.env.CHATFLOW_URL || 'https://chatflow-painel.joaolopes.chatgpt.site').replace(/\/$/, '');
const token = process.env.CHATFLOW_CHAVE_INTEGRACAO;
if (!token) { console.error('Defina CHATFLOW_CHAVE_INTEGRACAO (chave com nível de integração).'); process.exit(1); }
const EMPRESAS = ['PARK FOZ', 'BOUTIQUE DE CARNES BETO CUNHA', 'BLACK BILL SMOKERHOUSE'];
const pasta = join(homedir(), 'Documents', 'chatflow-chaves');
const arq = join(pasta, 'chaves-empresas.env');

async function api(metodo, caminho, corpo) {
  const r = await fetch(base + caminho, { method: metodo, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: corpo ? JSON.stringify(corpo) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, corpo: j };
}

const lista = await api('GET', '/empresas');
if (lista.status !== 200) { console.error('GET /empresas falhou:', lista.status, lista.corpo && lista.corpo.erro); process.exit(1); }
const existentes = Array.isArray(lista.corpo) ? lista.corpo : (lista.corpo.empresas || []);
mkdirSync(pasta, { recursive: true });
let saida = existsSync(arq) ? readFileSync(arq, 'utf8') : '# Chaves de API por empresa (segredo, fora do repositório)\n';
for (const nome of EMPRESAS) {
  let emp = existentes.find((e) => e.nome === nome);
  if (!emp) {
    const c = await api('POST', '/empresas', { nome });
    if (c.status !== 201 && c.status !== 200) { console.error('Criar', nome, 'falhou:', c.status, c.corpo && c.corpo.erro); continue; }
    emp = c.corpo;
    console.log('criada:', nome, '->', emp.id);
  } else console.log('já existia:', nome, '->', emp.id);
  const rotulo = 'CHATFLOW_CHAVE_' + emp.id.toUpperCase();
  if (saida.includes(rotulo + '=')) { console.log('  chave já guardada, não gerei outra'); continue; }
  const k = await api('POST', `/empresas/${emp.id}/api/chave`);
  if (k.status !== 201) { console.error('  gerar chave falhou:', k.status, k.corpo && k.corpo.erro); continue; }
  saida += `# ${nome}\n${rotulo}=${k.corpo.chave}\n`;
  writeFileSync(arq, saida);
  console.log('  chave gerada e guardada (prefixo ' + k.corpo.prefixo + ')');
}
console.log('Arquivo das chaves:', arq);
