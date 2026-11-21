'use strict';

// Uso: CHATFLOW_DEMO=1 CHATFLOW_TOKEN_CHAT=... CHATFLOW_TOKEN_CLIENTE=... CHATFLOW_TOKEN_INTEGRACAO=... node src/server.js
import { criarStore, addEmpresa } from '../store.js';
import { criarServidor } from './servidor.js';
import fs from 'node:fs';
import { plataformaNode } from './plataforma.js';
import { reservarPidSqlite } from './pid-sqlite.js';

// CHATFLOW_HISTORICO_ARQUIVO: grava uma cópia de cada evento em JSON por linha.
const arquivoHistorico = process.env.CHATFLOW_HISTORICO_ARQUIVO || null;
const sink = arquivoHistorico ? (e) => {
  try { fs.appendFileSync(arquivoHistorico, JSON.stringify(e) + '\n', 'utf8'); }
  catch (err) { console.error('falha ao gravar histórico em arquivo:', err.message); }
} : null;
// CHATFLOW_IDEMPOTENCIA_HORAS (padrão 24) e CHATFLOW_IDEMPOTENCIA_MAX (padrão 10000 por empresa): validade e teto das
// respostas de idempotência.
const opcoesStore = {
  plat: plataformaNode(),
  sink,
  fuso: process.env.CHATFLOW_FUSO,
  idempotenciaTtlMs: Number(process.env.CHATFLOW_IDEMPOTENCIA_HORAS) * 3600 * 1000 || undefined,
  idempotenciaMax: Number(process.env.CHATFLOW_IDEMPOTENCIA_MAX) || undefined,
};
const banco = process.env.CHATFLOW_BANCO || 'memoria';
if (banco !== 'memoria' && banco !== 'sqlite') throw new Error('CHATFLOW_BANCO deve ser memoria ou sqlite');
const prazoDesligamento = Number(process.env.CHATFLOW_DESLIGAR_MS || 10000);
if (banco === 'sqlite' && (!Number.isInteger(prazoDesligamento) || prazoDesligamento < 0 || prazoDesligamento > 0x7fffffff)) {
  throw new Error('CHATFLOW_DESLIGAR_MS deve ser um inteiro entre 0 e 2147483647');
}
let store;
if (banco === 'sqlite') {
  const { criarRepositorioSqlite } = await import('../sqlite/repositorio.js');
  store = criarRepositorioSqlite({
    ...opcoesStore,
    caminho: process.env.CHATFLOW_BANCO_ARQUIVO || 'chatflow.sqlite',
    reservarArquivo: reservarPidSqlite,
  });
} else {
  store = criarStore(opcoesStore);
}

async function semear() {
  // CHATFLOW_SEMENTE_ARQUIVO: empresas iniciais de teste, com reservas legadas opcionais.
  if (process.env.CHATFLOW_SEMENTE_ARQUIVO) {
    for (const e of JSON.parse(fs.readFileSync(process.env.CHATFLOW_SEMENTE_ARQUIVO, 'utf8'))) {
      if (!(await store.empresaObter(e.id, { incluirConhecimento: false }))) await addEmpresa(store, e);
    }
  }

  // Só semeia a demonstração quando habilitada, preservando empresas existentes ou já excluídas.
  const demo = process.env.CHATFLOW_DEMO === '1';
  for (const n of demo ? [1, 2, 3] : []) {
    const id = `empresa_${n}`;
    if (await store.empresaObter(id, { incluirConhecimento: false }) || (await store.historicoListar(id, { entidade: 'empresa', limite: 1 })).length) continue;
    await addEmpresa(store, {
      id,
      nome: `Empresa ${n}`,
      ambientes: [
        { nome: 'salao', mesas: [{ id: `S1`, capacidade: 4, reservavel: true }, { id: `S2`, capacidade: 6, reservavel: true }] },
        { nome: 'externa', mesas: [{ id: `E1`, capacidade: 4, reservavel: true }] },
      ],
      agente: {
        nome: `Agente da Empresa ${n}`, descricao: '', personalidade: '', habilidades: '', produtos: '', restricoes: '',
        editavelPor: Object.fromEntries(['nome', 'descricao', 'personalidade', 'habilidades', 'produtos', 'restricoes'].map((c) => [c, ['cliente', 'integracao']])),
      },
    });
  }
}

let servidor;
let fechamento;
let forcado = false;
const sinaisDeSaida = process.platform === 'win32' ? ['SIGTERM', 'SIGINT', 'SIGBREAK'] : ['SIGTERM', 'SIGINT'];

function forcarFechamento(motivo) {
  if (forcado) return;
  forcado = true;
  process.exitCode = 1;
  console.error(`Encerramento do ChatFlow Painel: ${motivo}`);
  servidor?.closeAllConnections();
}

function fechar() {
  fechamento ??= (async () => {
    let temporizador;
    try {
      if (servidor) {
        const fimHttp = new Promise((resolve) => servidor.close(resolve));
        servidor.closeIdleConnections();
        temporizador = setTimeout(() => forcarFechamento('prazo de desligamento excedido'), prazoDesligamento);
        await fimHttp;
      }
      await store.fechar?.();
    } finally {
      clearTimeout(temporizador);
      for (const sinal of sinaisDeSaida) process.removeListener(sinal, aoSinal);
      if (process.connected) process.disconnect();
    }
  })();
  return fechamento;
}

function falha(erro) {
  process.exitCode = 1;
  console.error(erro);
}

function aoSinal() {
  if (fechamento) {
    forcarFechamento('segundo sinal recebido');
    return;
  }
  fechar().catch(falha);
}
if (banco === 'sqlite') {
  for (const sinal of sinaisDeSaida) process.on(sinal, aoSinal);
  process.once('exit', () => {
    try { store.fecharNaSaida(); }
    catch (erro) { falha(erro); }
  });
}

// CHATFLOW_TOKEN_CHAT é opcional e legado: uma chave global do chat vê TODAS as empresas. Prefira a chave de API de cada empresa.
const tokens = {
  chat: process.env.CHATFLOW_TOKEN_CHAT,
  cliente: process.env.CHATFLOW_TOKEN_CLIENTE,
  integracao: process.env.CHATFLOW_TOKEN_INTEGRACAO,
};
const porta = Number(process.env.PORT) || 3000;
const opcoesServidor = {
  // CHATFLOW_ADMIN_SENHA: senha do administrador para excluir empresa. Defina só no ambiente do servidor, nunca no código.
  adminSenha: process.env.CHATFLOW_ADMIN_SENHA,
  // CHATFLOW_CORS_ORIGENS: origens do painel separadas por vírgula (lista exata). CHATFLOW_CONFIAR_PROXY=1: usar X-Forwarded-For.
  corsOrigens: (process.env.CHATFLOW_CORS_ORIGENS || '').split(','),
  confiarProxy: process.env.CHATFLOW_CONFIAR_PROXY === '1',
  // CHATFLOW_LIMITE_CHAVE / CHATFLOW_LIMITE_INVALIDAS: requisições por minuto por chave válida (padrão 300) e por IP com chave inválida (padrão 20).
  limitePorChavePorMinuto: Number(process.env.CHATFLOW_LIMITE_CHAVE) || undefined,
  limiteInvalidasPorMinuto: Number(process.env.CHATFLOW_LIMITE_INVALIDAS) || undefined,
  fuso: opcoesStore.fuso,
};

try {
  await semear();
  if (!fechamento) {
    servidor = criarServidor(store, tokens, opcoesServidor);
    servidor.once('error', (erro) => {
      falha(erro);
      fechar().catch(falha);
    });
    servidor.listen(porta, () => console.log(`ChatFlow Painel API na porta ${porta}`));
  }
} catch (erro) {
  await fechar().catch(falha);
  throw erro;
}
