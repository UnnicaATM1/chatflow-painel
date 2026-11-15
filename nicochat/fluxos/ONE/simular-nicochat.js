'use strict';

// Simula o fluxo ONE do NicoChat contra a API do ONE, sem precisar do NicoChat.
//
// Uso:
//   node nicochat/fluxos/ONE/simular-nicochat.js --url http://127.0.0.1:3456 --empresa empresa_1 --chave k1_... \
//        [--mensagem "#one quero reservar mesa para 2"] [--reservar]
//
// Sem --reservar nada é gravado (só leituras). Com --reservar, registra UMA reserva de teste
// (amanhã às 20:00, 2 pessoas) e reenvia a mesma chave de idempotência para provar que não duplica.
// A chave da empresa não pode cancelar: a reserva de teste fica no ONE até a equipe cancelar no Workspace.

const args = process.argv.slice(2);
const opt = (nome, padrao) => { const i = args.indexOf(`--${nome}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : padrao; };
const url = opt('url', 'http://127.0.0.1:3456').replace(/\/$/, '');
const empresa = opt('empresa');
const chave = opt('chave');
const mensagem = opt('mensagem', '#one oi, quero reservar uma mesa');
const reservar = args.includes('--reservar');

const argsOk = !!empresa && !!chave;
if (!argsOk) {
  console.error('Informe --empresa e --chave. Exemplo: node simular-nicochat.js --empresa empresa_1 --chave k1_...');
  process.exitCode = 2;
}

let falhas = 0;
const ok = (cond, texto, detalhe = '') => { console.log(`${cond ? '  OK ' : ' ERRO'} ${texto}${detalhe ? ' - ' + detalhe : ''}`); if (!cond) falhas++; return cond; };

async function funcao(metodo, caminho, corpo, extra = {}) {
  const r = await fetch(url + caminho, {
    method: metodo,
    headers: { Authorization: `Bearer ${chave}`, ...(corpo ? { 'Content-Type': 'application/json' } : {}), ...extra },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const txt = await r.text();
  let json = null;
  try { json = JSON.parse(txt); } catch { /* resposta não JSON */ }
  return { status: r.status, json };
}

(async () => {
  if (!argsOk) return;
  console.log(`Mensagem recebida: "${mensagem}"`);
  if (!mensagem.trim().toLowerCase().startsWith('#one')) {
    console.log('Gatilho #one não acionado: o NicoChat ignora esta mensagem.');
    return;
  }
  const textoCliente = mensagem.trim().slice(4).trim();
  console.log(`Gatilho #one acionado. Texto do cliente: "${textoCliente || '(vazio: usar saudação padrão)'}"\n`);

  console.log('Passo 1: função one_contexto');
  const ctx = await funcao('GET', `/empresas/${empresa}/contexto`);
  if (!ok(ctx.status === 200 && ctx.json && ctx.json.prompt, 'contexto recebido', `HTTP ${ctx.status}`)) { process.exitCode = 1; return; }
  const c = ctx.json;
  console.log(`       agente: "${c.agente.nome || '(sem nome)'}" da empresa "${c.empresa.nome}"`);
  console.log(`       recursos: reservas=${c.recursos.reservas}, conhecimento=${c.recursos.conhecimento} (${c.conhecimento.length} item(ns))`);
  console.log(`       prompt de sistema: ${c.prompt.length} caracteres`);
  console.log('       ---- início do prompt ----');
  console.log(c.prompt.split('\n').slice(0, 8).map((l) => '       ' + l).join('\n'));
  console.log('       --------------------------\n');

  console.log('Passo 2: a IA do NicoChat responde usando o prompt acima.');
  console.log('       (aqui o NicoChat chama a IA; este simulador não gera a resposta)\n');

  if (!c.recursos.reservas) {
    console.log('Esta empresa não usa reservas: fluxo de mesas não se aplica.');
  } else {
    console.log('Passo 3: função one_disponibilidade (amanhã, 20:00, 2 pessoas)');
    const amanha = new Date(Date.now() + 86400000);
    const data = `${amanha.getFullYear()}-${String(amanha.getMonth() + 1).padStart(2, '0')}-${String(amanha.getDate()).padStart(2, '0')}`;
    const d = await funcao('GET', `/empresas/${empresa}/disponibilidade?data=${data}&horario=20:00&pessoas=2`);
    ok(d.status === 200 && d.json && Array.isArray(d.json.ambientes), 'disponibilidade recebida', `HTTP ${d.status}`);
    const livres = (d.json && d.json.ambientes ? d.json.ambientes : []).flatMap((a) => a.mesas.map((m) => ({ ...m, ambiente: a.ambiente })));
    console.log(`       mesas livres: ${livres.length ? livres.map((m) => `${m.id} (${m.ambiente}, ${m.capacidade} lugares)`).join(', ') : 'nenhuma'}`);

    if (!reservar) {
      console.log('\nPasso 4: one_reservar NÃO executado (use --reservar para registrar uma reserva de teste).');
    } else if (!livres.length) {
      ok(false, 'não há mesa livre para o teste de reserva');
    } else {
      console.log('\nPasso 4: função one_reservar (reserva de teste)');
      const mesa = livres[0];
      const idem = `simulador-${Date.now()}`;
      const corpo = { data, horario: '20:00', pessoas: 2, mesaId: mesa.id };
      const r1 = await funcao('POST', `/empresas/${empresa}/reservas`, corpo, { 'Idempotency-Key': idem });
      ok(r1.status === 201 && r1.json.status === 'confirmada', 'reserva confirmada', `mesa ${r1.json && r1.json.mesa}`);
      const r2 = await funcao('POST', `/empresas/${empresa}/reservas`, corpo, { 'Idempotency-Key': idem });
      ok(r2.json && r1.json && r2.json.reservaId === r1.json.reservaId, 'reenvio com a mesma chave não duplicou', `reserva ${r2.json && r2.json.reservaId}`);
      const r3 = await funcao('POST', `/empresas/${empresa}/reservas`, corpo, { 'Idempotency-Key': idem + '-outra' });
      ok(r3.json && r3.json.status === 'indisponivel', 'mesa ocupada devolve "indisponivel" com alternativas', `${r3.json && r3.json.disponibilidade ? 'alternativas recebidas' : 'sem alternativas'}`);
      console.log('       (a reserva de teste fica no ONE; cancele na aba Workspace se quiser limpar)');
    }
  }

  console.log('\nTeste de isolamento');
  const outra = await funcao('GET', '/empresas/empresa_inexistente/contexto');
  ok(outra.status === 403 || outra.status === 404, 'a chave não acessa outra empresa', `HTTP ${outra.status}`);

  console.log(falhas ? `\n${falhas} verificação(ões) falharam.` : '\nTudo certo: a comunicação NicoChat <-> ONE está funcionando.');
  process.exitCode = falhas ? 1 : 0;
})().catch((e) => { console.error('Erro de comunicação:', e.message); process.exitCode = 1; });
