'use strict';

(function () {
  var R = window.React, h = R.createElement, K = window.KendjiOne;
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
    return fetch(caminho, {
      method: metodo,
      headers: Object.assign({ Authorization: 'Bearer ' + token }, lerOperador() ? { 'X-Operador': encodeURIComponent(lerOperador()) } : {}, corpo ? { 'Content-Type': 'application/json' } : {}),
      body: corpo ? JSON.stringify(corpo) : undefined,
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) { var e = new Error(j.erro || 'Erro ' + r.status); e.status = r.status; throw e; }
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
          h('h1', null, 'Entrar no ONE'),
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
    function consultar() {
      setMsg(''); setDisp(null);
      api(p.token, 'GET', '/empresas/' + encodeURIComponent(p.empresa) + '/disponibilidade?data=' + data + '&horario=' + hora + '&pessoas=' + Number(pessoas))
        .then(setDisp).catch(function (e) { setMsg(e.message); });
    }
    function reservar(mesaId) {
      api(p.token, 'POST', '/empresas/' + encodeURIComponent(p.empresa) + '/reservas', { data: data, horario: hora, pessoas: Number(pessoas), mesaId: mesaId, chave: chaveNova() })
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
        h('td', null, h('span', { className: 'k1-pill k1-pill-' + (ativa ? 'concluida' : 'pendente') }, ativa ? 'Confirmada' : 'Cancelada')),
        h('td', null, h('span', { className: 'k1-row', style: { gap: 4 } },
          ativa && h(K.Button, { variant: 'secondary', onClick: function () { setAberto(!aberto); if (!aberto) consultar({}); } }, 'Editar'),
          ativa && h(K.Button, { variant: 'danger', onClick: function () { enviar('DELETE'); } }, 'Cancelar'),
          !ativa && h(K.Button, { variant: 'primary', onClick: function () { enviar('PATCH', { status: 'confirmada' }); } }, 'Reativar')))),
      (msg && !aberto) && h('tr', null, h('td', { colSpan: 6, className: 'erro', role: 'alert' }, msg)),
      aberto && h('tr', null, h('td', { colSpan: 6 }, h('div', { className: 'k1-stack', style: { padding: '8px 0' } },
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
        h('thead', null, h('tr', null, ['Horário', 'Pessoas', 'Ambiente', 'Mesa', 'Situação', 'Ações'].map(function (c) { return h('th', { key: c }, c); }))),
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
              h('div', null, 'Situação: ', h('b', null, mesa.reserva.status)))
            : h('div', null, 'Livre neste horário.'))));
  }

  function LinhaMesa(p) {
    var m = p.mesa;
    var sc = useState(String(m.capacidade)), cap = sc[0], setCap = sc[1];
    var se = useState(''), msg = se[0], setMsg = se[1];
    function salvar(corpo) {
      api(p.token, 'PATCH', '/empresas/' + encodeURIComponent(p.empresa) + '/mesas/' + encodeURIComponent(m.id), corpo)
        .then(function () { setMsg('Salvo.'); p.recarregar(); }).catch(function (e) { setMsg(e.message); });
    }
    return h('div', { className: 'k1-row', style: { padding: '6px 0' } },
      h('b', { className: 'mono', style: { minWidth: 90 } }, m.id),
      h('label', { className: 'k1-row' }, 'Lugares', h('input', { type: 'number', min: 1, max: 100, value: cap, style: { width: 72 }, onChange: function (e) { setCap(e.target.value); } })),
      h(K.Button, { variant: 'secondary', onClick: function () { salvar({ capacidade: Number(cap) }); } }, 'Salvar'),
      h(K.Button, { variant: m.reservavel ? 'neutral' : 'primary', onClick: function () { salvar({ reservavel: !m.reservavel }); } }, m.reservavel ? 'Bloquear reservas' : 'Liberar reservas'),
      h('span', { className: 'rotulo' }, msg));
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

  function Configuracao(p) {
    var s = useState(null), est = s[0], setEst = s[1];
    var se = useState(''), erro = se[0], setErro = se[1];
    var carregar = useCallback(function () {
      api(p.token, 'GET', '/empresas/' + encodeURIComponent(p.empresa) + '/estrutura').then(setEst).catch(function (e) { setErro(e.message); });
    }, [p.empresa, p.token]);
    useEffect(function () { setEst(null); carregar(); }, [carregar]);
    return h('section', { className: 'painel k1-stack' },
      h('h2', null, 'Configuração · Empresa → Ambiente → Mesa'),
      est && h(NomeEmpresa, { key: est.nome, nome: est.nome, token: p.token, empresa: p.empresa, aoRenomear: p.aoRenomear }),
      erro && h('div', { className: 'erro', role: 'alert' }, erro),
      est && est.ambientes.length === 0 && h(K.EmptyState, null, 'Nenhum ambiente cadastrado. Crie o primeiro abaixo para poder cadastrar mesas e receber reservas.'),
      est && est.ambientes.map(function (a) {
        return h('div', { key: a.nome }, h('div', { className: 'rotulo', style: { margin: '8px 0 4px' } }, a.nome),
          a.mesas.map(function (m) { return h(LinhaMesa, { key: m.id + m.capacidade + m.reservavel, mesa: m, token: p.token, empresa: p.empresa, recarregar: carregar }); }),
          h(NovaMesa, { key: 'nova-' + a.nome + a.mesas.length, ambiente: a.nome, token: p.token, empresa: p.empresa, recarregar: carregar }));
      }),
      est && h(NovoAmbiente, { token: p.token, empresa: p.empresa, recarregar: carregar }),
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
    return e.entidade === 'reserva' ? 'Reserva #' + e.entidadeId : e.entidade === 'mesa' ? 'Mesa ' + e.entidadeId : e.entidade === 'empresa' ? 'Empresa' : e.entidade === 'ambiente' ? 'Ambiente ' + e.entidadeId : e.entidade === 'api' ? 'Chave da API' : e.entidade === 'empresa' ? 'Empresa' : 'Agente · ' + e.entidadeId;
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
            h('td', { className: 'mono', style: { fontSize: 12 } }, e.acao === 'criada' && e.entidade === 'reserva' ? 'pessoas ' + e.depois.pessoas + ', ' + e.depois.data + ' ' + e.depois.horario + ', ' + e.depois.mesaId : mudancas(e)),
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
    var base = location.origin + '/empresas/' + encodeURIComponent(p.empresa);
    useEffect(function () {
      setSt(null); setBloqueio('');
      api(p.token, 'GET', '/empresas/' + encodeURIComponent(p.empresa) + '/api').then(setSt)
        .catch(function (e) { setBloqueio(e.status === 403 ? 'Somente a equipe de integração gerencia a chave de API. Entre com a chave de integração para continuar.' : e.message); });
    }, [p.empresa, p.token, recarga]);

    function gerar() {
      if (st && st.ativa && !window.confirm('Já existe uma chave ativa. Gerar outra invalida a atual e o sistema de conversa deixa de funcionar até receber a nova. Continuar?')) return;
      api(p.token, 'POST', '/empresas/' + encodeURIComponent(p.empresa) + '/api/chave').then(function (r) { setNova(r.chave); setChaveTeste(r.chave); setTestes(null); setMsg(''); setRecarga(recarga + 1); })
        .catch(function (e) { setMsg(e.message); });
    }
    function revogar() {
      if (!window.confirm('Revogar a chave desta empresa? O sistema de conversa perde o acesso imediatamente.')) return;
      api(p.token, 'DELETE', '/empresas/' + encodeURIComponent(p.empresa) + '/api/chave').then(function () { setNova(null); setMsg('Chave revogada.'); setRecarga(recarga + 1); })
        .catch(function (e) { setMsg(e.message); });
    }
    function copiar(texto) { try { navigator.clipboard.writeText(texto).then(function () { setMsg('Copiado.'); }, function () { setMsg('Não foi possível copiar; selecione e copie manualmente.'); }); } catch (e) { setMsg('Não foi possível copiar; selecione e copie manualmente.'); } }

    // Chamadas feitas com a chave colada, exatamente como o sistema de conversa faria.
    function chamar(caminho, chave) {
      var t0 = performance.now();
      return fetch(caminho, { headers: chave ? { Authorization: 'Bearer ' + chave } : {} }).then(function (r) {
        return r.text().then(function (txt) { var j = null; try { j = JSON.parse(txt); } catch (e) { /* texto puro */ } return { status: r.status, json: j, ms: Math.round(performance.now() - t0) }; });
      }).catch(function () { return { status: 0, json: null, ms: Math.round(performance.now() - t0) }; });
    }
    function testar() {
      var chave = chaveTeste.trim();
      var outra = (p.empresas || []).filter(function (l) { return l.id !== p.empresa; })[0];
      var hoje = new Date(), d = hoje.getFullYear() + '-' + String(hoje.getMonth() + 1).padStart(2, '0') + '-' + String(hoje.getDate()).padStart(2, '0');
      setTestes(null); setAmostra(null);
      Promise.all([
        chamar('/empresas/' + encodeURIComponent(p.empresa) + '/agente', chave),
        chamar('/empresas/' + encodeURIComponent(p.empresa) + '/disponibilidade?data=' + d + '&horario=20:00&pessoas=2', chave),
        outra ? chamar('/empresas/' + encodeURIComponent(outra.id) + '/agente', chave) : Promise.resolve(null),
        chamar('/empresas/' + encodeURIComponent(p.empresa) + '/agente', ''),
      ]).then(function (r) {
        var linhas = [
          { ok: r[0].status === 200, titulo: 'Ler a configuração do agente desta empresa', status: r[0].status, ms: r[0].ms, detalhe: r[0].status === 200 ? 'Recebeu o bloco completo, com nome do agente.' : r[0].status === 401 ? 'Chave inválida, revogada ou de outra empresa.' : 'Resposta inesperada.' },
          { ok: r[1].status === 200, titulo: 'Consultar disponibilidade de mesas (hoje 20:00, 2 pessoas)', status: r[1].status, ms: r[1].ms, detalhe: r[1].status === 200 ? 'Mesas livres devolvidas por ambiente.' : 'Falhou.' },
        ];
        if (r[2]) linhas.push({ ok: r[2].status === 403, titulo: 'Isolamento: a chave NÃO pode acessar outra empresa', status: r[2].status, ms: r[2].ms, detalhe: r[2].status === 403 ? 'Bloqueado, como esperado.' : 'ATENÇÃO: acesso indevido a outra empresa.' });
        linhas.push({ ok: r[3].status === 401, titulo: 'Sem chave, o acesso é negado', status: r[3].status, ms: r[3].ms, detalhe: r[3].status === 401 ? 'Bloqueado, como esperado.' : 'ATENÇÃO: acesso sem chave.' });
        setTestes(linhas);
        setAmostra({ agente: r[0].json, disponibilidade: r[1].json });
      });
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
          h(K.Button, { onClick: gerar }, st.ativa ? 'Gerar nova chave' : 'Gerar chave'),
          st.ativa && h(K.Button, { variant: 'danger', onClick: revogar }, 'Revogar')),
        nova && h('div', { className: 'k1-stack', style: { background: 'var(--surface-sunken)', border: '1px solid var(--border-strong)', borderRadius: 8, padding: 12 } },
          h('div', { className: 'rotulo' }, 'Copie agora. Esta chave não será mostrada de novo.'),
          h('div', { className: 'k1-row' }, h('code', { className: 'mono', style: { wordBreak: 'break-all' } }, nova), h(K.Button, { variant: 'secondary', onClick: function () { copiar(nova); } }, 'Copiar'))),
        msg && h('div', { role: 'status', className: 'rotulo' }, msg)),

      h('div', { className: 'k1-stack', style: { borderTop: '1px solid var(--border)', paddingTop: 16 } },
        h('h2', null, 'Endereços desta empresa'),
        h('table', null, h('tbody', null, [
          ['GET', base + '/agente', 'Lê o nome, a descrição, a personalidade, as habilidades, os produtos e as restrições do agente'],
          ['GET', base + '/disponibilidade?data=AAAA-MM-DD&horario=HH:MM&pessoas=N', 'Devolve as mesas livres por ambiente'],
          ['POST', base + '/reservas', 'Registra a reserva (JSON com data, horario, pessoas, mesaId; cabeçalho Idempotency-Key)'],
        ].map(function (l) { return h('tr', { key: l[1] }, h('td', { className: 'mono' }, l[0]), h('td', { className: 'mono', style: { wordBreak: 'break-all' } }, l[1]), h('td', { style: { color: 'var(--ink-muted)' } }, l[2])); }))),
        h('div', { className: 'k1-row' }, h('code', { className: 'mono', style: { fontSize: 12, wordBreak: 'break-all' } }, exemplo), h(K.Button, { variant: 'secondary', onClick: function () { copiar(exemplo); } }, 'Copiar exemplo'))),

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
          h('pre', { className: 'mono', style: { fontSize: 12, background: 'var(--surface-sunken)', padding: 12, borderRadius: 8, maxHeight: 220, overflow: 'auto', margin: 0 } }, JSON.stringify(amostra.disponibilidade, null, 2)))));
  }

  function NovaEmpresa(p) {
    var sa = useState(false), aberto = sa[0], setAberto = sa[1];
    var sv = useState(''), v = sv[0], setV = sv[1];
    var sm = useState(''), msg = sm[0], setMsg = sm[1];
    function criar(ev) {
      ev.preventDefault();
      api(p.token, 'POST', '/empresas', { nome: v }).then(function (l) { setV(''); setMsg(''); setAberto(false); p.aoCriar(l.id); })
        .catch(function (e) { setMsg(e.message); });
    }
    if (!aberto) return h(K.Button, { variant: 'secondary', onClick: function () { setAberto(true); } }, '+ Nova empresa');
    return h('form', { className: 'k1-row', onSubmit: criar },
      h('input', { type: 'text', value: v, maxLength: 60, autoFocus: true, placeholder: 'Nome da empresa', 'aria-label': 'Nome da nova empresa', onChange: function (e) { setV(e.target.value); setMsg(''); } }),
      h(K.Button, { type: 'submit', disabled: !v.trim() }, 'Criar'),
      h(K.Button, { variant: 'ghost', onClick: function () { setAberto(false); setMsg(''); } }, 'Cancelar'),
      msg && h('span', { className: 'erro', role: 'alert' }, msg));
  }

  function App() {
    var st = useState(lerToken()), token = st[0], setToken = st[1];
    var sl = useState(null), empresas = sl[0], setEmpresas = sl[1];
    var sa = useState(null), empresa = sa[0], setEmpresa = sa[1];
    var sb = useState('Reservas'), aba = sb[0], setAba = sb[1];
    useEffect(function () {
      if (!token) return;
      api(token, 'GET', '/empresas').then(function (l) { setEmpresas(l); setEmpresa(function (a) { return a || (l[0] && l[0].id); }); })
        .catch(function () { gravarToken(''); setToken(''); });
    }, [token]);
    function aposExcluir() { api(token, 'GET', '/empresas').then(function (l) { setEmpresas(l); setEmpresa(l[0] ? l[0].id : null); setAba('Reservas'); }).catch(function () {}); }
    function recarregarEmpresas() { api(token, 'GET', '/empresas').then(setEmpresas).catch(function () {}); }
    if (!token || !empresas) return token ? h('div', { className: 'pagina' }, h(K.EmptyState, null, 'Carregando…')) : h(Login, { onEntrar: function (t, l) { setToken(t); setEmpresas(l); setEmpresa(l[0] && l[0].id); } });
    var nome = (empresas.filter(function (l) { return l.id === empresa; })[0] || {}).nome || '';
    if (empresas.length === 0) {
      return h('div', null,
        h(K.TopBar, { logoSrc: '/app/logo.png', unit: '', modules: ['Atendimento', 'Alimentos e Bebidas'], active: 'Atendimento', user: lerOperador() || 'Equipe', initials: (lerOperador() || 'EQ').slice(0, 2).toUpperCase() }),
        h('main', { className: 'pagina' },
          h('h1', null, 'Nenhuma empresa'),
          h(K.EmptyState, null, 'Crie a primeira empresa para começar.'),
          h('div', { className: 'k1-row' },
            h(NovaEmpresa, { token: token, aoCriar: function (id) { api(token, 'GET', '/empresas').then(function (l) { setEmpresas(l); setEmpresa(id); setAba('Configuração'); }); } }),
            h(K.Button, { variant: 'ghost', onClick: function () { gravarToken(''); gravarOperador(''); setToken(''); setEmpresas(null); } }, 'Sair'))));
    }
    var tela = aba === 'Reservas' ? Reservas : aba === 'Mapa de mesas' ? Mapa : aba === 'Configuração' ? Configuracao : aba === 'Histórico' ? Historico : aba === 'API' ? ApiEmpresa : Agentes;
    return h('div', null,
      h(K.TopBar, { logoSrc: '/app/logo.png', unit: nome, modules: ['Atendimento', 'Alimentos e Bebidas'], active: aba === 'Agentes' ? 'Atendimento' : 'Alimentos e Bebidas', user: lerOperador() || 'Equipe', initials: (lerOperador() || 'EQ').slice(0, 2).toUpperCase() }),
      h(K.Tabs, { items: ['Reservas', 'Mapa de mesas', 'Configuração', 'Agentes', 'API', 'Histórico'], value: aba, onChange: setAba }),
      h('main', { className: 'pagina' },
        h('div', { className: 'k1-row' }, h('h1', null, aba + ' · ' + nome),
          h('div', { style: { maxWidth: '100%', overflowX: 'auto' } }, h(K.Segmented, { items: empresas.map(function (l) { return l.nome; }), value: nome, onChange: function (n) { var l = empresas.filter(function (x) { return x.nome === n; })[0]; if (l) setEmpresa(l.id); } })),
          h(NovaEmpresa, { token: token, aoCriar: function (id) { api(token, 'GET', '/empresas').then(function (l) { setEmpresas(l); setEmpresa(id); setAba('Configuração'); }); } }),
          h(K.Button, { variant: 'ghost', onClick: function () { gravarToken(''); gravarOperador(''); setToken(''); setEmpresas(null); } }, 'Sair')),
        h(tela, { token: token, empresa: empresa, empresas: empresas, aoRenomear: recarregarEmpresas, aoExcluir: aposExcluir, key: aba + empresa })));
  }

  ReactDOM.createRoot(document.getElementById('root')).render(h(App));
})();
