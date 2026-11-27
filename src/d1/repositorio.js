import { gerarCodigoReserva, plataformaWeb } from '../plataforma.js';
import { IDEMPOTENCIA_MAX_PADRAO, IDEMPOTENCIA_TTL_PADRAO_MS } from '../repositorio.js';
import { prepararReservaSemeada } from '../reservas.js';
import { fusoDe, minutosAbsolutos, parede } from '../tempo.js';
import { operacoesUsuariosD1 } from './usuarios.js';

const MODULOS = { reservas: true, conhecimento: true };
const CONFLITO = { ok: false, motivo: 'conflito' };
const COLUNAS_RESERVA = 'codigo AS id, empresa_id AS empresaId, mesa_id AS mesaId, ambiente, data, horario, pessoas, inicio, fim, status, nome_cliente AS nomeCliente, contato';
const COLUNAS_GRAVACAO = 'id, empresa_id, codigo, mesa_id, ambiente, data, horario, pessoas, inicio, fim, status, nome_cliente, contato';
const MESA_EXISTE = `EXISTS (SELECT 1 FROM mesas m JOIN ambientes a ON a.id = m.ambiente_id
  WHERE m.empresa_id = ? AND m.mesa_id = ? AND (? IS NULL OR a.nome = ?))`;
const SEM_SOBREPOSICAO = `NOT EXISTS (SELECT 1 FROM reservas
  WHERE empresa_id = ? AND mesa_id = ? AND status = 'confirmada' AND codigo IS NOT ? AND inicio < ? AND fim > ?)`;

function lerReserva(linha) {
  if (!linha) return null;
  const { nomeCliente, contato, ...reserva } = linha;
  if (nomeCliente !== null) reserva.nomeCliente = nomeCliente;
  if (contato !== null) reserva.contato = contato;
  return reserva;
}

function congelar(objeto) {
  if (objeto && typeof objeto === 'object') {
    Object.values(objeto).forEach(congelar);
    Object.freeze(objeto);
  }
  return objeto;
}

const lerEvento = (linha) => linha ? congelar({ seq: linha.seq, ...JSON.parse(linha.evento) }) : null;
const lerMesa = ({ mesa_id, capacidade, reservavel, descricao }) => ({ id: mesa_id, capacidade, reservavel: Boolean(reservavel), ...(descricao ? { descricao } : {}) });

export function criarStoreD1(env, { plat = plataformaWeb(), sink, fuso = env.CHATFLOW_FUSO,
  idempotenciaTtlMs, idempotenciaMax } = {}) {
  const { DB: db, BUCKET: bucket } = env;
  const ttl = idempotenciaTtlMs > 0 ? Math.ceil(idempotenciaTtlMs) : IDEMPOTENCIA_TTL_PADRAO_MS;
  const teto = idempotenciaMax > 0 ? Math.floor(idempotenciaMax) : IDEMPOTENCIA_MAX_PADRAO;
  // Um store pode ser criado no escopo do módulo. Gera o boot só no contexto de uma chamada.
  let boot;
  const preparar = (sql, ...args) => args.length ? db.prepare(sql).bind(...args) : db.prepare(sql);
  const obter = (sql, ...args) => preparar(sql, ...args).first();
  const listar = async (sql, ...args) => (await preparar(sql, ...args).all()).results;
  const revisao = async () => (await obter('SELECT revisao FROM chatflow_revisao WHERE id = 1'))?.revisao ?? 0;

  async function apagarArquivo(chave) {
    try { await bucket.delete(chave); } catch { /* limpeza de órfãos pode ser repetida separadamente */ }
  }

  // O callback do núcleo calcula os efeitos a partir das leituras. A primeira
  // instrução do batch confirma que nenhuma outra escrita publicou nesse intervalo.
  async function transacao(executar) {
    for (let tentativa = 0; tentativa < 40; tentativa++) {
      const anterior = await revisao();
      const tx = { comandos: [], eventos: [], enviados: [], descartar: [] };
      let resposta;
      try {
        resposta = await executar(fachada(tx));
      } catch (erro) {
        await Promise.all(tx.enviados.map(apagarArquivo));
        if (await revisao() !== anterior) continue;
        throw erro;
      }
      if (!tx.comandos.length) {
        await Promise.all(tx.enviados.map(apagarArquivo));
        if (await revisao() === anterior) return resposta;
        continue;
      }
      try {
        await db.batch([
          preparar(`INSERT INTO chatflow_revisao (id, revisao) VALUES (1, 1)
            ON CONFLICT (id) DO UPDATE SET revisao =
              CASE WHEN revisao = ? THEN revisao + 1 ELSE -1 END`, anterior),
          ...tx.comandos,
        ]);
      } catch (erro) {
        if (String(erro.message).includes('chatflow_revisao_conflito')) {
          await Promise.all(tx.enviados.map(apagarArquivo));
          continue;
        }
        // Uma falha de transporte pode esconder um commit. Só descarta os
        // objetos novos quando o banco confirma que o lote foi revertido.
        if (String(erro.message).includes('SQLITE_CONSTRAINT')) {
          await Promise.all(tx.enviados.map(apagarArquivo));
        }
        throw erro;
      }
      await Promise.all(tx.descartar.map(apagarArquivo));
      if (sink) for (const evento of tx.eventos) sink(evento);
      return resposta;
    }
    throw Object.assign(new Error('alterações concorrentes; tente novamente'), { codigo: 503 });
  }

  function fachada(tx) {
    const gravar = (sql, ...args) => tx.comandos.push(preparar(sql, ...args));
    const conferirMutacao = () =>
      gravar('UPDATE chatflow_revisao SET revisao = -1 WHERE id = 1 AND changes() <> 1');
    const obterReserva = async (empresa, id) => lerReserva(await obter(
      `SELECT ${COLUNAS_RESERVA} FROM reservas WHERE empresa_id = ? AND codigo = ?`, empresa, id));
    const argsMesa = (empresa, mesa, ambiente) => [empresa, mesa, ambiente ?? null, ambiente ?? null];
    const argsOcupacao = (empresa, { mesaId, inicio, fim }, ignorar = null) => [empresa, mesaId, ignorar, fim, inicio];
    const mesaLivre = async (empresa, r, ignorar) => Boolean(await obter(
      `SELECT 1 WHERE ${MESA_EXISTE} AND ${SEM_SOBREPOSICAO}`, ...argsMesa(empresa, r.mesaId, r.ambiente),
      ...argsOcupacao(empresa, r, ignorar)));

    async function codigoNovo(empresa, usados = new Set()) {
      for (let i = 0; i < 128; i++) {
        const codigo = gerarCodigoReserva(plat, (c) => usados.has(c));
        if (!(await obter('SELECT 1 FROM reservas_codigos WHERE empresa_id = ? AND codigo = ?', empresa, codigo))) return codigo;
        usados.add(codigo);
      }
      throw new Error('não foi possível gerar um código de reserva único');
    }

    const valoresReserva = (uuid, empresa, codigo, r) => [uuid, empresa, codigo, r.mesaId, r.ambiente, r.data, r.horario,
      r.pessoas, r.inicio, r.fim, r.status, r.nomeCliente ?? null, r.contato ?? null];

    async function carregarItem({ arquivoChave, ...item }, incluir) {
      if (arquivoChave && incluir) {
        const arquivo = await bucket.get(arquivoChave);
        if (!arquivo) throw new Error('anexo de conhecimento ausente');
        item.arquivo.base64 = plat.base64Codificar(new Uint8Array(await arquivo.arrayBuffer()));
      }
      return item;
    }

    async function guardarArquivo(empresa, item) {
      if (typeof item.arquivo?.base64 !== 'string') return item;
      const { base64, ...arquivo } = item.arquivo;
      const chave = `empresas/${encodeURIComponent(empresa)}/conhecimento/${plat.uuid()}`;
      await bucket.put(chave, plat.base64Decodificar(base64));
      tx.enviados.push(chave);
      return { ...item, arquivo, arquivoChave: chave };
    }

    const conhecimentoGuardado = async (empresa, id) => {
      const linha = await obter('SELECT item FROM conhecimento WHERE empresa_id = ? AND id = ?', empresa, id);
      return linha ? JSON.parse(linha.item) : null;
    };
    const conhecimentoDaEmpresa = async (empresa) =>
      (await listar('SELECT item FROM conhecimento WHERE empresa_id = ? ORDER BY id', empresa)).map((linha) => JSON.parse(linha.item));

    async function lerEmpresa(linha, incluirConhecimento) {
      if (!linha) return null;
      const { id, nome, agente, chave, modulos, prox_conhecimento } = linha;
      const layout = await listar(`SELECT a.id AS ambiente_id, a.nome, m.mesa_id, m.capacidade, m.reservavel, m.descricao
        FROM ambientes a LEFT JOIN mesas m ON m.ambiente_id = a.id AND m.empresa_id = a.empresa_id
        WHERE a.empresa_id = ? ORDER BY a.id, m.ordem`, id);
      const ambientes = new Map();
      for (const linha of layout) {
        if (!ambientes.has(linha.ambiente_id)) ambientes.set(linha.ambiente_id, { nome: linha.nome, mesas: [] });
        if (linha.mesa_id !== null) ambientes.get(linha.ambiente_id).mesas.push(lerMesa(linha));
      }
      const conhecimento = [];
      if (incluirConhecimento) {
        for (const item of await conhecimentoDaEmpresa(id)) conhecimento.push(await carregarItem(item, true));
      }
      return { id, nome, agente: JSON.parse(agente), ambientes: [...ambientes.values()], chave: JSON.parse(chave),
        modulos: JSON.parse(modulos), conhecimento, proxConhecimento: prox_conhecimento };
    }

    async function idemObter(empresa, chave) {
      const linha = await obter('SELECT resposta, criada_em FROM idempotencia WHERE empresa_id = ? AND chave = ?', empresa, chave);
      if (!linha) return null;
      const limite = plat.agora() - ttl;
      if (linha.criada_em > limite) return JSON.parse(linha.resposta);
      gravar('DELETE FROM idempotencia WHERE empresa_id = ? AND chave = ? AND criada_em <= ?', empresa, chave, limite);
      return null;
    }

    function idemGravar(empresa, chave, resposta) {
      const agora = plat.agora();
      gravar('DELETE FROM idempotencia WHERE empresa_id = ? AND (chave = ? OR criada_em <= ?)', empresa, chave, agora - ttl);
      gravar('INSERT INTO idempotencia (empresa_id, chave, resposta, criada_em) VALUES (?, ?, ?, ?)',
        empresa, chave, JSON.stringify(resposta), agora);
      gravar(`DELETE FROM idempotencia WHERE id IN (SELECT id FROM idempotencia WHERE empresa_id = ?
        ORDER BY criada_em DESC, id DESC LIMIT -1 OFFSET ?)`, empresa, teto);
    }

    async function acrescentarEvento(ev) {
      boot ??= plat.uuid();
      const evento = { boot, quando: new Date(plat.agora()).toISOString(), ...JSON.parse(JSON.stringify(ev)) };
      const { empresaId, entidade, entidadeId, acao, refSeq } = evento;
      const anterior = (await obter("SELECT seq FROM sqlite_sequence WHERE name = 'historico'"))?.seq ?? 0;
      const seq = anterior + tx.eventos.length + 1;
      gravar('INSERT INTO historico (empresa_id, entidade, entidade_id, acao, ref_seq, evento) VALUES (?, ?, ?, ?, ?, ?)',
        empresaId, entidade, entidadeId == null ? null : String(entidadeId), acao, refSeq ?? null, JSON.stringify(evento));
      const resultado = congelar({ seq, ...evento });
      tx.eventos.push(resultado);
      return resultado;
    }

    function agoraEmMinutos() {
      const w = parede(plat.agora(), fusoDe(fuso));
      return minutosAbsolutos(w.data, w.horario);
    }

    const leituras = {
      async empresaObter(id, { incluirConhecimento = true } = {}) {
        return lerEmpresa(await obter('SELECT * FROM empresas WHERE id = ?', id), incluirConhecimento);
      },
      async empresaListar({ incluirConhecimento = true } = {}) {
        const empresas = [];
        for (const linha of await listar('SELECT * FROM empresas ORDER BY rowid')) empresas.push(await lerEmpresa(linha, incluirConhecimento));
        return empresas;
      },
      async empresaProximoId() {
        const { n } = await obter(`WITH RECURSIVE candidatos(n) AS (
          SELECT COUNT(*) + 1 FROM empresas
          UNION ALL SELECT n + 1 FROM candidatos
          WHERE EXISTS (SELECT 1 FROM empresas WHERE id = 'empresa_' || n)
             OR EXISTS (SELECT 1 FROM historico WHERE empresa_id = 'empresa_' || n)
        ) SELECT MAX(n) AS n FROM candidatos`);
        return `empresa_${n}`;
      },
      async empresaNomeEmUso(nome, ignorarId = null) {
        return Boolean(await obter(`SELECT 1 FROM empresas WHERE id IS NOT ? AND (nome_normalizado = ? OR nome = ?) LIMIT 1`,
          ignorarId, nome.toLowerCase(), nome));
      },
      async empresaPorChaveHash(hash) {
        const e = await obter('SELECT id, chave_hash FROM empresas WHERE chave_hash = ? ORDER BY rowid LIMIT 1', hash);
        return e && plat.iguaisTempoConstante(hash, e.chave_hash) ? e.id : null;
      },
      async reservaListar(empresa, { data } = {}) {
        return (await listar(`SELECT ${COLUNAS_RESERVA} FROM reservas WHERE empresa_id = ?
          AND (? IS NULL OR data = ?) ORDER BY rowid`, empresa, data || null, data || null)).map(lerReserva);
      },
      reservaObter: obterReserva,
      async reservaConfirmadas(empresa, ignorarId = null) {
        return (await listar(`SELECT ${COLUNAS_RESERVA} FROM reservas WHERE empresa_id = ?
          AND status = 'confirmada' AND codigo IS NOT ? ORDER BY rowid`, empresa, ignorarId)).map(lerReserva);
      },
      async idempotenciaTamanho(empresa) {
        return (await obter('SELECT COUNT(*) AS n FROM idempotencia WHERE empresa_id = ?', empresa)).n;
      },
      async conhecimentoListar(empresa, { incluirArquivo = true } = {}) {
        const itens = [];
        for (const item of await conhecimentoDaEmpresa(empresa)) itens.push(await carregarItem(item, incluirArquivo));
        return itens;
      },
      async conhecimentoObter(empresa, id, { incluirArquivo = true } = {}) {
        const item = await conhecimentoGuardado(empresa, id);
        return item ? carregarItem(item, incluirArquivo) : null;
      },
      async historicoListar(empresa, { entidade, entidadeId, limite } = {}) {
        const n = Math.trunc(Math.min(Math.max(Number(limite) || 200, 1), 1000));
        const id = entidadeId ? String(entidadeId) : null;
        return (await listar(`SELECT seq, evento FROM historico WHERE empresa_id = ? AND (? IS NULL OR entidade = ?)
          AND (? IS NULL OR entidade_id = ?) ORDER BY seq DESC LIMIT ?`, empresa, entidade || null, entidade || null, id, id, n)).map(lerEvento);
      },
      async historicoObter(empresa, seq) {
        return lerEvento(await obter('SELECT seq, evento FROM historico WHERE empresa_id = ? AND seq = ?', empresa, seq));
      },
      async historicoDesfeito(empresa, seq) {
        return Boolean(await obter("SELECT 1 FROM historico WHERE empresa_id = ? AND ref_seq = ? AND acao = 'desfeita'", empresa, seq));
      },
      async historicoExcluidas() {
        return (await listar("SELECT seq, evento FROM historico WHERE acao = 'excluida' AND entidade = 'empresa' ORDER BY seq DESC")).map(lerEvento);
      },
      async tentativasAdminObter() {
        return await obter('SELECT n, ate FROM tentativas_admin WHERE id = 1') || { n: 0, ate: 0 };
      },
    };

    const escritas = {
      async empresaCriar({ id, nome, agente, ambientes, modulos, reservas = [] }) {
        const finais = { ...MODULOS, ...modulos };
        gravar(`INSERT INTO empresas (id, nome, nome_normalizado, agente, modulos) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET nome = excluded.nome, nome_normalizado = excluded.nome_normalizado,
          agente = excluded.agente, modulos = excluded.modulos, chave = NULL, prox_conhecimento = 1`,
        id, nome, nome.toLowerCase(), JSON.stringify(agente), JSON.stringify(finais));
        gravar('DELETE FROM ambientes WHERE empresa_id = ?', id);
        for (const { arquivoChave } of await conhecimentoDaEmpresa(id)) if (arquivoChave) tx.descartar.push(arquivoChave);
        gravar('DELETE FROM conhecimento WHERE empresa_id = ?', id);
        for (const a of ambientes) {
          gravar('INSERT INTO ambientes (empresa_id, nome, nome_normalizado) VALUES (?, ?, ?)', id, a.nome, a.nome.toLowerCase());
          for (const m of a.mesas) {
            gravar(`INSERT INTO mesas (empresa_id, ambiente_id, mesa_id, capacidade, reservavel, descricao)
              SELECT empresa_id, id, ?, ?, ?, ? FROM ambientes WHERE empresa_id = ? AND nome = ?`,
            m.id, m.capacidade, Number(Boolean(m.reservavel)), m.descricao || '', id, a.nome);
          }
        }
        const usados = new Set();
        for (const semente of reservas) {
          const r = prepararReservaSemeada(semente, ambientes);
          const codigo = await codigoNovo(id, usados);
          usados.add(codigo);
          gravar(`INSERT INTO reservas (${COLUNAS_GRAVACAO}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ...valoresReserva(plat.uuid(), id, codigo, r));
        }
        return { id, nome, agente, ambientes: ambientes.map((a) => ({ nome: a.nome,
          mesas: a.mesas.map((m) => ({ id: m.id, capacidade: m.capacidade, reservavel: Boolean(m.reservavel), ...(m.descricao ? { descricao: m.descricao } : {}) })) })),
        chave: null, modulos: finais, conhecimento: [], proxConhecimento: 1 };
      },
      async empresaRenomear(id, nome) {
        const { nome: antes } = await obter('SELECT nome FROM empresas WHERE id = ?', id);
        gravar('UPDATE empresas SET nome = ?, nome_normalizado = ? WHERE id = ?', nome, nome.toLowerCase(), id);
        return { antes, depois: nome };
      },
      async empresaModulosDefinir(id, modulos) {
        const atuais = await obter('SELECT modulos FROM empresas WHERE id = ?', id);
        const novos = { ...JSON.parse(atuais.modulos), ...modulos };
        gravar('UPDATE empresas SET modulos = ? WHERE id = ?', JSON.stringify(novos), id);
        return novos;
      },
      async agenteAtualizar(id, mudancas) {
        const atual = await obter('SELECT agente FROM empresas WHERE id = ?', id);
        gravar('UPDATE empresas SET agente = ? WHERE id = ?', JSON.stringify({ ...JSON.parse(atual.agente), ...mudancas }), id);
      },
      async chaveDefinir(id, chave) { gravar('UPDATE empresas SET chave = ? WHERE id = ?', JSON.stringify(chave), id); },
      async chaveRemover(id) { gravar('UPDATE empresas SET chave = NULL WHERE id = ?', id); },
      async empresaExcluir(id, evento) {
        for (const { arquivoChave } of await conhecimentoDaEmpresa(id)) if (arquivoChave) tx.descartar.push(arquivoChave);
        gravar('DELETE FROM empresas WHERE id = ?', id);
        return acrescentarEvento(evento);
      },
      async ambienteCriar(empresa, nome) {
        const normalizado = nome.toLowerCase();
        if (await obter('SELECT 1 FROM ambientes WHERE empresa_id = ? AND nome_normalizado = ?', empresa, normalizado)) {
          return { ok: false, motivo: 'duplicado' };
        }
        gravar('INSERT INTO ambientes (empresa_id, nome, nome_normalizado) VALUES (?, ?, ?)', empresa, nome, normalizado);
        return { ok: true };
      },
      async ambienteRenomear(empresa, ambiente, nome) {
        const atual = await obter('SELECT id FROM ambientes WHERE empresa_id = ? AND nome = ?', empresa, ambiente);
        if (!atual) return { erro: 'nao_encontrado' };
        if (await obter('SELECT 1 FROM ambientes WHERE empresa_id = ? AND nome_normalizado = ? AND id <> ?',
          empresa, nome.toLowerCase(), atual.id)) return { erro: 'nome_duplicado' };
        const mesas = (await listar('SELECT * FROM mesas WHERE empresa_id = ? AND ambiente_id = ? ORDER BY ordem', empresa, atual.id)).map(lerMesa);
        gravar('UPDATE ambientes SET nome = ?, nome_normalizado = ? WHERE id = ?', nome, nome.toLowerCase(), atual.id);
        gravar('UPDATE reservas SET ambiente = ? WHERE empresa_id = ? AND ambiente = ?', nome, empresa, ambiente);
        return { nome, mesas };
      },
      async ambienteRemover(empresa, ambiente) {
        const atual = await obter('SELECT id FROM ambientes WHERE empresa_id = ? AND nome = ?', empresa, ambiente);
        if (!atual) return { erro: 'nao_encontrado' };
        const selecao = 'SELECT mesa_id FROM mesas WHERE empresa_id = ? AND ambiente_id = ?';
        const reservas = await listar(`SELECT codigo FROM reservas WHERE empresa_id = ? AND mesa_id IN (${selecao})
          AND status = 'confirmada' AND fim > ? ORDER BY codigo`, empresa, empresa, atual.id, agoraEmMinutos());
        if (reservas.length) return { erro: 'mesa_com_reserva', reservas: reservas.map((r) => r.codigo) };
        const mesas = await listar(`${selecao} ORDER BY ordem`, empresa, atual.id);
        gravar(`UPDATE reservas SET mesa_id = NULL WHERE empresa_id = ? AND mesa_id IN (${selecao})`, empresa, empresa, atual.id);
        gravar('DELETE FROM ambientes WHERE id = ?', atual.id);
        return { ok: true, mesasRemovidas: mesas.map((m) => m.mesa_id) };
      },
      async mesaCriar(empresa, ambiente, { capacidade, reservavel, descricao }) {
        const atual = await obter('SELECT id FROM ambientes WHERE empresa_id = ? AND nome = ?', empresa, ambiente);
        if (!atual) return null;
        const base = (ambiente.match(/[A-Za-z]/) || ['M'])[0].toUpperCase();
        const ids = new Set((await listar('SELECT mesa_id FROM mesas WHERE empresa_id = ?', empresa)).map((m) => m.mesa_id));
        let n = 1;
        while (ids.has(`${base}${n}`)) n++;
        const mesa = { id: `${base}${n}`, capacidade, reservavel: reservavel !== false, ...(descricao ? { descricao } : {}) };
        gravar('INSERT INTO mesas (empresa_id, ambiente_id, mesa_id, capacidade, reservavel, descricao) VALUES (?, ?, ?, ?, ?, ?)',
          empresa, atual.id, mesa.id, mesa.capacidade, Number(mesa.reservavel), descricao || '');
        return mesa;
      },
      async mesaEditar(empresa, mesaId, { capacidade, reservavel, descricao }) {
        const atual = await obter('SELECT * FROM mesas WHERE empresa_id = ? AND mesa_id = ?', empresa, mesaId);
        if (!atual) return null;
        const { id, ...antes } = lerMesa(atual);
        const texto = descricao ?? antes.descricao ?? '';
        const mesa = { id, capacidade: capacidade ?? antes.capacidade, reservavel: reservavel ?? antes.reservavel, ...(texto ? { descricao: texto } : {}) };
        gravar('UPDATE mesas SET capacidade = ?, reservavel = ?, descricao = ? WHERE ordem = ?', mesa.capacidade, Number(mesa.reservavel), texto, atual.ordem);
        return { antes, mesa };
      },
      async mesaRemover(empresa, mesaId) {
        if (!(await obter('SELECT 1 FROM mesas WHERE empresa_id = ? AND mesa_id = ?', empresa, mesaId))) return { erro: 'nao_encontrado' };
        const reservas = await listar('SELECT codigo, status, fim FROM reservas WHERE empresa_id = ? AND mesa_id = ? ORDER BY codigo', empresa, mesaId);
        const agora = agoraEmMinutos();
        const ativas = reservas.filter((r) => r.status === 'confirmada' && r.fim > agora);
        if (ativas.length) return { erro: 'mesa_com_reserva', reservas: ativas.map((r) => r.codigo) };
        gravar('UPDATE reservas SET mesa_id = NULL WHERE empresa_id = ? AND mesa_id = ?', empresa, mesaId);
        gravar('DELETE FROM mesas WHERE empresa_id = ? AND mesa_id = ?', empresa, mesaId);
        return { ok: true, reservasDesligadas: reservas.map((r) => r.codigo) };
      },
      async reservaCriar({ empresaId, chave, candidatas, reserva }) {
        const antiga = chave && await idemObter(empresaId, chave);
        if (antiga) return { criada: false, resposta: antiga };
        for (const { mesaId, ambiente } of candidatas) {
          const dados = { ...reserva, mesaId, ambiente, status: 'confirmada' };
          if (!(await mesaLivre(empresaId, dados))) continue;
          const id = await codigoNovo(empresaId);
          const valores = valoresReserva(plat.uuid(), empresaId, id, dados);
          gravar(`INSERT INTO reservas (${COLUNAS_GRAVACAO}) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE ${MESA_EXISTE} AND ${SEM_SOBREPOSICAO}`,
          ...valores, ...argsMesa(empresaId, mesaId, ambiente), ...argsOcupacao(empresaId, dados));
          conferirMutacao();
          const resposta = { status: 'confirmada', reservaId: id, mesa: mesaId, ambiente };
          if (chave) idemGravar(empresaId, chave, resposta);
          return { criada: true, resposta, reserva: lerReserva({ id, empresaId, mesaId, ambiente, data: dados.data,
            horario: dados.horario, pessoas: dados.pessoas, inicio: dados.inicio, fim: dados.fim, status: dados.status,
            nomeCliente: dados.nomeCliente ?? null, contato: dados.contato ?? null }) };
        }
        return { conflito: true };
      },
      idempotenciaObter: idemObter,
      async idempotenciaGravar(empresa, chave, resposta) { idemGravar(empresa, chave, resposta); },
      async reservaEditar({ empresaId, id, dados, cliente }) {
        const atual = await obterReserva(empresaId, id);
        if (atual?.status !== 'confirmada') return { ...CONFLITO };
        const nova = { ...atual, ...dados, ...cliente };
        if (!(await mesaLivre(empresaId, nova, id))) return { ...CONFLITO };
        const nome = cliente?.nomeCliente === '' ? null : nova.nomeCliente ?? null;
        const contato = cliente?.contato === '' ? null : nova.contato ?? null;
        gravar(`UPDATE reservas SET mesa_id = ?, ambiente = ?, data = ?, horario = ?, pessoas = ?,
          inicio = ?, fim = ?, nome_cliente = ?, contato = ? WHERE empresa_id = ? AND codigo = ? AND status = 'confirmada'
          AND ${MESA_EXISTE} AND ${SEM_SOBREPOSICAO}`, nova.mesaId, nova.ambiente, nova.data, nova.horario, nova.pessoas,
        nova.inicio, nova.fim, nome, contato, empresaId, id, ...argsMesa(empresaId, nova.mesaId, nova.ambiente),
        ...argsOcupacao(empresaId, nova, id));
        conferirMutacao();
        return { ok: true, reserva: lerReserva({ ...nova, nomeCliente: nome, contato }) };
      },
      async reservaCancelar(empresa, id) {
        const atual = await obterReserva(empresa, id);
        if (!atual) return null;
        if (atual.status !== 'cancelada') gravar("UPDATE reservas SET status = 'cancelada' WHERE empresa_id = ? AND codigo = ?", empresa, id);
        return { ...atual, status: 'cancelada' };
      },
      async reservaReativar(empresa, id) {
        const atual = await obterReserva(empresa, id);
        if (!atual) return { ...CONFLITO };
        if (atual.status === 'confirmada') return { ok: true, reserva: atual };
        if (atual.mesaId == null || !(await mesaLivre(empresa, atual, id))) return { ...CONFLITO };
        gravar(`UPDATE reservas SET status = 'confirmada' WHERE empresa_id = ? AND codigo = ?
          AND ${MESA_EXISTE} AND ${SEM_SOBREPOSICAO}`, empresa, id, ...argsMesa(empresa, atual.mesaId, atual.ambiente),
        ...argsOcupacao(empresa, atual, id));
        conferirMutacao();
        return { ok: true, reserva: { ...atual, status: 'confirmada' } };
      },
      async reservaExcluir(empresa, id) {
        const atual = await obterReserva(empresa, id);
        if (!atual) return { erro: 'nao_encontrada' };
        if (atual.status === 'confirmada') return { erro: 'reserva_ativa' };
        gravar("DELETE FROM reservas WHERE empresa_id = ? AND codigo = ? AND status = 'cancelada'", empresa, id);
        return { ok: true, reserva: atual };
      },
      async conhecimentoCriar(empresa, item, maxItens) {
        const { n } = await obter('SELECT COUNT(*) AS n FROM conhecimento WHERE empresa_id = ?', empresa);
        if (n >= maxItens) return { ok: false, motivo: 'limite' };
        const { prox_conhecimento: id } = await obter('SELECT prox_conhecimento FROM empresas WHERE id = ?', empresa);
        const novo = { id, ...item };
        const guardado = await guardarArquivo(empresa, novo);
        gravar('UPDATE empresas SET prox_conhecimento = prox_conhecimento + 1 WHERE id = ?', empresa);
        gravar('INSERT INTO conhecimento (empresa_id, id, item) VALUES (?, ?, ?)', empresa, id, JSON.stringify(guardado));
        return { ok: true, item: novo };
      },
      async conhecimentoEditar(empresa, id, mudancas) {
        const atual = await conhecimentoGuardado(empresa, id);
        if (!atual) return null;
        const novo = { ...atual, ...mudancas };
        for (const campo of Object.keys(mudancas)) if (mudancas[campo] === undefined) delete novo[campo];
        if (Object.hasOwn(mudancas, 'arquivo')) delete novo.arquivoChave;
        const guardado = await guardarArquivo(empresa, novo);
        gravar('UPDATE conhecimento SET item = ? WHERE empresa_id = ? AND id = ?', JSON.stringify(guardado), empresa, id);
        if (atual.arquivoChave && atual.arquivoChave !== guardado.arquivoChave) tx.descartar.push(atual.arquivoChave);
        return carregarItem(guardado, true);
      },
      async conhecimentoExcluir(empresa, id) {
        const atual = await conhecimentoGuardado(empresa, id);
        if (!atual) return null;
        const item = await carregarItem(atual, true);
        gravar('DELETE FROM conhecimento WHERE empresa_id = ? AND id = ?', empresa, id);
        if (atual.arquivoChave) tx.descartar.push(atual.arquivoChave);
        return item;
      },
      historicoAcrescentar: acrescentarEvento,
      async tentativasAdminGravar({ n, ate }) {
        gravar(`INSERT INTO tentativas_admin (id, n, ate) VALUES (1, ?, ?)
          ON CONFLICT (id) DO UPDATE SET n = excluded.n, ate = excluded.ate`, n, ate);
      },
    };
    if (tx) return { plat, ...leituras, ...escritas };

    const store = { plat, ...leituras, ...operacoesUsuariosD1(db, plat), transacao };
    for (const nome of Object.keys(escritas)) {
      store[nome] = (...args) => transacao((interno) => interno[nome](...args));
    }
    // A validação da revisão também cobre leituras compostas e a troca de anexos no R2.
    for (const nome of ['empresaObter', 'empresaListar', 'empresaProximoId', 'conhecimentoListar', 'conhecimentoObter']) {
      store[nome] = (...args) => transacao((interno) => interno[nome](...args));
    }
    return store;
  }
  return fachada();
}
