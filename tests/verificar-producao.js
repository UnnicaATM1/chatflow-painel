'use strict';

const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { mkdtemp, rm, stat } = require('node:fs/promises');
const net = require('node:net');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { setTimeout: esperar } = require('node:timers/promises');

const raiz = path.join(__dirname, '..');
const origemPermitida = 'https://painel.example';
let etapa = 'inicialização';

async function portaLivre() {
  for (let porta = 3900; porta <= 3999; porta++) {
    const disponivel = await new Promise((resolve) => {
      const sonda = net.createServer();
      sonda.once('error', () => resolve(false));
      sonda.listen(porta, '127.0.0.1', () => sonda.close(() => resolve(true)));
    });
    if (disponivel) return porta;
  }
  throw new Error('sem porta livre');
}

async function aguardarServidor(filho) {
  for (let i = 0; i < 200; i++) {
    if (filho.encerrado) throw new Error('servidor encerrou');
    if (filho.pronto) return;
    await esperar(50);
  }
  throw new Error('tempo de inicialização excedido');
}

function iniciar(porta, env) {
  const processo = spawn(process.execPath, ['src/server.js'], {
    cwd: raiz, env: { ...env, PORT: String(porta) }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const filho = { processo, pronto: false, encerrado: false };
  let stdout = '';
  processo.stdout.setEncoding('utf8');
  processo.stdout.on('data', (parte) => {
    stdout = (stdout + parte).slice(-1024);
    filho.pronto ||= stdout.includes(`API na porta ${porta}\n`) || stdout.includes(`API na porta ${porta}\r\n`);
  });
  processo.once('error', () => { filho.encerrado = true; });
  processo.once('exit', () => { filho.encerrado = true; });
  return filho;
}

async function parar(filho) {
  if (!filho || filho.encerrado) return;
  const fim = once(filho.processo, 'exit', { signal: AbortSignal.timeout(5000) });
  filho.processo.kill();
  await fim;
}

function conferir(condicao) {
  if (!condicao) throw new Error('verificação falhou');
}

async function verificar() {
  etapa = 'pasta temporária';
  const pasta = await mkdtemp(path.join(tmpdir(), 'chatflow-producao-'));
  let filho;
  try {
    const arquivo = path.join(pasta, 'verificacao.sqlite');
    const chave = randomBytes(32).toString('base64url');
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([nome]) =>
        /^(PATH|SystemRoot|TEMP|TMP|TMPDIR)$/i.test(nome))),
      CHATFLOW_BANCO: 'sqlite',
      CHATFLOW_BANCO_ARQUIVO: arquivo,
      CHATFLOW_TOKEN_INTEGRACAO: chave,
      CHATFLOW_TOKEN_CLIENTE: randomBytes(32).toString('base64url'),
      CHATFLOW_ADMIN_SENHA: randomBytes(32).toString('base64url'),
      CHATFLOW_CORS_ORIGENS: origemPermitida,
    };
    const porta = await portaLivre();
    async function chamar(rotulo, rota, status, { token, origem, corpo, metodo = 'GET' } = {}) {
      etapa = rotulo;
      const headers = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      if (origem) headers.Origin = origem;
      if (corpo) headers['Content-Type'] = 'application/json';
      if (metodo === 'OPTIONS') {
        headers['Access-Control-Request-Method'] = 'GET';
        headers['Access-Control-Request-Headers'] = 'Authorization';
      }
      const resposta = await fetch(`http://127.0.0.1:${porta}${rota}`, {
        method: metodo, headers, body: corpo && JSON.stringify(corpo),
        signal: AbortSignal.timeout(3000),
      });
      console.log(`${rotulo} HTTP ${resposta.status}`);
      conferir(resposta.status === status);
      const texto = await resposta.text();
      return { headers: resposta.headers, dados: texto ? JSON.parse(texto) : null };
    }

    etapa = 'início do servidor SQLite';
    filho = iniciar(porta, env);
    await aguardarServidor(filho);
    conferir((await stat(arquivo)).isFile());
    const saude = await chamar('/saude', '/saude', 200);
    conferir(saude.dados?.ok === true && Object.keys(saude.dados).length === 1);
    await chamar('/empresas sem chave', '/empresas', 401);
    await chamar('/empresas chave de demonstração', '/empresas', 401, { token: 'demo-integracao' });
    const vazia = await chamar('/empresas banco novo', '/empresas', 200, { token: chave });
    conferir(Array.isArray(vazia.dados) && vazia.dados.length === 0);

    for (const origem of [origemPermitida, 'https://painel.example.invalid']) {
      const permitida = origem === origemPermitida;
      const esperado = permitida ? origem : null;
      const rotulo = permitida ? 'origem permitida' : 'origem negada';
      const get = await chamar(`CORS ${rotulo}`, '/empresas', 200, { token: chave, origem });
      const preflight = await chamar(`OPTIONS ${rotulo}`, '/empresas', 204, { origem, metodo: 'OPTIONS' });
      for (const { headers } of [get, preflight]) {
        conferir(headers.get('access-control-allow-origin') === esperado);
        conferir(headers.get('access-control-allow-credentials') === null);
      }
    }

    const nome = 'Empresa da verificação SQLite';
    const criada = await chamar('POST /empresas', '/empresas', 201, {
      token: chave, metodo: 'POST', corpo: { nome },
    });
    conferir(typeof criada.dados?.id === 'string' && criada.dados.nome === nome);
    etapa = 'reinício do servidor SQLite';
    await parar(filho);
    filho = iniciar(porta, env);
    await aguardarServidor(filho);
    const apos = await chamar('/empresas após reinício', '/empresas', 200, { token: chave });
    conferir(Array.isArray(apos.dados) && apos.dados.length === 1
      && apos.dados[0].id === criada.dados.id && apos.dados[0].nome === nome);
  } finally {
    await parar(filho);
    // Pasta exclusiva criada por mkdtemp diretamente no diretório temporário.
    if (path.dirname(path.resolve(pasta)) === path.resolve(tmpdir())) {
      await rm(pasta, { recursive: true, force: true, maxRetries: 4 });
    }
  }
}

verificar().then(() => console.log('RESULTADO ok')).catch(() => {
  console.error(`RESULTADO falha na etapa ${etapa}`);
  process.exitCode = 1;
});
