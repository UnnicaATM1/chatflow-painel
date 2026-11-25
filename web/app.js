'use strict';

(function () {
  // Endereço da API vindo de config.js (sem barra no fim). Vazio = mesma origem do painel.
  var BASE = String((window.CHATFLOW_CONFIG && window.CHATFLOW_CONFIG.apiBase) || '').replace(/\/$/, '');
  var R = window.React, h = R.createElement, K = window.ChatFlow;
  var useState = R.useState, useEffect = R.useEffect, useCallback = R.useCallback;

  function hoje() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function br(data) { var p = String(data).split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : data; }

  function lerToken() { try { return sessionStorage.getItem('k1token') || ''; } catch (e) { return ''; } }
  function lerOperador() { try { return sessionStorage.getItem('k1operador') || ''; } catch (e) { return ''; } }
  function gravarOperador(n) { try { if (n) sessionStorage.setItem('k1operador', n); else sessionStorage.removeItem('k1operador'); } catch (e) { /* ignora */ } }
  function gravarToken(t) { try { if (t) sessionStorage.setItem('k1token', t); else sessionStorage.removeItem('k1token'); } catch (e) { /* ignora */ } }

  function api(token, metodo, caminho, corpo) {
    return fetch(BASE + caminho, {
      method: metodo,
      headers: Object.assign({ Authorization: 'Bearer ' + token }, lerOperador() ? { 'X-Operador': encodeURIComponent(lerOperador()) } : {}, corpo ? { 'Content-Type': 'application/json' } : {}),
      body: corpo ? JSON.stringify(corpo) : undefined,
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) { var e = new Error(j.erro || 'Erro ' + r.status); e.status = r.status; e.dados = j; throw e; }
        return j;
      });
    });
  }

  function Login(p) {
    var st = useState(''), valor = st[0], setValor = st[1];
    var sn = useState(lerOperador()), nome = sn[0], setNome = sn[1];
    var se = useState(''), erro = se[0], setErro = se[1];
    function entrar(ev) {
      ev.preventDefault();
      gravarOperador(nome.trim());
      api(valor, 'GET', '/empresas').then(function (empresas) { gravarToken(valor); p.onEntrar(valor, empresas); })
        .catch(function (e) { setErro(e.status === 401 ? 'Chave inválida.' : e.status === 403 ? 'Esta chave não acessa o painel.' : e.message); });
    }
    return h('div', { className: 'pagina', style: { maxWidth: 420, marginTop: 64 } },
      h('div', { className: 'painel' },
        h('form', { className: 'k1-stack', onSubmit: entrar },
          h('h1', null, 'Entrar no ChatFlow Painel'),
          h('label', { className: 'campo' }, h('span', { className: 'rotulo' }, 'Seu nome (aparece no histórico)'),
            h('input', { type: 'text', value: nome, maxLength: 60, autoComplete: 'off', onChange: function (e) { setNome(e.target.value); } })),
          h('label', { className: 'campo' }, h('span', { className: 'rotulo' }, 'Chave de acesso'),
            h('input', { type: 'password', value: valor, autoComplete: 'off', onChange: function (e) { setValor(e.target.value); } })),
          erro && h('div', { className: 'erro', role: 'alert' }, erro),
          h(K.Button, { type: 'submit', disabled: !valor }, 'Entrar'))));
  }


  function chaveNova() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random(); }

  function NovaReserva(p) {
    var sd = useState(hoje()), data = sd[0], setData = sd[1];
    var sh = useState('20:00'), hora = sh[0], setHora = sh[1];
    var sp = useState('2'), pessoas = sp[0], setPessoas = sp[1];
    var sv = useState(null), disp = sv[0], setDisp = sv[1];
    var sm = useState(''), msg = sm[0], setMsg = sm[1];
    var sn = useState(''), nomeCli = sn[0], setNomeCli = sn[1];
    var sc2 = useState(''), contatoCli = sc2[0], setContatoCli = sc2[1];
    function consultar() {
      setMsg(''); setDisp(null);
      api(p.token, 'GET', '/empresas/' + encodeURIComponent(p.empresa) + '/disponibilidade?data=' + data + '&horario=' + hora + '&pessoas=' + Number(pessoas))
        .then(setDisp).catch(function (e) { setMsg(e.message); });
    }
    function reservar(mesaId) {
      api(p.token, 'POST', '/empresas/' + encodeURIComponent(p.empresa) + '/reservas', { data: data, horario: hora, pessoas: Number(pessoas), mesaId: mesaId, chave: chaveNova(), nomeCliente: nomeCli.trim() || undefined, contato: contatoCli.trim() || undefined })
        .then(function (r) {
          if (r.status === 'confirmada') { setMsg('Reserva confirmada na mesa ' + r.mesa + '.'); setDisp(null); p.aoReservar(data); }
          else { setMsg('Mesa já reservada. Disponibilidade atualizada.'); setDisp({ ambientes: r.disponibilidade }); }
        }).catch(function (e) { setMsg(e.message); });
    }
    var total = disp ? disp.ambientes.reduce(function (n, a) { return n + a.mesas.length; }, 0) : 0;
    return h('div', { className: 'k1-stack', style: { borderBottom: '1px solid var(--border)', paddingBottom: 16 } },
      h('div', { className: 'rotulo' }, '+ Nova reserva'),
      h('div', { className: 'k1-row' },
        h('input', { type: 'date', value: data, 'aria-label': 'Data da reserva', onChange: function (e) { setData(e.target.value); setDisp(null); } }),
        h('input', { type: 'time', value: hora, 'aria-label': 'Horário da reserva', onChange: function (e) { setHora(e.target.value); setDisp(null); } }),
        h('input', { type: 'number', min: 1, value: pessoas, style: { width: 80 }, 'aria-label': 'Pessoas', onChange: function (e) { setPessoas(e.target.value); setDisp(null); } }),
        h(K.Button, { onClick: consultar }, 'Ver disponibilidade')),
      h('div', { className: 'k1-row' },
        h('input', { type: 'text', value: nomeCli, maxLength: 80, placeholder: 'Nome do cliente (opcional)', 'aria-label': 'Nome do cliente', style: { minWidth: 220 }, onChange: function (e) { setNomeCli(e.target.value); } }),
        h('input', { type: 'text', value: contatoCli, maxLength: 40, placeholder: 'Telefone ou e-mail (opcional)', 'aria-label': 'Contato do cliente', style: { minWidth: 220 }, onChange: function (e) { setContatoCli(e.target.value); } })),
      msg && h('div', { role: 'status', className: /confirmada/.test(msg) ? 'rotulo' : 'erro' }, msg),
      disp && total === 0 && h(K.EmptyState, null, 'Sem mesa livre neste horário para ' + pessoas + ' pessoas.'),
      disp && total > 0 && disp.ambientes.map(function (a) {
        return h('div', { key: a.ambiente }, h('div', { className: 'rotulo', style: { marginBottom: 8 } }, a.ambiente),
          a.mesas.length === 0 ? h('div', { className: 'rotulo' }, 'Sem mesas livres') :
            h('div', { className: 'mesas' }, a.mesas.map(function (m) {
              return h('button', { key: m.id, type: 'button', className: 'mesa', 'data-situacao': 'livre', onClick: function () { reservar(m.id); } }, h('b', null, m.id), m.capacidade + ' lugares · reservar');
            })));
      }));
  }

  function LinhaReserva(p) {
    var r = p.r, base = '/empresas/' + encodeURIComponent(p.empresa) + '/reservas/' + r.id;
    var sa = useState(false), aberto = sa[0], setAberto = sa[1];
    var sf = useState({ data: r.data, horario: r.horario, pessoas: String(r.pessoas), mesaId: r.mesaId }), f = sf[0], setF = sf[1];
    var sd = useState(null), disp = sd[0], setDisp = sd[1];
    var sm = useState(''), msg = sm[0], setMsg = sm[1];
    var ativa = r.status === 'confirmada';
    var sx = useState(false), confExcluir = sx[0], setConfExcluir = sx[1];
    function excluirDefinitivo() {
      api(p.token, 'DELETE', base + '?definitivo=1').then(function () { p.recarregar(); })
        .catch(function (e) { setConfExcluir(false); setMsg(e.status === 409 ? 'Esta reserva está ativa. Cancele antes de excluir em definitivo.' : e.message); });
    }
    function enviar(metodo, corpo) {
      api(p.token, metodo, base, corpo).then(function () { setMsg(''); setAberto(false); p.recarregar(); })
        .catch(function (e) {
          setMsg(e.status === 409 ? 'Mesa ou horário indisponível para essa mudança.' : e.message);
          if (e.status === 409 && corpo) {
            api(p.token, 'GET', '/empresas/' + encodeURIComponent(p.empresa) + '/disponibilidade?data=' + (corpo.data || r.data) + '&horario=' + (corpo.horario || r.horario) + '&pessoas=' + (corpo.pessoas || r.pessoas) + '&ignorar=' + r.id).then(setDisp).catch(function () {});
          }
        });
    }
    function consultar(novo) {
      var x = Object.assign({}, f, novo); setF(x); setDisp(null);
      if (Number(x.pessoas) >= 1 && x.data && x.horario) {
        api(p.token, 'GET', '/empresas/' + encodeURIComponent(p.empresa) + '/disponibilidade?data=' + x.data + '&horario=' + x.horario + '&pessoas=' + Number(x.pessoas) + '&ignorar=' + r.id).then(setDisp).catch(function () {});
      }
    }
    return h(R.Fragment, null,
      h('tr', { style: ativa ? null : { opacity: 0.55 } },
        h('td', { className: 'mono' }, r.horario),
        h('td', { className: 'mono' }, h('span', { className: 'k1-row', style: { gap: 4, flexWrap: 'nowrap' } },
          ativa && h(K.Button, { variant: 'secondary', 'aria-label': 'Retirar uma pessoa', disabled: r.pessoas <= 1, onClick: function () { enviar('PATCH', { pessoas: r.pessoas - 1 }); } }, '−'),
          r.pessoas,
          ativa && h(K.Button, { variant: 'secondary', 'aria-label': 'Adicionar uma pessoa', onClick: function () { enviar('PATCH', { pessoas: r.pessoas + 1 }); } }, '+'))),
        h('td', null, r.ambiente), h('td', { className: 'mono' }, r.mesaId),
        h('td', null, r.nomeCliente ? h('span', null, r.nomeCliente, r.contato && h('span', { className: 'rotulo', style: { display: 'block' } }, r.contato)) : h('span', { style: { color: 'var(--ink-muted)' } }, '—')),
        h('td', null, h('span', { className: 'k1-pill k1-pill-' + (ativa ? 'concluida' : 'pendente') }, ativa ? 'Confirmada' : 'Cancelada')),
        h('td', null, h('span', { className: 'k1-row', style: { gap: 4 } },
          ativa && h(K.Button, { variant: 'secondary', onClick: function () { setAberto(!aberto); if (!aberto) consultar({}); } }, 'Editar'),
          ativa && h(K.Button, { variant: 'danger', onClick: function () { enviar('DELETE'); } }, 'Cancelar'),
          !ativa && !confExcluir && h(K.Button, { variant: 'primary', onClick: function () { enviar('PATCH', { status: 'confirmada' }); } }, 'Reativar'),
          !ativa && !confExcluir && h(K.Button, { variant: 'danger', onClick: function () { setMsg(''); setConfExcluir(true); } }, 'Excluir')))),
      confExcluir && h('tr', null, h('td', { colSpan: 7 }, h('div', { className: 'k1-row', role: 'alert' },
        h('span', null, 'Excluir em definitivo a reserva #' + r.id + '? Não dá para desfazer. Fica um registro no histórico.'),
        h(K.Button, { variant: 'danger', onClick: excluirDefinitivo }, 'Confirmar exclusão'),
        h(K.Button, { variant: 'ghost', onClick: function () { setConfExcluir(false); } }, 'Cancelar')))),
      (msg && !aberto) && h('tr', null, h('td', { colSpan: 7, className: 'erro', role: 'alert' }, msg)),
      aberto && h('tr', null, h('td', { colSpan: 7 }, h('div', { className: 'k1-stack', style: { padding: '8px 0' } },
        h('div', { className: 'k1-row' },
          h('input', { type: 'date', value: f.data, 'aria-label': 'Nova data', onChange: function (e) { consultar({ data: e.target.value }); } }),
          h('input', { type: 'time', value: f.horario, 'aria-label': 'Novo horário', onChange: function (e) { consultar({ horario: e.target.value }); } }),
          h('input', { type: 'number', min: 1, value: f.pessoas, style: { width: 80 }, 'aria-label': 'Pessoas', onChange: function (e) { consultar({ pessoas: e.target.value }); } })),
        disp && disp.ambientes.map(function (a) {
          return h('div', { key: a.ambiente }, h('div', { className: 'rotulo', style: { marginBottom: 6 } }, a.ambiente),
            a.mesas.length === 0 ? h('div', { className: 'rotulo' }, 'Sem mesas livres') : h('div', { className: 'mesas' }, a.mesas.map(function (m) {
              return h('button', { key: m.id, type: 'button', className: 'mesa', 'data-situacao': 'livre', 'aria-pressed': String(f.mesaId === m.id), onClick: function () { setF(Object.assign({}, f, { mesaId: m.id })); } }, h('b', null, m.id), m.capacidade + ' lugares');
            })));
        }),
        msg && h('div', { className: 'erro', role: 'alert' }, msg),
        h('div', { className: 'k1-row' },
          h(K.Button, { onClick: function () { enviar('PATCH', { data: f.data, horario: f.horario, pessoas: Number(f.pessoas), mesaId: f.mesaId }); } }, 'Salvar alterações'),
          h(K.Button, { variant: 'ghost', onClick: function () { setAberto(false); setMsg(''); } }, 'Fechar'))))));
  }

  function Reservas(p) {
    var sd = useState(hoje()), data = sd[0], setData = sd[1];
    var sl = useState(null), lista = sl[0], setLista = sl[1];
    var se = useState(''), erro = se[0], setErro = se[1];
    var sr = useState(0), recarga = sr[0], setRecarga = sr[1];
    useEffect(function () {
      api(p.token, 'GET', '/empresas/' + encodeURIComponent(p.empresa) + '/reservas?data=' + data).then(setLista).catch(function (e) { setErro(e.message); });
    }, [p.empresa, data, p.token, recarga]);
    return h('section', { className: 'painel k1-stack' },
      h(NovaReserva, { token: p.token, empresa: p.empresa, aoReservar: function (d) { setData(d); setRecarga(recarga + 1); } }),
      h('div', { className: 'k1-row' }, h('h2', null, 'Reservas'), h('input', { type: 'date', value: data, 'aria-label': 'Data', onChange: function (e) { setData(e.target.value); } })),
      erro && h('div', { className: 'erro', role: 'alert' }, erro),
      lista && lista.length === 0 && h(K.EmptyState, null, 'Nenhuma reserva em ' + br(data) + '. Elas chegam pelo chat do agente.'),
      lista && lista.length > 0 && h('table', null,
        h('thead', null, h('tr', null, ['Horário', 'Pessoas', 'Ambiente', 'Mesa', 'Cliente', 'Situação', 'Ações'].map(function (c) { return h('th', { key: c }, c); }))),
        h('tbody', null, lista.slice().sort(function (a, b) { return a.horario < b.horario ? -1 : 1; }).map(function (r) {
          return h(LinhaReserva, { key: r.id + r.horario + r.pessoas + r.mesaId + r.status, r: r, token: p.token, empresa: p.empresa, recarregar: function () { setRecarga(recarga + 1); } });
        }))));
  }

  function Mapa(p) {
    var sd = useState(hoje()), data = sd[0], setData = sd[1];
    var sh = useState('20:00'), hora = sh[0], setHora = sh[1];
    var sm = useState(null), mapa = sm[0], setMapa = sm[1];
    var ss = useState(null), sel = ss[0], setSel = ss[1];
    var se = useState(''), erro = se[0], setErro = se[1];
    useEffect(function () {
      setSel(null);
      if (!data || !hora) return;
      api(p.token, 'GET', '/empresas/' + encodeURIComponent(p.empresa) + '/mapa?data=' + data + '&horario=' + hora).then(function (m) { setErro(''); setMapa(m); }).catch(function (e) { setErro(e.message); });
    }, [p.empresa, data, hora, p.token]);
    var mesa = null;
    if (mapa && sel) mapa.forEach(function (a) { a.mesas.forEach(function (m) { if (m.id === sel) mesa = Object.assign({ ambiente: a.ambiente }, m); }); });
    return h('div', { className: 'grade' },
      h('section', { className: 'painel k1-stack' },
        h('div', { className: 'k1-row' }, h('h2', null, 'Mapa de mesas'),
          h('input', { type: 'date', value: data, 'aria-label': 'Data', onChange: function (e) { setData(e.target.value); } }),
          h('input', { type: 'time', value: hora, 'aria-label': 'Horário', onChange: function (e) { setHora(e.target.value); } })),
        erro && h('div', { className: 'erro', role: 'alert' }, erro),
        mapa && mapa.length === 0 && h(K.EmptyState, null, 'Cadastre um salão na aba Configuração antes de reservar mesa.'),
        mapa && mapa.map(function (a) {
          return h('div', { key: a.ambiente }, h('div', { className: 'rotulo', style: { marginBottom: 8 } }, a.ambiente),
            h('div', { className: 'mesas' }, a.mesas.map(function (m) {
              return h('button', { key: m.id, type: 'button', className: 'mesa', 'data-situacao': m.situacao, 'aria-pressed': String(sel === m.id), onClick: function () { setSel(m.id); } },
                h('b', null, m.id), m.capacidade + ' lugares · ' + (m.situacao === 'reservada' ? 'reservada' : 'livre'));
            })));
        })),
      h('aside', { className: 'painel k1-stack' },
        h('h2', null, 'Detalhe da mesa'),
        !mesa && h(K.EmptyState, null, 'Selecione uma mesa.'),
        mesa && h('div', { className: 'k1-stack' },
          h('div', { className: 'mono', style: { fontSize: 20, fontWeight: 700 } }, mesa.id),
          h('div', null, mesa.ambiente + ' · ' + mesa.capacidade + ' lugares'),
          mesa.reserva
            ? h('div', { className: 'k1-stack' }, h('span', { className: 'k1-pill k1-pill-concluida' }, 'Confirmada'),
              h('div', null, 'Horário: ', h('b', { className: 'mono' }, mesa.reserva.horario)), h('div', null, 'Pessoas: ', h('b', { className: 'mono' }, mesa.reserva.pessoas)),
              h('div', null, 'Situação: ', h('b', null, mesa.reserva.status)),
              mesa.reserva.nomeCliente && h('div', null, 'Cliente: ', h('b', null, mesa.reserva.nomeCliente)),
              mesa.reserva.contato && h('div', null, 'Contato: ', h('b', { className: 'mono' }, mesa.reserva.contato)))
            : h('div', null, 'Livre neste horário.'))));
  }

  // Mensagem do 409 de remoção: lista as reservas ativas que impedem a operação.
  function textoConflito(e, oQue) {
    var lista = e.dados && Array.isArray(e.dados.reservas) ? e.dados.reservas : [];
    var plural = lista.length > 1;
    return 'Não dá para remover ' + oQue + ': há reserva' + (plural ? 's' : '') + ' ativa' + (plural ? 's' : '')
      + (lista.length ? ' (' + lista.map(function (x) { return '#' + (x && typeof x === 'object' ? x.id : x); }).join(', ') + ')' : '')
      + '. Cancele ' + (plural ? 'essas reservas' : 'a reserva') + ' na aba Reservas e tente de novo.';
  }

  function LinhaMesa(p) {
    var m = p.mesa;
    var sc = useState(String(m.capacidade)), cap = sc[0], setCap = sc[1];
    var se = useState(''), msg = se[0], setMsg = se[1];
    var sr = useState(false), confRemover = sr[0], setConfRemover = sr[1];
    var conflito = msg.indexOf('Não dá para remover') === 0;
    function salvar(corpo) {
      api(p.token, 'PATCH', '/empresas/' + encodeURIComponent(p.empresa) + '/mesas/' + encodeURIComponent(m.id), corpo)
        .then(function () { setMsg('Salvo.'); p.recarregar(); }).catch(function (e) { setMsg(e.message); });
    }
    function remover() {
      api(p.token, 'DELETE', '/empresas/' + encodeURIComponent(p.empresa) + '/mesas/' + encodeURIComponent(m.id))
        .then(function () { p.recarregar(); })
        .catch(function (e) { setConfRemover(false); setMsg(e.status === 409 ? textoConflito(e, 'a mesa ' + m.id) : e.message); });
    }
    return h('div', { className: 'k1-stack', style: { gap: 4 } },
      h('div', { className: 'k1-row', style: { padding: '6px 0' } },
        h('b', { className: 'mono', style: { minWidth: 90 } }, m.id),
        h('label', { className: 'k1-row' }, 'Lugares', h('input', { type: 'number', min: 1, max: 100, value: cap, style: { width: 72 }, onChange: function (e) { setCap(e.target.value); } })),
        h(K.Button, { variant: 'secondary', onClick: function () { salvar({ capacidade: Number(cap) }); } }, 'Salvar'),
        h(K.Button, { variant: m.reservavel ? 'neutral' : 'primary', onClick: function () { salvar({ reservavel: !m.reservavel }); } }, m.reservavel ? 'Bloquear reservas' : 'Liberar reservas'),
        !confRemover && h(K.Button, { variant: 'danger', 'aria-label': 'Remover a mesa ' + m.id, onClick: function () { setMsg(''); setConfRemover(true); } }, 'Remover mesa'),
        !conflito && h('span', { className: 'rotulo' }, msg)),
      confRemover && h('div', { className: 'k1-row', role: 'alert' },
        h('span', null, 'Remover a mesa ' + m.id + '? Reservas canceladas ou passadas ficam sem mesa e continuam no histórico.'),
        h(K.Button, { variant: 'danger', onClick: remover }, 'Confirmar remoção'),
        h(K.Button, { variant: 'ghost', onClick: function () { setConfRemover(false); } }, 'Cancelar')),
      conflito && h('div', { className: 'erro', role: 'alert' }, msg));
  }

  // Cabeçalho do ambiente: nome, renomear e remover (tudo na própria tela).
  function CabecalhoAmbiente(p) {
    var a = p.ambiente, idAmb = a.id !== undefined ? a.id : a.nome;
    var base = '/empresas/' + encodeURIComponent(p.empresa) + '/ambientes/' + encodeURIComponent(idAmb);
    var sm = useState('ver'), modo = sm[0], setModo = sm[1]; // ver | renomear | remover
    var sn = useState(a.nome), nome = sn[0], setNome = sn[1];
    var se = useState(''), msg = se[0], setMsg = se[1];
    function renomear(ev) {
      ev.preventDefault();
      api(p.token, 'PATCH', base, { nome: nome.trim() })
        .then(function () { setModo('ver'); setMsg(''); p.recarregar(); })
        .catch(function (e) { setMsg(e.status === 409 ? 'Já existe um ambiente com esse nome.' : e.message); });
    }
    function remover() {
      api(p.token, 'DELETE', base)
        .then(function () { p.recarregar(); })
        .catch(function (e) { setModo('ver'); setMsg(e.status === 409 ? textoConflito(e, 'o ambiente ' + a.nome) : e.message); });
    }
    return h('div', { className: 'k1-stack', style: { gap: 6, margin: '8px 0 4px' } },
      h('div', { className: 'k1-row' },
        h('div', { className: 'rotulo' }, a.nome),
        modo === 'ver' && h(K.Button, { variant: 'secondary', 'aria-label': 'Renomear o ambiente ' + a.nome, onClick: function () { setNome(a.nome); setMsg(''); setModo('renomear'); } }, 'Renomear'),
        modo === 'ver' && h(K.Button, { variant: 'danger', 'aria-label': 'Remover o ambiente ' + a.nome, onClick: function () { setMsg(''); setModo('remover'); } }, 'Remover ambiente')),
      modo === 'renomear' && h('form', { className: 'k1-row', onSubmit: renomear },
        h('input', { type: 'text', value: nome, maxLength: 60, 'aria-label': 'Novo nome do ambiente ' + a.nome, style: { minWidth: 220 }, onChange: function (e) { setNome(e.target.value); setMsg(''); } }),
        h(K.Button, { type: 'submit', disabled: !nome.trim() || nome.trim() === a.nome }, 'Salvar nome'),
        h(K.Button, { variant: 'ghost', onClick: function () { setModo('ver'); setMsg(''); } }, 'Cancelar')),
      modo === 'remover' && h('div', { className: 'k1-row', role: 'alert' },
        h('span', null, 'Remover o ambiente ' + a.nome + (a.mesas.length ? ' e as ' + a.mesas.length + ' mesa(s) dele' : '') + '? Se houver reserva ativa em alguma mesa, nada é removido.'),
        h(K.Button, { variant: 'danger', onClick: remover }, 'Confirmar remoção'),
        h(K.Button, { variant: 'ghost', onClick: function () { setModo('ver'); } }, 'Cancelar')),
      msg && h('div', { className: 'erro', role: 'alert' }, msg));
  }

  function NomeEmpresa(p) {
    var sv = useState(p.nome), v = sv[0], setV = sv[1];
    var sm = useState(''), msg = sm[0], setMsg = sm[1];
    var mudou = v.trim() !== p.nome;
    function salvar() {
      api(p.token, 'PATCH', '/empresas/' + encodeURIComponent(p.empresa), { nome: v })
        .then(function (r) { setMsg('Nome salvo.'); setV(r.nome); p.aoRenomear(); })
        .catch(function (e) { setMsg(e.message); });
    }
    return h('div', { className: 'k1-stack', style: { borderBottom: '1px solid var(--border)', paddingBottom: 16 } },
      h('label', { className: 'campo' }, h('span', { className: 'rotulo' }, 'Nome da empresa'),
        h('div', { className: 'k1-row' },
          h('input', { type: 'text', value: v, maxLength: 60, 'aria-label': 'Nome da empresa', style: { minWidth: 280 }, onChange: function (e) { setV(e.target.value); setMsg(''); } }),
          h(K.Button, { disabled: !mudou || !v.trim(), onClick: salvar }, 'Salvar nome'),
          msg && h('span', { className: msg === 'Nome salvo.' ? 'rotulo' : 'erro', role: 'status' }, msg))));
  }

  function NovoAmbiente(p) {
    var sv = useState(''), v = sv[0], setV = sv[1];
    var sm = useState(''), msg = sm[0], setMsg = sm[1];
    function criar() {
      api(p.token, 'POST', '/empresas/' + encodeURIComponent(p.empresa) + '/ambientes', { nome: v })
        .then(function () { setV(''); setMsg(''); p.recarregar(); }).catch(function (e) { setMsg(e.message); });
    }
    return h('div', { className: 'k1-row' },
      h('input', { type: 'text', value: v, maxLength: 40, placeholder: 'Ex.: Salão, Varanda, Área externa', 'aria-label': 'Nome do novo ambiente', style: { minWidth: 260 }, onChange: function (e) { setV(e.target.value); setMsg(''); } }),
      h(K.Button, { disabled: !v.trim(), onClick: criar }, '+ Novo ambiente'),
      msg && h('span', { className: 'erro', role: 'alert' }, msg));
  }

  function NovaMesa(p) {
    var sv = useState('4'), cap = sv[0], setCap = sv[1];
    var sm = useState(''), msg = sm[0], setMsg = sm[1];
    function criar() {
      api(p.token, 'POST', '/empresas/' + encodeURIComponent(p.empresa) + '/mesas', { ambiente: p.ambiente, capacidade: Number(cap) })
        .then(function () { setMsg(''); p.recarregar(); }).catch(function (e) { setMsg(e.message); });
    }
    return h('div', { className: 'k1-row', style: { padding: '6px 0' } },
      h('label', { className: 'k1-row' }, 'Lugares', h('input', { type: 'number', min: 1, max: 100, value: cap, style: { width: 72 }, 'aria-label': 'Lugares da nova mesa em ' + p.ambiente, onChange: function (e) { setCap(e.target.value); } })),
      h(K.Button, { variant: 'secondary', onClick: criar }, '+ Nova mesa'),
      msg && h('span', { className: 'erro', role: 'alert' }, msg));
  }

  function ExcluirEmpresa(p) {
    var sa = useState(false), aberto = sa[0], setAberto = sa[1];
    var sc = useState(''), confirmar = sc[0], setConfirmar = sc[1];
    var ss = useState(''), senha = ss[0], setSenha = ss[1];
    var sm = useState(''), msg = sm[0], setMsg = sm[1];
    var se = useState(false), enviando = se[0], setEnviando = se[1];
    function fechar() { setAberto(false); setConfirmar(''); setSenha(''); setMsg(''); }
    function excluir(ev) {
      ev.preventDefault();
      setEnviando(true);
      api(p.token, 'POST', '/empresas/' + encodeURIComponent(p.empresa) + '/excluir', { senha: senha, confirmarNome: confirmar })
        .then(function () { setSenha(''); p.aoExcluir(); })
        .catch(function (e) { setSenha(''); setMsg(e.status === 403 && /senha/.test(e.message) ? 'Senha do administrador incorreta.' : e.message); })
        .then(function () { setEnviando(false); });
    }
    return h('div', { className: 'k1-stack', style: { borderTop: '1px solid var(--border)', paddingTop: 16, marginTop: 8 } },
      h('div', { className: 'rotulo', style: { color: 'var(--danger)' } }, 'Zona de risco'),
      !aberto && h('div', null, h(K.Button, { variant: 'danger', onClick: function () { setAberto(true); } }, 'Excluir empresa…')),
      aberto && h('form', { className: 'k1-stack', onSubmit: excluir },
        h('div', null, 'Excluir ', h('b', null, p.nome), ' apaga o agente, os ambientes, as mesas, as reservas e a chave de API. ', h('b', null, 'Não dá para desfazer.'), ' Fica um registro completo no histórico.'),
        h('label', { className: 'campo' }, h('span', { className: 'rotulo' }, 'Digite o nome da empresa para confirmar'),
          h('input', { type: 'text', value: confirmar, autoComplete: 'off', 'aria-label': 'Nome da empresa para confirmar a exclusão', onChange: function (e) { setConfirmar(e.target.value); setMsg(''); } })),
        h('label', { className: 'campo' }, h('span', { className: 'rotulo' }, 'Senha do administrador'),
          h('input', { type: 'password', value: senha, autoComplete: 'off', 'aria-label': 'Senha do administrador', onChange: function (e) { setSenha(e.target.value); setMsg(''); } })),
        msg && h('div', { className: 'erro', role: 'alert' }, msg),
        h('div', { className: 'k1-row' },
          h(K.Button, { type: 'submit', variant: 'danger', disabled: enviando || confirmar !== p.nome || !senha }, enviando ? 'Excluindo…' : 'Excluir empresa definitivamente'),
          h(K.Button, { variant: 'ghost', onClick: fechar }, 'Cancelar'))));
  }

  function RecursosEmpresa(p) {
    var sm = useState(''), msg = sm[0], setMsg = sm[1];
    function mudar(chave, valor) {
      var corpo = {}; corpo[chave] = valor;
      api(p.token, 'PATCH', '/empresas/' + encodeURIComponent(p.empresa) + '/modulos', corpo)
        .then(function () { setMsg('Salvo.'); p.aoMudar(); }).catch(function (e) { setMsg(e.message); });
    }
    function opcao(chave, titulo, desc) {
      return h('label', { key: chave, className: 'k1-row', style: { alignItems: 'flex-start', gap: 10, flexWrap: 'nowrap' } },
        h('input', { type: 'checkbox', checked: p.modulos[chave] !== false, style: { marginTop: 4 }, onChange: function (e) { mudar(chave, e.target.checked); } }),
        h('span', null, h('b', null, titulo), h('br'), h('span', { style: { color: 'var(--ink-muted)', fontSize: 13 } }, desc)));
    }
    return h('div', { className: 'k1-stack', style: { borderBottom: '1px solid var(--border)', paddingBottom: 16 } },
      h('div', { className: 'rotulo' }, 'Recursos desta empresa'),
      opcao('reservas', 'Reservas e mapa de mesas', 'Para negócios com mesas. Desligado, somem as abas Reservas e Mapa de mesas e a API deixa de oferecer disponibilidade e reservas.'),
      opcao('conhecimento', 'Base de conhecimento', 'Tabelas de preços, textos e documentos que o sistema de conversa lê pela API.'),
      h('div', { style: { color: 'var(--ink-muted)', fontSize: 12 } }, 'Desligar um recurso não apaga nada: os dados ficam guardados e voltam quando ele for ligado de novo.'),
      msg && h('div', { className: msg === 'Salvo.' ? 'rotulo' : 'erro', role: 'status' }, msg));
  }

  function Configuracao(p) {
    var s = useState(null), est = s[0], setEst = s[1];
    var se = useState(''), erro = se[0], setErro = se[1];
    var carregar = useCallback(function () {
      api(p.token, 'GET', '/empresas/' + encodeURIComponent(p.empresa) + '/estrutura').then(setEst).catch(function (e) { setErro(e.message); });
    }, [p.empresa, p.token]);
    useEffect(function () { setEst(null); carregar(); }, [carregar]);
    var reservasOn = !!est && !(est.modulos && est.modulos.reservas === false);
    return h('section', { className: 'painel k1-stack' },
      h('h2', null, 'Configuração · ' + (est && !reservasOn ? 'Empresa' : 'Empresa → Ambiente → Mesa')),
      est && h(NomeEmpresa, { key: est.nome, nome: est.nome, token: p.token, empresa: p.empresa, aoRenomear: p.aoRenomear }),
      est && h(RecursosEmpresa, { modulos: est.modulos || {}, token: p.token, empresa: p.empresa, aoMudar: function () { carregar(); p.aoRenomear(); } }),
      erro && h('div', { className: 'erro', role: 'alert' }, erro),
      reservasOn && est.ambientes.length === 0 && h(K.EmptyState, null, 'Nenhum ambiente cadastrado. Crie o primeiro abaixo para poder cadastrar mesas e receber reservas.'),
      reservasOn && est.ambientes.map(function (a) {
        return h('div', { key: a.nome }, h(CabecalhoAmbiente, { ambiente: a, token: p.token, empresa: p.empresa, recarregar: carregar }),
          a.mesas.map(function (m) { return h(LinhaMesa, { key: m.id + m.capacidade + m.reservavel, mesa: m, token: p.token, empresa: p.empresa, recarregar: carregar }); }),
          h(NovaMesa, { key: 'nova-' + a.nome + a.mesas.length, ambiente: a.nome, token: p.token, empresa: p.empresa, recarregar: carregar }));
      }),
      reservasOn && h(NovoAmbiente, { token: p.token, empresa: p.empresa, recarregar: carregar }),
      est && h(ExcluirEmpresa, { key: 'ex-' + p.empresa, nome: est.nome, token: p.token, empresa: p.empresa, aoExcluir: p.aoExcluir }));
  }

  var CAMPOS = [
    { id: 'nome', rotulo: 'Nome do agente', limite: 100, curto: true, dica: 'Como o agente se apresenta aos clientes desta empresa.' },
    { id: 'descricao', rotulo: 'Descrição', limite: 1000, dica: 'O que é a empresa, o que oferece e o que a diferencia.' },
    { id: 'personalidade', rotulo: 'Personalidade e Objetivo da IA', limite: 2000, dica: 'Como o agente fala e qual é a meta dele nas conversas.' },
    { id: 'habilidades', rotulo: 'Habilidades', limite: 22000, dica: 'Tudo o que o agente sabe fazer e como deve agir em cada situação.' },
    { id: 'produtos', rotulo: 'Informações sobre Produtos e Serviços', limite: 22000, dica: 'Cardápio, preços, horários, serviços e o que mais o agente precisa saber.' },
    { id: 'restricoes', rotulo: 'Restrições', limite: 2000, dica: 'O que o agente nunca deve fazer ou prometer.' },
  ];

  function contar(s) { return Array.from(s || '').length; }

  // Caixa de texto que cresce junto com o conteúdo, sem barra de rolagem interna.
  function CaixaTexto(p) {
    var ref = R.useRef(null);
    R.useLayoutEffect(function () {
      var el = ref.current;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 2 + 'px';
    }, [p.value]);
    return h('textarea', { ref: ref, value: p.value, 'aria-label': p.rotulo, rows: 3, onChange: function (e) { p.onChange(e.target.value); }, style: { resize: 'none', overflow: 'hidden' } });
  }

  function Agentes(p) {
    var ss = useState(null), salvo = ss[0], setSalvo = ss[1];
    var sr = useState({}), rasc = sr[0], setRasc = sr[1];
    var sm = useState({ tipo: '', texto: '' }), msg = sm[0], setMsg = sm[1];
    var sg = useState(false), gravando = sg[0], setGravando = sg[1];
    useEffect(function () {
      setSalvo(null);
      api(p.token, 'GET', '/empresas/' + encodeURIComponent(p.empresa) + '/agente').then(function (c) { setSalvo(c); setRasc(Object.assign({}, c)); setMsg({ tipo: '', texto: '' }); })
        .catch(function (e) { setMsg({ tipo: 'erro', texto: e.message }); });
    }, [p.empresa, p.token]);

    var alterados = salvo ? CAMPOS.filter(function (c) { return rasc[c.id] !== salvo[c.id]; }) : [];
    var estourou = CAMPOS.filter(function (c) { return contar(rasc[c.id]) > c.limite; });
    var pode = alterados.length > 0 && estourou.length === 0 && !gravando;

    function salvarTudo() {
      var campos = {};
      alterados.forEach(function (c) { campos[c.id] = rasc[c.id]; });
      setGravando(true);
      api(p.token, 'PATCH', '/empresas/' + encodeURIComponent(p.empresa) + '/agente', { campos: campos })
        .then(function (cfg) {
          setSalvo(cfg); setRasc(Object.assign({}, cfg));
          setMsg({ tipo: 'ok', texto: alterados.length === 1 ? 'Salvo. 1 campo atualizado.' : 'Salvo. ' + alterados.length + ' campos atualizados.' });
        })
        .catch(function (e) { setMsg({ tipo: 'erro', texto: e.status === 403 ? 'Algum campo alterado não pode ser editado pela equipe da empresa. ' + e.message : e.message }); })
        .then(function () { setGravando(false); });
    }
    function descartar() { setRasc(Object.assign({}, salvo)); setMsg({ tipo: '', texto: '' }); }

    return h('section', { className: 'painel k1-stack' },
      h('h2', null, 'Atendimento · Agentes'),
      !salvo && !msg.texto && h(K.EmptyState, null, 'Carregando…'),
      salvo && CAMPOS.map(function (c) {
        var n = contar(rasc[c.id]), acima = n > c.limite, mudou = rasc[c.id] !== salvo[c.id];
        return h('div', { key: c.id, className: 'campo' },
          h('div', { className: 'k1-row', style: { justifyContent: 'space-between' } },
            h('span', { className: 'rotulo' }, c.rotulo + (mudou ? ' · alterado' : '')),
            h('span', { className: 'mono', style: { fontSize: 12, color: acima ? 'var(--danger)' : 'var(--ink-muted)' }, 'aria-live': 'polite' }, n.toLocaleString('pt-BR') + ' / ' + c.limite.toLocaleString('pt-BR'))),
          h('span', { style: { fontSize: 12, color: 'var(--ink-muted)' } }, c.dica),
          c.curto
            ? h('input', { type: 'text', value: rasc[c.id] || '', 'aria-label': c.rotulo, onChange: function (e) { var r = Object.assign({}, rasc); r[c.id] = e.target.value; setRasc(r); setMsg({ tipo: '', texto: '' }); } })
            : h(CaixaTexto, { value: rasc[c.id] || '', rotulo: c.rotulo, onChange: function (v) { var r = Object.assign({}, rasc); r[c.id] = v; setRasc(r); setMsg({ tipo: '', texto: '' }); } }),
          acima && h('div', { className: 'erro', role: 'alert' }, 'Passou ' + (n - c.limite).toLocaleString('pt-BR') + ' caractere(s) do limite.'));
      }),
      salvo && h('div', { className: 'k1-row', style: { position: 'sticky', bottom: 0, background: 'var(--surface-card)', padding: '12px 0', borderTop: '1px solid var(--border)' } },
        h(K.Button, { disabled: !pode, onClick: salvarTudo }, gravando ? 'Salvando…' : 'Salvar alterações'),
        h(K.Button, { variant: 'ghost', disabled: alterados.length === 0 || gravando, onClick: descartar }, 'Descartar'),
        h('span', { className: msg.tipo === 'erro' ? 'erro' : 'rotulo', role: msg.tipo === 'erro' ? 'alert' : 'status' },
          msg.texto || (estourou.length ? 'Reduza o texto dos campos em vermelho para salvar.' : alterados.length ? alterados.length + ' campo(s) com alteração não salva' : ''))));
  }

  var ROTULO = { criada: 'Criada', editada: 'Editada', cancelada: 'Cancelada', reativada: 'Reativada', desfeita: 'Desfeita', chave_gerada: 'Chave gerada', chave_revogada: 'Chave revogada', excluida: 'Excluída', exclusao_negada: 'Exclusão negada' };
  function objeto(e) {
    return e.entidade === 'reserva' ? 'Reserva #' + e.entidadeId : e.entidade === 'mesa' ? 'Mesa ' + e.entidadeId : e.entidade === 'empresa' ? 'Empresa' : e.entidade === 'conhecimento' ? 'Conhecimento #' + e.entidadeId : e.entidade === 'ambiente' ? 'Ambiente ' + e.entidadeId : e.entidade === 'api' ? 'Chave da API' : e.entidade === 'empresa' ? 'Empresa' : 'Agente · ' + e.entidadeId;
  }
  var PAPEL = { chat: 'Chat do agente', cliente: 'Equipe da empresa', integracao: 'Equipe de integração' };
  function quandoBr(iso) {
    var d = new Date(iso);
    return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
  }
  function mudancas(e) {
    var ks = Object.keys(e.depois || {});
    function curto(v) { var s = JSON.stringify(v); return s && s.length > 80 ? s.slice(0, 77) + '…"' : s; }
    return ks.map(function (k) { return k + ': ' + (e.antes && k in e.antes ? curto(e.antes[k]) : '—') + ' → ' + curto(e.depois[k]); }).join(' · ');
  }

  function Historico(p) {
    var sl = useState(null), lista = sl[0], setLista = sl[1];
    var se = useState(''), msg = se[0], setMsg = se[1];
    var sr = useState(0), recarga = sr[0], setRecarga = sr[1];
    var sx = useState([]), excluidas = sx[0], setExcluidas = sx[1];
    useEffect(function () { api(p.token, 'GET', '/historico/excluidas').then(setExcluidas).catch(function () { setExcluidas([]); }); }, [p.token]);
    useEffect(function () {
      api(p.token, 'GET', '/empresas/' + encodeURIComponent(p.empresa) + '/historico').then(setLista).catch(function (e) { setMsg(e.message); });
    }, [p.empresa, p.token, recarga]);
    function desfazer(seq) {
      api(p.token, 'POST', '/empresas/' + encodeURIComponent(p.empresa) + '/historico/' + seq + '/desfazer')
        .then(function () { setMsg('Ação desfeita e registrada.'); setRecarga(recarga + 1); })
        .catch(function (e) { setMsg(e.status === 409 ? (e.message || 'Não foi possível desfazer.') : e.message); });
    }
    var desfeitos = {};
    (lista || []).forEach(function (e) { if (e.acao === 'desfeita') desfeitos[e.refSeq] = true; });
    return h('section', { className: 'painel k1-stack' },
      h('h2', null, 'Histórico de modificações'),
      h('div', { className: 'rotulo' }, 'Nada é apagado. Desfazer cria um novo registro.'),
      msg && h('div', { role: 'status', className: /desfeita/.test(msg) ? 'rotulo' : 'erro' }, msg),
      lista && lista.length === 0 && h(K.EmptyState, null, 'Nenhuma modificação registrada ainda.'),
      lista && lista.length > 0 && h('table', null,
        h('thead', null, h('tr', null, ['#', 'Quando', 'Quem', 'O quê', 'Mudança', ''].map(function (c, i) { return h('th', { key: i }, c); }))),
        h('tbody', null, lista.map(function (e) {
          return h('tr', { key: e.seq },
            h('td', { className: 'mono' }, e.seq),
            h('td', { className: 'mono' }, quandoBr(e.quando)),
            h('td', null, (e.operador ? e.operador + ' · ' : '') + (PAPEL[e.papel] || e.papel)),
            h('td', null, objeto(e) + ' · ' + (ROTULO[e.acao] || e.acao) + (e.refSeq ? ' (#' + e.refSeq + ')' : '')),
            h('td', { className: 'mono', style: { fontSize: 12 } }, e.acao === 'excluida' && e.entidade === 'conhecimento' ? 'removido: ' + e.antes.titulo : e.acao === 'criada' && e.entidade === 'reserva' ? 'pessoas ' + e.depois.pessoas + ', ' + e.depois.data + ' ' + e.depois.horario + ', ' + e.depois.mesaId : mudancas(e)),
            h('td', null, e.entidade === 'reserva' && !desfeitos[e.seq] && h(K.Button, { variant: 'secondary', onClick: function () { desfazer(e.seq); } }, 'Desfazer')));
        }))),
      excluidas.length > 0 && h('div', { className: 'k1-stack', style: { borderTop: '1px solid var(--border)', paddingTop: 16 } },
        h('h2', null, 'Empresas excluídas'),
        h('div', { className: 'rotulo' }, 'O conteúdo completo de cada uma ficou gravado no registro de auditoria.'),
        h('table', null,
          h('thead', null, h('tr', null, ['#', 'Quando', 'Quem', 'Empresa', 'Continha'].map(function (c) { return h('th', { key: c }, c); }))),
          h('tbody', null, excluidas.map(function (x) {
            return h('tr', { key: x.seq }, h('td', { className: 'mono' }, x.seq), h('td', { className: 'mono' }, quandoBr(x.quando)),
              h('td', null, (x.operador ? x.operador + ' · ' : '') + (PAPEL[x.papel] || x.papel)), h('td', null, x.nome),
              h('td', { className: 'mono', style: { fontSize: 12 } }, x.ambientes + ' ambiente(s), ' + x.mesas + ' mesa(s), ' + x.reservas + ' reserva(s)'));
          })))));
  }

  var TIPO_ROTULO = { texto: 'Texto', tabela: 'Tabela', documento: 'Documento' };
  var EXT_OK = ['txt', 'md', 'csv', 'pdf', 'docx', 'xlsx'];

  function paraBase64(buf) {
    var bin = '', bytes = new Uint8Array(buf), passo = 0x8000;
    for (var i = 0; i < bytes.length; i += passo) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + passo));
    return btoa(bin);
  }
  function tamanhoBr(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1).replace('.', ',') + ' KB' : (n / 1048576).toFixed(1).replace('.', ',') + ' MB'; }
  function baixar(token, caminho, nome, aoErro) {
    fetch(BASE + caminho, { headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) { if (!r.ok) throw new Error('Não foi possível baixar (' + r.status + ').'); return r.blob(); })
      .then(function (b) { var u = URL.createObjectURL(b), a = document.createElement('a'); a.href = u; a.download = nome; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(u); }, 1000); })
      .catch(function (e) { aoErro(e.message); });
  }
  // Planilha colada (Excel/Sheets usam TAB; CSV usa ; ou ,): a primeira linha vira os nomes das colunas.
  function lerPlanilha(txt) {
    var linhas = txt.replace(/\r/g, '').split('\n').filter(function (l) { return l.trim() !== ''; });
    if (!linhas.length) return null;
    var sep = linhas[0].indexOf('\t') >= 0 ? '\t' : linhas[0].indexOf(';') >= 0 ? ';' : ',';
    var m = linhas.map(function (l) { return l.split(sep).map(function (c) { return c.trim(); }); });
    var n = m[0].length;
    return { colunas: m[0], linhas: m.slice(1).map(function (l) { var r = l.slice(0, n); while (r.length < n) r.push(''); return r; }) };
  }

  function EditorConhecimento(p) {
    var item = p.item, tipo = item ? item.tipo : p.tipo;
    var st = useState(item ? item.titulo : ''), titulo = st[0], setTitulo = st[1];
    var sx = useState(item && tipo === 'texto' ? item.texto : ''), texto = sx[0], setTexto = sx[1];
    var sb = useState(item && item.tabela ? { colunas: item.tabela.colunas.slice(), linhas: item.tabela.linhas.map(function (r) { return r.slice(); }) } : { colunas: ['Item', 'Preço'], linhas: [['', '']] }), tab = sb[0], setTab = sb[1];
    var sa = useState(null), arq = sa[0], setArq = sa[1];
    var sc = useState(''), colar = sc[0], setColar = sc[1];
    var sm = useState(''), msg = sm[0], setMsg = sm[1];
    var sg = useState(false), gravando = sg[0], setGravando = sg[1];
    var base = '/empresas/' + encodeURIComponent(p.empresa) + '/conhecimento';
    var passou = (tipo === 'texto' && contar(texto) > 50000) || contar(titulo) > 120;

    function setCelula(i, j, v) { var l = tab.linhas.map(function (r) { return r.slice(); }); l[i][j] = v; setTab({ colunas: tab.colunas, linhas: l }); }
    function setColuna(j, v) { var c = tab.colunas.slice(); c[j] = v; setTab({ colunas: c, linhas: tab.linhas }); }
    function addLinha() { setTab({ colunas: tab.colunas, linhas: tab.linhas.concat([tab.colunas.map(function () { return ''; })]) }); }
    function delLinha(i) { setTab({ colunas: tab.colunas, linhas: tab.linhas.filter(function (_, k) { return k !== i; }) }); }
    function addColuna() { setTab({ colunas: tab.colunas.concat(['Coluna ' + (tab.colunas.length + 1)]), linhas: tab.linhas.map(function (r) { return r.concat(['']); }) }); }
    function delColuna(j) { setTab({ colunas: tab.colunas.filter(function (_, k) { return k !== j; }), linhas: tab.linhas.map(function (r) { return r.filter(function (_, k) { return k !== j; }); }) }); }
    function aplicarColar() {
      var r = lerPlanilha(colar);
      if (!r) { setMsg('Cole as células da planilha (a primeira linha vira os nomes das colunas).'); return; }
      setTab(r); setColar(''); setMsg('');
    }
    function escolher(ev) {
      var f = ev.target.files && ev.target.files[0];
      if (!f) return;
      var ext = (f.name.indexOf('.') >= 0 ? f.name.split('.').pop() : '').toLowerCase();
      if (EXT_OK.indexOf(ext) < 0) { setMsg('Tipo não permitido. Use ' + EXT_OK.join(', ') + '.'); ev.target.value = ''; return; }
      if (f.size > 4 * 1024 * 1024) { setMsg('O arquivo passa de 4 MB.'); ev.target.value = ''; return; }
      var fr = new FileReader();
      fr.onload = function () { setArq({ nome: f.name, base64: paraBase64(fr.result), tamanho: f.size }); setMsg(''); };
      fr.onerror = function () { setMsg('Não foi possível ler o arquivo.'); };
      fr.readAsArrayBuffer(f);
    }
    function salvar() {
      var corpo = item ? {} : { tipo: tipo };
      if (!item || titulo.trim() !== item.titulo) corpo.titulo = titulo.trim();
      if (tipo === 'texto' && (!item || texto !== item.texto)) corpo.texto = texto;
      if (tipo === 'tabela' && (!item || JSON.stringify(tab) !== JSON.stringify(item.tabela))) corpo.tabela = tab;
      if (tipo === 'documento' && arq) corpo.arquivo = { nome: arq.nome, base64: arq.base64 };
      if (tipo === 'documento' && !item && !arq) { setMsg('Escolha o arquivo do documento.'); return; }
      if (item && Object.keys(corpo).length === 0) { setMsg('Nada foi alterado.'); return; }
      setGravando(true);
      api(p.token, item ? 'PATCH' : 'POST', item ? base + '/' + item.id : base, corpo)
        .then(function () { p.aoSalvar(); })
        .catch(function (e) { setMsg(e.message); setGravando(false); });
    }

    return h('div', { className: 'item k1-stack' },
      h('div', { className: 'rotulo' }, (item ? 'Editar ' : 'Novo ') + TIPO_ROTULO[tipo].toLowerCase()),
      h('label', { className: 'campo' },
        h('div', { className: 'k1-row', style: { justifyContent: 'space-between' } }, h('span', { className: 'rotulo' }, 'Título'), h('span', { className: 'mono', style: { fontSize: 12, color: contar(titulo) > 120 ? 'var(--danger)' : 'var(--ink-muted)' } }, contar(titulo) + ' / 120')),
        h('input', { type: 'text', value: titulo, placeholder: tipo === 'tabela' ? 'Ex.: Tabela de preços' : 'Ex.: Horário de funcionamento', 'aria-label': 'Título', onChange: function (e) { setTitulo(e.target.value); setMsg(''); } })),
      tipo === 'texto' && h('div', { className: 'campo' },
        h('div', { className: 'k1-row', style: { justifyContent: 'space-between' } }, h('span', { className: 'rotulo' }, 'Texto'), h('span', { className: 'mono', style: { fontSize: 12, color: contar(texto) > 50000 ? 'var(--danger)' : 'var(--ink-muted)' } }, contar(texto).toLocaleString('pt-BR') + ' / 50.000')),
        h(CaixaTexto, { value: texto, rotulo: 'Texto', onChange: function (v) { setTexto(v); setMsg(''); } })),
      tipo === 'tabela' && h('div', { className: 'k1-stack' },
        h('div', { className: 'grade-edicao' }, h('table', null,
          h('thead', null, h('tr', null, tab.colunas.map(function (c, j) {
            return h('th', { key: j }, h('div', { className: 'k1-row', style: { flexWrap: 'nowrap', gap: 4 } },
              h('input', { type: 'text', value: c, 'aria-label': 'Nome da coluna ' + (j + 1), onChange: function (e) { setColuna(j, e.target.value); } }),
              h(K.Button, { variant: 'ghost', disabled: tab.colunas.length <= 1, 'aria-label': 'Remover coluna ' + (j + 1), onClick: function () { delColuna(j); } }, '×')));
          }).concat([h('th', { key: 'acao' })]))),
          h('tbody', null, tab.linhas.map(function (l, i) {
            return h('tr', { key: i }, l.map(function (c, j) { return h('td', { key: j }, h('input', { type: 'text', value: c, 'aria-label': 'Linha ' + (i + 1) + ', ' + (tab.colunas[j] || 'coluna ' + (j + 1)), onChange: function (e) { setCelula(i, j, e.target.value); } })); })
              .concat([h('td', { key: 'acao' }, h(K.Button, { variant: 'ghost', 'aria-label': 'Remover linha ' + (i + 1), onClick: function () { delLinha(i); } }, '×'))]));
          })))),
        h('div', { className: 'k1-row' }, h(K.Button, { variant: 'secondary', onClick: addLinha }, '+ Linha'), h(K.Button, { variant: 'secondary', onClick: addColuna, disabled: tab.colunas.length >= 20 }, '+ Coluna'),
          h('span', { className: 'rotulo' }, tab.linhas.length + ' linha(s) · ' + tab.colunas.length + ' coluna(s)')),
        h('details', null, h('summary', { style: { cursor: 'pointer', fontSize: 13 } }, 'Colar de uma planilha (Excel, Google Planilhas ou CSV)'),
          h('div', { className: 'k1-stack', style: { marginTop: 8 } },
            h('textarea', { value: colar, rows: 4, 'aria-label': 'Colar planilha', placeholder: 'Cole aqui. A primeira linha vira os nomes das colunas.', style: { width: '100%', boxSizing: 'border-box', font: '400 13px/20px var(--font-mono)', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--surface-card)', color: 'var(--ink)' }, onChange: function (e) { setColar(e.target.value); } }),
            h('div', null, h(K.Button, { variant: 'secondary', disabled: !colar.trim(), onClick: aplicarColar }, 'Aplicar (substitui a tabela)'))))),
      tipo === 'documento' && h('div', { className: 'k1-stack' },
        item && item.arquivo && !arq && h('div', null, 'Arquivo atual: ', h('b', null, item.arquivo.nome), ' · ' + tamanhoBr(item.arquivo.tamanho) + (item.texto !== undefined ? ' · o texto é lido pelo sistema de conversa' : ' · o sistema de conversa recebe o link para baixar')),
        arq && h('div', null, 'Novo arquivo: ', h('b', null, arq.nome), ' · ' + tamanhoBr(arq.tamanho)),
        h('label', { className: 'campo' }, h('span', { className: 'rotulo' }, item ? 'Substituir arquivo (opcional)' : 'Arquivo'),
          h('input', { type: 'file', accept: '.txt,.md,.csv,.pdf,.docx,.xlsx', 'aria-label': 'Arquivo do documento', onChange: escolher })),
        h('div', { style: { color: 'var(--ink-muted)', fontSize: 12 } }, 'Até 4 MB. Arquivos .txt, .md e .csv têm o texto lido direto pela API. PDF, Word e Excel ficam disponíveis para download.')),
      msg && h('div', { className: 'erro', role: 'alert' }, msg),
      h('div', { className: 'k1-row' },
        h(K.Button, { disabled: gravando || passou || !titulo.trim(), onClick: salvar }, gravando ? 'Salvando…' : 'Salvar'),
        h(K.Button, { variant: 'ghost', onClick: p.aoCancelar }, 'Cancelar')));
  }

  function ItemConhecimento(p) {
    var it = p.item;
    var sa = useState(false), confirmar = sa[0], setConfirmar = sa[1];
    var sm = useState(''), msg = sm[0], setMsg = sm[1];
    function excluir() {
      api(p.token, 'DELETE', '/empresas/' + encodeURIComponent(p.empresa) + '/conhecimento/' + it.id).then(p.aoMudar).catch(function (e) { setMsg(e.message); });
    }
    return h('div', { className: 'item k1-stack' },
      h('div', { className: 'k1-row', style: { justifyContent: 'space-between' } },
        h('div', { className: 'k1-row' }, h('b', null, it.titulo), h('span', { className: 'k1-pill k1-pill-pendente' }, TIPO_ROTULO[it.tipo]),
          h('span', { className: 'rotulo' }, 'atualizado em ' + new Date(it.atualizadoEm).toLocaleString('pt-BR'))),
        h('div', { className: 'k1-row' },
          h(K.Button, { variant: 'secondary', onClick: p.aoEditar }, 'Editar'),
          !confirmar && h(K.Button, { variant: 'danger', onClick: function () { setConfirmar(true); } }, 'Excluir'),
          confirmar && h(K.Button, { variant: 'danger', onClick: excluir }, 'Confirmar exclusão'),
          confirmar && h(K.Button, { variant: 'ghost', onClick: function () { setConfirmar(false); } }, 'Cancelar'))),
      it.tipo === 'texto' && h('div', { style: { whiteSpace: 'pre-wrap', color: 'var(--ink-muted)', fontSize: 13 } }, it.texto.length > 300 ? it.texto.slice(0, 300) + '…' : it.texto),
      it.tipo === 'tabela' && h('div', { className: 'grade-edicao' }, h('table', null,
        h('thead', null, h('tr', null, it.tabela.colunas.map(function (c, j) { return h('th', { key: j }, c); }))),
        h('tbody', null, it.tabela.linhas.slice(0, 8).map(function (l, i) { return h('tr', { key: i }, l.map(function (c, j) { return h('td', { key: j }, c); })); })))),
      it.tipo === 'tabela' && it.tabela.linhas.length > 8 && h('div', { className: 'rotulo' }, '… e mais ' + (it.tabela.linhas.length - 8) + ' linha(s)'),
      it.tipo === 'documento' && h('div', { className: 'k1-stack' },
        h('div', { className: 'k1-row' }, h('span', null, it.arquivo.nome + ' · ' + tamanhoBr(it.arquivo.tamanho)),
          h(K.Button, { variant: 'secondary', onClick: function () { baixar(p.token, it.arquivo.url, it.arquivo.nome, setMsg); } }, 'Baixar')),
        it.texto !== undefined && h('div', { style: { whiteSpace: 'pre-wrap', color: 'var(--ink-muted)', fontSize: 13 } }, it.texto.length > 300 ? it.texto.slice(0, 300) + '…' : it.texto)),
      msg && h('div', { className: 'erro', role: 'alert' }, msg));
  }

  function Conhecimento(p) {
    var si = useState(null), itens = si[0], setItens = si[1];
    var se = useState(''), erro = se[0], setErro = se[1];
    var sd = useState(null), editando = sd[0], setEditando = sd[1]; // { tipo } novo | { item } edição
    var sr = useState(0), recarga = sr[0], setRecarga = sr[1];
    useEffect(function () {
      api(p.token, 'GET', '/empresas/' + encodeURIComponent(p.empresa) + '/conhecimento').then(function (r) { setErro(''); setItens(r.itens); })
        .catch(function (e) { setErro(e.message); });
    }, [p.empresa, p.token, recarga]);
    function depois() { setEditando(null); setRecarga(recarga + 1); }
    return h('section', { className: 'painel k1-stack' },
      h('h2', null, 'Base de conhecimento'),
      h('div', { className: 'rotulo' }, 'O sistema de conversa lê tudo isto de uma vez pela API: GET /empresas/' + p.empresa + '/conhecimento'),
      h('div', { className: 'k1-row' },
        h(K.Button, { variant: 'secondary', onClick: function () { setEditando({ tipo: 'texto' }); } }, '+ Novo texto'),
        h(K.Button, { variant: 'secondary', onClick: function () { setEditando({ tipo: 'tabela' }); } }, '+ Nova tabela'),
        h(K.Button, { variant: 'secondary', onClick: function () { setEditando({ tipo: 'documento' }); } }, '+ Novo documento')),
      erro && h('div', { className: 'erro', role: 'alert' }, erro),
      editando && editando.tipo && h(EditorConhecimento, { key: 'novo-' + editando.tipo, tipo: editando.tipo, token: p.token, empresa: p.empresa, aoSalvar: depois, aoCancelar: function () { setEditando(null); } }),
      itens && itens.length === 0 && !editando && h(K.EmptyState, null, 'Nada cadastrado ainda. Adicione uma tabela de preços, um texto ou um documento para o agente consultar.'),
      itens && itens.map(function (it) {
        return editando && editando.item && editando.item.id === it.id
          ? h(EditorConhecimento, { key: 'ed-' + it.id, item: it, token: p.token, empresa: p.empresa, aoSalvar: depois, aoCancelar: function () { setEditando(null); } })
          : h(ItemConhecimento, { key: it.id + it.atualizadoEm, item: it, token: p.token, empresa: p.empresa, aoMudar: depois, aoEditar: function () { setEditando({ item: it }); } });
      }));
  }

  function Resultado(p) {
    return h('tr', null,
      h('td', null, h('span', { className: 'k1-pill k1-pill-' + (p.ok ? 'concluida' : 'pendente') }, p.ok ? 'OK' : 'Falhou')),
      h('td', null, p.titulo),
      h('td', { className: 'mono' }, p.status + ' · ' + p.ms + ' ms'),
      h('td', { style: { color: 'var(--ink-muted)' } }, p.detalhe));
  }

  function ApiEmpresa(p) {
    var sa = useState(null), st = sa[0], setSt = sa[1];
    var sb = useState(''), bloqueio = sb[0], setBloqueio = sb[1];
    var sn = useState(null), nova = sn[0], setNova = sn[1];
    var sc = useState(''), chaveTeste = sc[0], setChaveTeste = sc[1];
    var sr = useState(null), testes = sr[0], setTestes = sr[1];
    var se = useState(''), msg = se[0], setMsg = se[1];
    var sj = useState(null), amostra = sj[0], setAmostra = sj[1];
    var sf = useState(0), recarga = sf[0], setRecarga = sf[1];
    var so = useState(BASE || location.origin), origem = so[0], setOrigem = so[1];
    var sq = useState(''), conf = sq[0], setConf = sq[1]; // '' | 'gerar' | 'revogar': confirmação na própria tela
    var base = (BASE || location.origin) + '/empresas/' + encodeURIComponent(p.empresa);
    useEffect(function () {
      setSt(null); setBloqueio('');
      api(p.token, 'GET', '/empresas/' + encodeURIComponent(p.empresa) + '/api').then(setSt)
        .catch(function (e) { setBloqueio(e.status === 403 ? 'Somente a equipe de integração gerencia a chave de API. Entre com a chave de integração para continuar.' : e.message); });
    }, [p.empresa, p.token, recarga]);

    function gerar() {
      setConf('');
      api(p.token, 'POST', '/empresas/' + encodeURIComponent(p.empresa) + '/api/chave').then(function (r) { setNova(r.chave); setChaveTeste(r.chave); setTestes(null); setMsg(''); setRecarga(recarga + 1); })
        .catch(function (e) { setMsg(e.message); });
    }
    function revogar() {
      setConf('');
      api(p.token, 'DELETE', '/empresas/' + encodeURIComponent(p.empresa) + '/api/chave').then(function () { setNova(null); setMsg('Chave revogada.'); setRecarga(recarga + 1); })
        .catch(function (e) { setMsg(e.message); });
    }
    function copiar(texto) { try { navigator.clipboard.writeText(texto).then(function () { setMsg('Copiado.'); }, function () { setMsg('Não foi possível copiar; selecione e copie manualmente.'); }); } catch (e) { setMsg('Não foi possível copiar; selecione e copie manualmente.'); } }

    // Chamadas feitas com a chave colada, exatamente como o sistema de conversa faria.
    function chamar(caminho, chave) {
      var t0 = performance.now();
      return fetch(BASE + caminho, { headers: chave ? { Authorization: 'Bearer ' + chave } : {} }).then(function (r) {
        return r.text().then(function (txt) { var j = null; try { j = JSON.parse(txt); } catch (e) { /* texto puro */ } return { status: r.status, json: j, ms: Math.round(performance.now() - t0) }; });
      }).catch(function () { return { status: 0, json: null, ms: Math.round(performance.now() - t0) }; });
    }
    var atual = ((p.empresas || []).filter(function (x) { return x.id === p.empresa; })[0]) || {};
    var mod = atual.modulos || { reservas: true, conhecimento: true };
    function testar() {
      var chave = chaveTeste.trim();
      var outra = (p.empresas || []).filter(function (l) { return l.id !== p.empresa; })[0];
      var hoje = new Date(), d = hoje.getFullYear() + '-' + String(hoje.getMonth() + 1).padStart(2, '0') + '-' + String(hoje.getDate()).padStart(2, '0');
      var id = encodeURIComponent(p.empresa);
      var chamadas = { agente: chamar('/empresas/' + id + '/agente', chave) };
      if (mod.reservas) chamadas.disp = chamar('/empresas/' + id + '/disponibilidade?data=' + d + '&horario=20:00&pessoas=2', chave);
      chamadas.ctx = chamar('/empresas/' + id + '/contexto', chave);
      if (mod.conhecimento) chamadas.conh = chamar('/empresas/' + id + '/conhecimento', chave);
      chamadas.outra = outra ? chamar('/empresas/' + encodeURIComponent(outra.id) + '/agente', chave) : Promise.resolve(null);
      chamadas.semChave = chamar('/empresas/' + id + '/agente', '');
      var chaves = Object.keys(chamadas);
      setTestes(null); setAmostra(null);
      Promise.all(chaves.map(function (k) { return chamadas[k]; })).then(function (lista) {
        var r = {}; chaves.forEach(function (k, i) { r[k] = lista[i]; });
        var linhas = [
          { ok: r.agente.status === 200, titulo: 'Ler a configuração do agente desta empresa', status: r.agente.status, ms: r.agente.ms, detalhe: r.agente.status === 200 ? 'Recebeu o bloco completo, com nome do agente.' : r.agente.status === 401 ? 'Chave inválida, revogada ou de outra empresa.' : 'Resposta inesperada.' },
        ];
        if (r.disp) linhas.push({ ok: r.disp.status === 200, titulo: 'Consultar disponibilidade de mesas (hoje 20:00, 2 pessoas)', status: r.disp.status, ms: r.disp.ms, detalhe: r.disp.status === 200 ? 'Mesas livres devolvidas por ambiente.' : 'Falhou.' });
        linhas.push({ ok: r.ctx.status === 200 && !!(r.ctx.json && r.ctx.json.prompt), titulo: 'Ler o contexto completo do agente em uma chamada (one_contexto)', status: r.ctx.status, ms: r.ctx.ms, detalhe: r.ctx.status === 200 && r.ctx.json ? 'Prompt pronto com ' + r.ctx.json.prompt.length.toLocaleString('pt-BR') + ' caracteres.' : 'Falhou.' });
        if (r.conh) linhas.push({ ok: r.conh.status === 200, titulo: 'Ler a base de conhecimento (textos, tabelas e documentos)', status: r.conh.status, ms: r.conh.ms, detalhe: r.conh.status === 200 && r.conh.json ? r.conh.json.itens.length + ' item(ns) recebido(s).' : 'Falhou.' });
        if (r.outra) linhas.push({ ok: r.outra.status === 403, titulo: 'Isolamento: a chave NÃO pode acessar outra empresa', status: r.outra.status, ms: r.outra.ms, detalhe: r.outra.status === 403 ? 'Bloqueado, como esperado.' : 'ATENÇÃO: acesso indevido a outra empresa.' });
        linhas.push({ ok: r.semChave.status === 401, titulo: 'Sem chave, o acesso é negado', status: r.semChave.status, ms: r.semChave.ms, detalhe: r.semChave.status === 401 ? 'Bloqueado, como esperado.' : 'ATENÇÃO: acesso sem chave.' });
        setTestes(linhas);
        setAmostra({ agente: r.agente.json, disponibilidade: r.disp && r.disp.json, conhecimento: r.conh && r.conh.json, prompt: r.ctx.json && r.ctx.json.prompt });
      });
    }

    // Definições das functions do fluxo ONE para esta empresa (a chave fica como {{CHAVE_API}}: nunca é gravada aqui).
    function funcoesNico() {
      var o = origem.trim().replace(/\/$/, ''), id = p.empresa, auth = { Authorization: 'Bearer {{CHAVE_API}}' };
      var lista = [{
        name: 'one_contexto', method: 'GET', url: o + '/empresas/' + id + '/contexto', headers: auth,
        description: 'Traz do ONE o contexto completo do agente (nome, descrição, personalidade, habilidades, produtos, restrições, base de conhecimento) e um prompt de sistema pronto em `prompt`. Chame uma vez no início da conversa.',
        parameters: { type: 'object', properties: {}, required: [] },
      }];
      if (mod.conhecimento) {
        lista.push({
          name: 'one_buscar_conhecimento', method: 'GET', url: o + '/empresas/' + id + '/conhecimento/buscar?q={{consulta}}', headers: auth,
          description: 'Busca na base de conhecimento a informação que o cliente pediu (tabela de preços, horários, pagamento, regras). Devolve só o que interessa. Responda apenas com o que vier; se não vier nada, diga que vai confirmar com a equipe.',
          parameters: { type: 'object', properties: { consulta: { type: 'string', description: 'O assunto da pergunta, com as palavras do cliente (codificar para URL)' } }, required: ['consulta'] },
        });
      }
      if (mod.reservas) {
        lista.push({
          name: 'one_disponibilidade', method: 'GET', url: o + '/empresas/' + id + '/disponibilidade?data={{data}}&horario={{horario}}&pessoas={{pessoas}}', headers: auth,
          description: 'Consulta as mesas livres em uma data e horário, separadas por ambiente. Chame SEMPRE antes de oferecer ou registrar reserva.',
          parameters: { type: 'object', properties: { data: { type: 'string', description: 'AAAA-MM-DD' }, horario: { type: 'string', description: 'HH:MM' }, pessoas: { type: 'integer', minimum: 1 } }, required: ['data', 'horario', 'pessoas'] },
        });
        lista.push({
          name: 'one_reservar', method: 'POST', url: o + '/empresas/' + id + '/reservas', headers: Object.assign({ 'Content-Type': 'application/json', 'Idempotency-Key': '{{uuid_da_reserva}}' }, auth),
          description: "Registra a reserva. Só confirme ao cliente se a resposta tiver status 'confirmada'. Reenvie a MESMA Idempotency-Key se precisar repetir a chamada.",
          parameters: { type: 'object', properties: { data: { type: 'string' }, horario: { type: 'string' }, pessoas: { type: 'integer', minimum: 1 }, mesaId: { type: 'string', description: 'opcional' }, ambiente: { type: 'string', description: 'opcional' }, nomeCliente: { type: 'string', description: 'nome do cliente (envie sempre que tiver)' }, contato: { type: 'string', description: 'telefone ou e-mail do cliente (envie sempre que tiver)' } }, required: ['data', 'horario', 'pessoas'] },
          body: { data: '{{data}}', horario: '{{horario}}', pessoas: '{{pessoas}}', mesaId: '{{mesaId}}', ambiente: '{{ambiente}}', nomeCliente: '{{contato.nome}}', contato: '{{contato.telefone}}' },
        });
      }
      return lista;
    }
    var fnico = funcoesNico();
    var privado = /127\.0\.0\.1|localhost|\[::1\]/.test(origem);
    var linhasEnd = [
      ['GET', base + '/agente', 'Lê o nome, a descrição, a personalidade, as habilidades, os produtos e as restrições do agente'],
      ['GET', base + '/recursos', 'Diz quais recursos esta empresa usa e quais endereços estão disponíveis'],
    ];
    if (mod.reservas) {
      linhasEnd.push(['GET', base + '/disponibilidade?data=AAAA-MM-DD&horario=HH:MM&pessoas=N', 'Devolve as mesas livres por ambiente']);
      linhasEnd.push(['POST', base + '/reservas', 'Registra a reserva (JSON com data, horario, pessoas, mesaId; cabeçalho Idempotency-Key)']);
    }
    if (mod.conhecimento) {
      linhasEnd.push(['GET', base + '/conhecimento', 'Lê todos os textos, tabelas (colunas e linhas) e documentos da base de conhecimento']);
      linhasEnd.push(['GET', base + '/conhecimento/ID_DO_ITEM/arquivo', 'Baixa o arquivo de um documento (o endereço vem no campo arquivo.url)']);
    }
    var exemplo = 'curl -H "Authorization: Bearer SUA_CHAVE" "' + base + '/agente"';
    return h('section', { className: 'painel k1-stack' },
      h('h2', null, 'API · conexão com o sistema de conversa'),
      h('div', { className: 'rotulo' }, 'Cada empresa tem a sua chave. Ela só acessa esta empresa.'),
      bloqueio && h('div', { className: 'erro', role: 'alert' }, bloqueio),
      !bloqueio && st && h('div', { className: 'k1-stack' },
        h('div', { className: 'k1-row' },
          h('span', { className: 'k1-pill k1-pill-' + (st.ativa ? 'concluida' : 'pendente') }, st.ativa ? 'Chave ativa' : 'Sem chave'),
          st.ativa && h('span', { className: 'mono' }, st.prefixo + '…'),
          st.ativa && h('span', { className: 'rotulo' }, 'criada em ' + new Date(st.criadaEm).toLocaleString('pt-BR')),
          !conf && h(K.Button, { onClick: st.ativa ? function () { setMsg(''); setConf('gerar'); } : gerar }, st.ativa ? 'Gerar nova chave' : 'Gerar chave'),
          !conf && st.ativa && h(K.Button, { variant: 'danger', onClick: function () { setMsg(''); setConf('revogar'); } }, 'Revogar')),
        conf && h('div', { className: 'k1-row', role: 'alert' },
          h('span', null, conf === 'gerar' ? 'Já existe uma chave ativa. Gerar outra invalida a atual e o sistema de conversa deixa de funcionar até receber a nova.' : 'Revogar a chave desta empresa? O sistema de conversa perde o acesso imediatamente.'),
          h(K.Button, { variant: 'danger', onClick: conf === 'gerar' ? gerar : revogar }, conf === 'gerar' ? 'Confirmar nova chave' : 'Confirmar revogação'),
          h(K.Button, { variant: 'ghost', onClick: function () { setConf(''); } }, 'Cancelar')),
        nova && h('div', { className: 'k1-stack', style: { background: 'var(--surface-sunken)', border: '1px solid var(--border-strong)', borderRadius: 8, padding: 12 } },
          h('div', { className: 'rotulo' }, 'Copie agora. Esta chave não será mostrada de novo.'),
          h('div', { className: 'k1-row' }, h('code', { className: 'mono', style: { wordBreak: 'break-all' } }, nova), h(K.Button, { variant: 'secondary', onClick: function () { copiar(nova); } }, 'Copiar'))),
        msg && h('div', { role: 'status', className: 'rotulo' }, msg)),

      h('div', { className: 'k1-stack', style: { borderTop: '1px solid var(--border)', paddingTop: 16 } },
        h('h2', null, 'Endereços desta empresa'),
        h('table', null, h('tbody', null, linhasEnd.map(function (l) { return h('tr', { key: l[1] }, h('td', { className: 'mono' }, l[0]), h('td', { className: 'mono', style: { wordBreak: 'break-all' } }, l[1]), h('td', { style: { color: 'var(--ink-muted)' } }, l[2])); }))),
        h('div', { className: 'k1-row' }, h('code', { className: 'mono', style: { fontSize: 12, wordBreak: 'break-all' } }, exemplo), h(K.Button, { variant: 'secondary', onClick: function () { copiar(exemplo); } }, 'Copiar exemplo'))),

      h('div', { className: 'k1-stack', style: { borderTop: '1px solid var(--border)', paddingTop: 16 } },
        h('h2', null, 'Conectar ao NicoChat (fluxo ONE)'),
        h('div', { className: 'rotulo' }, 'Uma cópia do fluxo por empresa, cada uma com a chave desta empresa.'),
        h('div', { className: 'k1-stack', style: { background: 'var(--surface-sunken)', border: '1px solid var(--border-strong)', borderRadius: 8, padding: 12 } },
          h('div', null, h('b', null, 'Gatilho: '), 'toda conversa nova do cliente. (Para testar à mão, dá para usar uma mensagem com ', h('code', { className: 'mono' }, '#one'), '.)'),
          h('ol', { style: { margin: 0, paddingLeft: 20, fontSize: 13, color: 'var(--ink-muted)' } },
            h('li', null, 'No início de toda conversa, o fluxo chama one_contexto e recebe o prompt do agente pronto.'),
            h('li', null, 'A IA do NicoChat responde ao cliente usando esse prompt.'),
            mod.conhecimento && h('li', null, 'Se o cliente pergunta preço, horário ou regra, a IA chama one_buscar_conhecimento.'),
            mod.reservas && h('li', null, 'Se quer reservar, a IA chama one_disponibilidade e depois one_reservar (com nome e contato do cliente).'))),
        h('label', { className: 'campo' }, h('span', { className: 'rotulo' }, 'Endereço público do ONE (o NicoChat precisa conseguir acessar)'),
          h('input', { type: 'text', value: origem, 'aria-label': 'Endereço público do ONE', style: { maxWidth: 460 }, onChange: function (e) { setOrigem(e.target.value); } })),
        privado && h('div', { className: 'erro', role: 'alert' }, 'Este endereço só existe neste computador: o NicoChat, que roda na nuvem, não consegue chamá-lo. Use o endereço público do ONE (servidor ou túnel) antes de configurar o fluxo.'),
        h('div', { className: 'k1-row' }, h(K.Button, { variant: 'secondary', onClick: function () { copiar(JSON.stringify(fnico, null, 2)); } }, 'Copiar todas as functions (JSON)'),
          h('span', { className: 'rotulo' }, fnico.length + ' function(s) · coloque a chave desta empresa no lugar de {{CHAVE_API}}')),
        fnico.map(function (fn) {
          return h('details', { key: fn.name },
            h('summary', { style: { cursor: 'pointer', fontSize: 13 } }, h('b', { className: 'mono' }, fn.name), ' · ' + fn.method),
            h('pre', { className: 'mono', style: { fontSize: 12, background: 'var(--surface-sunken)', padding: 12, borderRadius: 8, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', margin: '8px 0 0' } }, JSON.stringify(fn, null, 2)));
        })),

      h('div', { className: 'k1-stack', style: { borderTop: '1px solid var(--border)', paddingTop: 16 } },
        h('h2', null, 'Testar a API desta empresa'),
        h('div', { className: 'rotulo' }, 'Cole a chave da empresa. Os testes só leem dados; nenhuma reserva é criada.'),
        h('div', { className: 'k1-row' },
          h('input', { type: 'password', value: chaveTeste, autoComplete: 'off', placeholder: 'k1_…', 'aria-label': 'Chave da empresa para o teste', style: { minWidth: 360 }, onChange: function (e) { setChaveTeste(e.target.value); } }),
          h(K.Button, { disabled: !chaveTeste.trim(), onClick: testar }, 'Testar conexão')),
        testes && h('table', null,
          h('thead', null, h('tr', null, ['Resultado', 'Teste', 'Resposta', 'Detalhe'].map(function (c) { return h('th', { key: c }, c); }))),
          h('tbody', null, testes.map(function (l, i) { return h(Resultado, Object.assign({ key: i }, l)); }))),
        testes && h('div', { className: testes.every(function (l) { return l.ok; }) ? 'rotulo' : 'erro', role: 'status' }, testes.every(function (l) { return l.ok; }) ? 'Tudo certo: a API desta empresa está funcionando.' : 'Há testes que falharam. Veja o detalhe acima.'),
        amostra && amostra.agente && h('div', { className: 'k1-stack' },
          h('div', { className: 'rotulo' }, 'O que o sistema de conversa recebe ao ler o agente'),
          h('pre', { className: 'mono', style: { fontSize: 12, background: 'var(--surface-sunken)', padding: 12, borderRadius: 8, maxHeight: 280, overflow: 'auto', whiteSpace: 'pre-wrap', margin: 0 } }, JSON.stringify(amostra.agente, null, 2))),
        amostra && amostra.disponibilidade && h('div', { className: 'k1-stack' },
          h('div', { className: 'rotulo' }, 'O que ele recebe ao consultar a disponibilidade'),
          h('pre', { className: 'mono', style: { fontSize: 12, background: 'var(--surface-sunken)', padding: 12, borderRadius: 8, maxHeight: 220, overflow: 'auto', margin: 0 } }, JSON.stringify(amostra.disponibilidade, null, 2))),
        amostra && amostra.conhecimento && h('div', { className: 'k1-stack' },
          h('div', { className: 'rotulo' }, 'O que ele recebe ao ler a base de conhecimento'),
          h('pre', { className: 'mono', style: { fontSize: 12, background: 'var(--surface-sunken)', padding: 12, borderRadius: 8, maxHeight: 280, overflow: 'auto', whiteSpace: 'pre-wrap', margin: 0 } }, JSON.stringify(amostra.conhecimento, null, 2))),
        amostra && amostra.prompt && h('div', { className: 'k1-stack' },
          h('div', { className: 'k1-row' }, h('div', { className: 'rotulo' }, 'Prompt do agente montado pelo ONE (vem pronto em one_contexto)'), h(K.Button, { variant: 'secondary', onClick: function () { copiar(amostra.prompt); } }, 'Copiar prompt')),
          h('pre', { className: 'mono', style: { fontSize: 12, background: 'var(--surface-sunken)', padding: 12, borderRadius: 8, maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', margin: 0 } }, amostra.prompt))));
  }

  function NovaEmpresa(p) {
    var sa = useState(false), aberto = sa[0], setAberto = sa[1];
    var sv = useState(''), v = sv[0], setV = sv[1];
    var sr = useState(true), reservas = sr[0], setReservas = sr[1];
    var sk = useState(true), conh = sk[0], setConh = sk[1];
    var sm = useState(''), msg = sm[0], setMsg = sm[1];
    function criar(ev) {
      ev.preventDefault();
      api(p.token, 'POST', '/empresas', { nome: v, modulos: { reservas: reservas, conhecimento: conh } }).then(function (l) { setV(''); setMsg(''); setAberto(false); p.aoCriar(l.id); })
        .catch(function (e) { setMsg(e.message); });
    }
    if (!aberto) return h(K.Button, { variant: 'secondary', onClick: function () { setAberto(true); } }, '+ Nova empresa');
    return h('form', { className: 'k1-row', onSubmit: criar },
      h('input', { type: 'text', value: v, maxLength: 60, autoFocus: true, placeholder: 'Nome da empresa', 'aria-label': 'Nome da nova empresa', onChange: function (e) { setV(e.target.value); setMsg(''); } }),
      h('label', { className: 'k1-row', style: { gap: 4, fontSize: 13 } }, h('input', { type: 'checkbox', checked: reservas, onChange: function (e) { setReservas(e.target.checked); } }), 'Reservas e mapa de mesas'),
      h('label', { className: 'k1-row', style: { gap: 4, fontSize: 13 } }, h('input', { type: 'checkbox', checked: conh, onChange: function (e) { setConh(e.target.checked); } }), 'Base de conhecimento'),
      h(K.Button, { type: 'submit', disabled: !v.trim() }, 'Criar'),
      h(K.Button, { variant: 'ghost', onClick: function () { setAberto(false); setMsg(''); } }, 'Cancelar'),
      msg && h('span', { className: 'erro', role: 'alert' }, msg));
  }

  function App() {
    var st = useState(lerToken()), token = st[0], setToken = st[1];
    var sl = useState(null), empresas = sl[0], setEmpresas = sl[1];
    var sa = useState(null), empresa = sa[0], setEmpresa = sa[1];
    var sb = useState('Workspace'), aba = sb[0], setAba = sb[1];
    var si = useState(false), superadmin = si[0], setSuperadmin = si[1]; // só a chave de integração enxerga a aba API
    useEffect(function () {
      setSuperadmin(false);
      if (!token || !empresa) return;
      var vivo = true;
      api(token, 'GET', '/empresas/' + encodeURIComponent(empresa) + '/api').then(function () { if (vivo) setSuperadmin(true); }).catch(function () { if (vivo) setSuperadmin(false); });
      return function () { vivo = false; };
    }, [token, empresa]);
    useEffect(function () {
      if (!token) return;
      api(token, 'GET', '/empresas').then(function (l) { setEmpresas(l); setEmpresa(function (a) { return a || (l[0] && l[0].id); }); })
        .catch(function () { gravarToken(''); setToken(''); });
    }, [token]);
    function aposExcluir() { api(token, 'GET', '/empresas').then(function (l) { setEmpresas(l); setEmpresa(l[0] ? l[0].id : null); setAba('Workspace'); }).catch(function () {}); }
    function recarregarEmpresas() { api(token, 'GET', '/empresas').then(setEmpresas).catch(function () {}); }
    if (!token || !empresas) return token ? h('div', { className: 'pagina' }, h(K.EmptyState, null, 'Carregando…')) : h(Login, { onEntrar: function (t, l) { setToken(t); setEmpresas(l); setEmpresa(l[0] && l[0].id); } });
    var nome = (empresas.filter(function (l) { return l.id === empresa; })[0] || {}).nome || '';
    if (empresas.length === 0) {
      return h('div', null,
        h(K.TopBar, { logoSrc: 'logo-chatflow.png', brandSub: 'Painel', unit: '', modules: ['Atendimento', 'Alimentos e Bebidas'], active: 'Atendimento', user: lerOperador() || 'Equipe', initials: (lerOperador() || 'EQ').slice(0, 2).toUpperCase() }),
        h('main', { className: 'pagina' },
          h('h1', null, 'Nenhuma empresa'),
          h(K.EmptyState, null, 'Crie a primeira empresa para começar.'),
          h('div', { className: 'k1-row' },
            h(NovaEmpresa, { token: token, aoCriar: function (id) { api(token, 'GET', '/empresas').then(function (l) { setEmpresas(l); setEmpresa(id); setAba('Configuração'); }); } }),
            h(K.Button, { variant: 'ghost', onClick: function () { gravarToken(''); gravarOperador(''); setToken(''); setEmpresas(null); } }, 'Sair'))));
    }
    var modAtual = (empresas.filter(function (l) { return l.id === empresa; })[0] || {}).modulos || { reservas: true, conhecimento: true };
    var abas = [].concat(modAtual.reservas ? ['Workspace', 'Mapa de mesas'] : [], ['Configuração', 'Agentes'], modAtual.conhecimento ? ['Conhecimento'] : [], superadmin ? ['API', 'Histórico'] : []);
    var abaAtual = abas.indexOf(aba) >= 0 ? aba : abas[0];
    var tela = abaAtual === 'Workspace' ? Reservas : abaAtual === 'Mapa de mesas' ? Mapa : abaAtual === 'Configuração' ? Configuracao : abaAtual === 'Histórico' ? Historico : abaAtual === 'API' ? ApiEmpresa : abaAtual === 'Conhecimento' ? Conhecimento : Agentes;
    return h('div', null,
      h(K.TopBar, { logoSrc: 'logo-chatflow.png', brandSub: 'Painel', unit: nome, modules: modAtual.reservas ? ['Atendimento', 'Alimentos e Bebidas'] : ['Atendimento'], active: modAtual.reservas && ['Workspace', 'Mapa de mesas', 'Configuração'].indexOf(abaAtual) >= 0 ? 'Alimentos e Bebidas' : 'Atendimento', user: lerOperador() || 'Equipe', initials: (lerOperador() || 'EQ').slice(0, 2).toUpperCase() }),
      h(K.Tabs, { items: abas, value: abaAtual, onChange: setAba }),
      h('main', { className: 'pagina' },
        h('div', { className: 'k1-row' }, h('h1', null, abaAtual + ' · ' + nome),
          h('div', { style: { maxWidth: '100%', overflowX: 'auto' } }, h(K.Segmented, { items: empresas.map(function (l) { return l.nome; }), value: nome, onChange: function (n) { var l = empresas.filter(function (x) { return x.nome === n; })[0]; if (l) setEmpresa(l.id); } })),
          h(NovaEmpresa, { token: token, aoCriar: function (id) { api(token, 'GET', '/empresas').then(function (l) { setEmpresas(l); setEmpresa(id); setAba('Configuração'); }); } }),
          h(K.Button, { variant: 'ghost', onClick: function () { gravarToken(''); gravarOperador(''); setToken(''); setEmpresas(null); } }, 'Sair')),
        h(tela, { token: token, empresa: empresa, empresas: empresas, aoRenomear: recarregarEmpresas, aoExcluir: aposExcluir, key: abaAtual + empresa })));
  }

  ReactDOM.createRoot(document.getElementById('root')).render(h(App));
})();
