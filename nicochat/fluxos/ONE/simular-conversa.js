'use strict';

// Simula uma CONVERSA inteira do NicoChat com o ONE, sem precisar do NicoChat:
//   1) toda conversa nova começa buscando o contexto do agente no ONE (one_contexto);
//   2) perguntas sobre preço, horário ou regras acionam a busca de conhecimento (one_buscar_conhecimento);
//   3) pedidos de mesa acionam a disponibilidade (one_disponibilidade) e depois a reserva (one_reservar).
// A parte que a IA do NicoChat faz (entender a frase) aqui é por palavras-chave, só para testar a comunicação.
//
// Uso:
//   node nicochat/fluxos/ONE/simular-conversa.js --empresa empresa_1 --chave k1_... \
//        [--url http://127.0.0.1:3456] [--nome "Carlos Lima"] [--contato "+55 11 90000-0000"] [--reservar] \
//        [--fala "quanto custa a lasanha?"]...   (várias falas; sem --fala roda uma conversa de exemplo)
//
// Sem --reservar a reserva NÃO é gravada (mostra o que seria enviado). Com --reservar grava uma reserva real.

const args = process.argv.slice(2);
const opt = (n, p) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : p; };
const falas = args.flatMap((a, i) => (a === '--fala' && args[i + 1] ? [args[i + 1]] : []));
const url = opt('url', 'http://127.0.0.1:3456').replace(/\/$/, '');
const empresa = opt('empresa');
const chave = opt('chave');
const nomeCliente = opt('nome', 'Cliente de teste');
const contato = opt('contato', '+55 11 90000-0000');
const gravar = args.includes('--reservar');

const EXEMPLO = ['oi, boa noite', 'quanto custa a lasanha?', 'vocês aceitam cheque?', 'quero reservar uma mesa para 2 amanhã às 20h', 'pode ser a mesa S1', 'confirmo'];

let falhas = 0;
const ok = (cond, texto) => { if (!cond) { falhas++; console.log(`      ERRO: ${texto}`); } return cond; };

async function chamar(metodo, caminho, corpo, extra = {}) {
  const r = await fetch(url + caminho, {
    method: metodo,
    headers: { Authorization: `Bearer ${chave}`, ...(corpo ? { 'Content-Type': 'application/json' } : {}), ...extra },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* sem corpo JSON */ }
  return { status: r.status, json };
}
const funcao = (nome, detalhe) => console.log(`      -> função ${nome}${detalhe ? ' ' + detalhe : ''}`);
const agente = (texto) => console.log(`  Agente: ${texto}`);

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const dia = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const br = (iso) => iso.split('-').reverse().join('/');

function lerPedido(msg, estado) {
  const n = norm(msg);
  let m = /(\d+)\s*(pessoas?|lugares)/.exec(n) || /para\s+(\d+)/.exec(n);
  if (m) estado.pessoas = Number(m[1]);
  if (/amanha/.test(n)) estado.data = dia(new Date(Date.now() + 86400000));
  else if (/hoje/.test(n)) estado.data = dia(new Date());
  else if ((m = /(\d{1,2})\/(\d{1,2})/.exec(n))) estado.data = `${new Date().getFullYear()}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if ((m = /(\d{1,2})\s*h(?:\s*(\d{2}))?/.exec(n)) || (m = /(\d{1,2}):(\d{2})/.exec(n))) estado.horario = `${m[1].padStart(2, '0')}:${m[2] || '00'}`;
}

function respostaConhecimento(b) {
  if (b.total === 0) return 'Não encontrei essa informação aqui. Vou confirmar com a equipe e já te respondo.';
  if (b.catalogo) return `Tenho informações sobre: ${b.resultados.map((r) => r.titulo).join(', ')}. O que você quer saber?`;
  const partes = [];
  for (const r of b.resultados.slice(0, 2)) {
    if (r.tipo === 'tabela') partes.push(r.linhas.map((l) => l.map((c, i) => (i === 0 ? c : `${r.colunas[i]}: ${c}`)).join(', ')).join('. ') + '.');
    else if (r.trechos) partes.push(r.trechos.join(' '));
    else partes.push(`Tenho o documento "${r.titulo}" (${r.arquivo.nome}).`);
  }
  return partes.join(' ');
}

(async () => {
  if (!empresa || !chave) { console.error('Informe --empresa e --chave.'); process.exitCode = 2; return; }
  const roteiro = falas.length ? falas : EXEMPLO;
  const estado = { pessoas: null, data: null, horario: null, oferta: null, mesa: null, emReserva: false };

  console.log(`Nova conversa iniciada por ${nomeCliente} (${contato}).`);
  funcao('one_contexto', '(toda conversa nova começa aqui)');
  const ctx = await chamar('GET', `/empresas/${empresa}/contexto`);
  if (!ok(ctx.status === 200 && ctx.json && ctx.json.prompt, `contexto falhou (HTTP ${ctx.status})`)) { process.exitCode = 1; return; }
  const c = ctx.json;
  console.log(`         recebido: agente "${c.agente.nome || 'sem nome'}", empresa "${c.empresa.nome}", reservas=${c.recursos.reservas}, conhecimento=${c.conhecimento.length} item(ns), prompt de ${c.prompt.length} caracteres\n`);

  for (const msg of roteiro) {
    console.log(`  Cliente: ${msg}`);
    const n = norm(msg);

    const querReserva = /reserv|mesa/.test(n) || (estado.emReserva && (estado.oferta || /\d|amanha|hoje|confirm|sim|pode/.test(n)));
    if (c.recursos.reservas && querReserva) {
      estado.emReserva = true;
      lerPedido(msg, estado);
      const mesaDita = /mesa\s*([a-z]\d+)/.exec(n);
      if (estado.oferta && (mesaDita || /confirm|pode ser|fechado|^sim/.test(n))) {
        const livres = estado.oferta;
        const escolhida = mesaDita ? livres.find((m) => m.id.toLowerCase() === mesaDita[1]) : livres[0];
        if (!escolhida) { agente(`Essa mesa não está livre. As livres são: ${livres.map((m) => m.id).join(', ')}.`); continue; }
        estado.mesa = escolhida;
        if (!/confirm|sim|fechado/.test(n)) { agente(`Ótimo, mesa ${escolhida.id} (${escolhida.ambiente}, ${escolhida.capacidade} lugares) para ${estado.pessoas} pessoas, ${br(estado.data)} às ${estado.horario}. Posso confirmar?`); continue; }
        const corpo = { data: estado.data, horario: estado.horario, pessoas: estado.pessoas, mesaId: escolhida.id, nomeCliente, contato };
        funcao('one_reservar', JSON.stringify(corpo));
        if (!gravar) { agente(`(simulação) Eu registraria a reserva da mesa ${escolhida.id} em nome de ${nomeCliente}. Use --reservar para gravar de verdade.`); estado.oferta = null; continue; }
        const idem = `simulador-conversa-${Date.now()}`;
        const r = await chamar('POST', `/empresas/${empresa}/reservas`, corpo, { 'Idempotency-Key': idem });
        const rr = await chamar('POST', `/empresas/${empresa}/reservas`, corpo, { 'Idempotency-Key': idem });
        ok(rr.json && r.json && rr.json.reservaId === r.json.reservaId, 'o reenvio duplicou a reserva');
        if (r.status === 201 && r.json.status === 'confirmada') agente(`Reserva confirmada! Mesa ${r.json.mesa} (${r.json.ambiente}), ${estado.pessoas} pessoas, ${br(estado.data)} às ${estado.horario}, em nome de ${nomeCliente}.`);
        else { ok(false, `reserva não confirmada (HTTP ${r.status})`); agente('Essa mesa acabou de ser ocupada. Quer escolher outra?'); }
        estado.oferta = null; estado.emReserva = false;
        continue;
      }
      const faltam = ['pessoas', 'data', 'horario'].filter((k) => !estado[k]);
      if (faltam.length) { agente(`Para reservar preciso de: ${faltam.map((k) => ({ pessoas: 'número de pessoas', data: 'data', horario: 'horário' }[k])).join(', ')}.`); continue; }
      funcao('one_disponibilidade', `(${estado.data}, ${estado.horario}, ${estado.pessoas} pessoas)`);
      const d = await chamar('GET', `/empresas/${empresa}/disponibilidade?data=${estado.data}&horario=${estado.horario}&pessoas=${estado.pessoas}`);
      if (!ok(d.status === 200, `disponibilidade falhou (HTTP ${d.status})`)) continue;
      const livres = d.json.ambientes.flatMap((a) => a.mesas.map((m) => ({ ...m, ambiente: a.ambiente })));
      estado.oferta = livres;
      if (!livres.length) { agente('Nesse horário não temos mesa livre para esse número de pessoas. Quer tentar outro horário?'); continue; }
      agente(`Tenho mesa ${br(estado.data)} às ${estado.horario}: ${d.json.ambientes.filter((a) => a.mesas.length).map((a) => `${a.ambiente} (${a.mesas.map((m) => `${m.id}, ${m.capacidade} lugares`).join('; ')})`).join(' e ')}. Qual você prefere?`);
      continue;
    }

    if (c.recursos.conhecimento && /preco|valor|quanto|custa|cardapio|horario|abre|fecha|funciona|aceita|cheque|pix|cartao|regra|animal|crianca|tolerancia|vinho|prato|servico/.test(n)) {
      funcao('one_buscar_conhecimento', `q="${msg}"`);
      const b = await chamar('GET', `/empresas/${empresa}/conhecimento/buscar?q=${encodeURIComponent(msg)}`);
      if (!ok(b.status === 200, `busca falhou (HTTP ${b.status})`)) continue;
      agente(respostaConhecimento(b.json));
      continue;
    }

    agente(`Olá! Eu sou ${c.agente.nome || 'o assistente'}, da ${c.empresa.nome}. Como posso ajudar?`);
  }

  console.log(falhas ? `\n${falhas} problema(s) na comunicação.` : '\nConversa concluída: a comunicação NicoChat <-> ONE funcionou do início ao fim.');
  process.exitCode = falhas ? 1 : 0;
})().catch((e) => { console.error('Erro de comunicação:', e.message); process.exitCode = 1; });
