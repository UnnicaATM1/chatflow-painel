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
  function gravarToken(t) { try { if (t) sessionStorage.setItem('k1token', t); else sessionStorage.removeItem('k1token'); } catch (e) { /* ignora */ } }

  function api(token, metodo, caminho, corpo) {
    return fetch(caminho, {
      method: metodo,
      headers: Object.assign({ Authorization: 'Bearer ' + token }, corpo ? { 'Content-Type': 'application/json' } : {}),
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
    var se = useState(''), erro = se[0], setErro = se[1];
    function entrar(ev) {
      ev.preventDefault();
      api(valor, 'GET', '/lojas').then(function (lojas) { gravarToken(valor); p.onEntrar(valor, lojas); })
        .catch(function (e) { setErro(e.status === 401 ? 'Chave inválida.' : e.status === 403 ? 'Esta chave não acessa o painel.' : e.message); });
    }
    return h('div', { className: 'pagina', style: { maxWidth: 420, marginTop: 64 } },
      h('div', { className: 'painel' },
        h('form', { className: 'k1-stack', onSubmit: entrar },
          h('h1', null, 'Entrar no ONE'),
          h('label', { className: 'campo' }, h('span', { className: 'rotulo' }, 'Chave de acesso'),
            h('input', { type: 'password', value: valor, autoComplete: 'off', onChange: function (e) { setValor(e.target.value); } })),
          erro && h('div', { className: 'erro', role: 'alert' }, erro),
          h(K.Button, { type: 'submit', disabled: !valor }, 'Entrar'))));
  }

  function Reservas(p) {
    var sd = useState(hoje()), data = sd[0], setData = sd[1];
    var sl = useState(null), lista = sl[0], setLista = sl[1];
    var se = useState(''), erro = se[0], setErro = se[1];
    useEffect(function () {
      setLista(null);
      api(p.token, 'GET', '/lojas/' + encodeURIComponent(p.loja) + '/reservas?data=' + data).then(setLista).catch(function (e) { setErro(e.message); });
    }, [p.loja, data, p.token]);
    return h('section', { className: 'painel k1-stack' },
      h('div', { className: 'k1-row' }, h('h2', null, 'Reservas'), h('input', { type: 'date', value: data, 'aria-label': 'Data', onChange: function (e) { setData(e.target.value); } })),
      erro && h('div', { className: 'erro', role: 'alert' }, erro),
      lista && lista.length === 0 && h(K.EmptyState, null, 'Nenhuma reserva em ' + br(data) + '. Elas chegam pelo chat do agente.'),
      lista && lista.length > 0 && h('table', null,
        h('thead', null, h('tr', null, ['Horário', 'Pessoas', 'Ambiente', 'Mesa', 'Situação'].map(function (c) { return h('th', { key: c }, c); }))),
        h('tbody', null, lista.slice().sort(function (a, b) { return a.horario < b.horario ? -1 : 1; }).map(function (r) {
          return h('tr', { key: r.id }, h('td', { className: 'mono' }, r.horario), h('td', { className: 'mono' }, r.pessoas),
            h('td', null, r.ambiente), h('td', { className: 'mono' }, r.mesaId), h('td', null, h('span', { className: 'k1-pill k1-pill-' + (r.status === 'confirmada' ? 'concluida' : 'pendente') }, r.status === 'confirmada' ? 'Confirmada' : r.status)));
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
      api(p.token, 'GET', '/lojas/' + encodeURIComponent(p.loja) + '/mapa?data=' + data + '&horario=' + hora).then(function (m) { setErro(''); setMapa(m); }).catch(function (e) { setErro(e.message); });
    }, [p.loja, data, hora, p.token]);
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
      api(p.token, 'PATCH', '/lojas/' + encodeURIComponent(p.loja) + '/mesas/' + encodeURIComponent(m.id), corpo)
        .then(function () { setMsg('Salvo.'); p.recarregar(); }).catch(function (e) { setMsg(e.message); });
    }
    return h('div', { className: 'k1-row', style: { padding: '6px 0' } },
      h('b', { className: 'mono', style: { minWidth: 90 } }, m.id),
      h('label', { className: 'k1-row' }, 'Lugares', h('input', { type: 'number', min: 1, max: 100, value: cap, style: { width: 72 }, onChange: function (e) { setCap(e.target.value); } })),
      h(K.Button, { variant: 'secondary', onClick: function () { salvar({ capacidade: Number(cap) }); } }, 'Salvar'),
      h(K.Button, { variant: m.reservavel ? 'neutral' : 'primary', onClick: function () { salvar({ reservavel: !m.reservavel }); } }, m.reservavel ? 'Bloquear reservas' : 'Liberar reservas'),
      h('span', { className: 'rotulo' }, msg));
  }

  function Configuracao(p) {
    var s = useState(null), est = s[0], setEst = s[1];
    var se = useState(''), erro = se[0], setErro = se[1];
    var carregar = useCallback(function () {
      api(p.token, 'GET', '/lojas/' + encodeURIComponent(p.loja) + '/estrutura').then(setEst).catch(function (e) { setErro(e.message); });
    }, [p.loja, p.token]);
    useEffect(function () { setEst(null); carregar(); }, [carregar]);
    return h('section', { className: 'painel k1-stack' },
      h('h2', null, 'Configuração · Loja → Ambiente → Mesa'),
      erro && h('div', { className: 'erro', role: 'alert' }, erro),
      est && est.ambientes.length === 0 && h(K.EmptyState, null, 'Nenhum ambiente cadastrado nesta loja.'),
      est && est.ambientes.map(function (a) {
        return h('div', { key: a.nome }, h('div', { className: 'rotulo', style: { margin: '8px 0 4px' } }, a.nome),
          a.mesas.map(function (m) { return h(LinhaMesa, { key: m.id + m.capacidade + m.reservavel, mesa: m, token: p.token, loja: p.loja, recarregar: carregar }); }));
      }));
  }

  var CAMPOS = [['descricao', 'Descrição do negócio', false], ['habilidades', 'Habilidades do agente', true], ['produtos', 'Produtos e serviços', true], ['restricoes', 'Restrições de atendimento', true]];

  function Agentes(p) {
    var sc = useState(null), cfg = sc[0], setCfg = sc[1];
    var sr = useState({}), rasc = sr[0], setRasc = sr[1];
    var sm = useState({}), msgs = sm[0], setMsgs = sm[1];
    useEffect(function () {
      setCfg(null);
      api(p.token, 'GET', '/lojas/' + encodeURIComponent(p.loja) + '/agente').then(function (c) {
        setCfg(c);
        var r = {}; CAMPOS.forEach(function (x) { r[x[0]] = x[2] ? c[x[0]].join('\n') : c[x[0]]; }); setRasc(r); setMsgs({});
      }).catch(function (e) { setMsgs({ geral: e.message }); });
    }, [p.loja, p.token]);
    function salvar(campo, lista) {
      var valor = lista ? rasc[campo].split('\n').map(function (x) { return x.trim(); }).filter(Boolean) : rasc[campo];
      api(p.token, 'PATCH', '/lojas/' + encodeURIComponent(p.loja) + '/agente', { campo: campo, valor: valor })
        .then(function () { var m = Object.assign({}, msgs); m[campo] = 'Salvo.'; setMsgs(m); })
        .catch(function (e) { var m = Object.assign({}, msgs); m[campo] = e.status === 403 ? 'Este campo é editado pela equipe de integração.' : e.message; setMsgs(m); });
    }
    return h('section', { className: 'painel k1-stack' },
      h('h2', null, 'Atendimento · Agentes'),
      msgs.geral && h('div', { className: 'erro', role: 'alert' }, msgs.geral),
      !cfg && !msgs.geral && h(K.EmptyState, null, 'Carregando…'),
      cfg && CAMPOS.map(function (c) {
        return h('div', { key: c[0], className: 'campo' },
          h('span', { className: 'rotulo' }, c[1] + (c[2] ? ' (um item por linha)' : '')),
          h('textarea', { value: rasc[c[0]] || '', 'aria-label': c[1], onChange: function (e) { var r = Object.assign({}, rasc); r[c[0]] = e.target.value; setRasc(r); } }),
          h('div', { className: 'k1-row' }, h(K.Button, { variant: 'secondary', onClick: function () { salvar(c[0], c[2]); } }, 'Salvar'),
            msgs[c[0]] && h('span', { className: msgs[c[0]] === 'Salvo.' ? 'rotulo' : 'erro' }, msgs[c[0]])));
      }));
  }

  function App() {
    var st = useState(lerToken()), token = st[0], setToken = st[1];
    var sl = useState(null), lojas = sl[0], setLojas = sl[1];
    var sa = useState(null), loja = sa[0], setLoja = sa[1];
    var sb = useState('Reservas'), aba = sb[0], setAba = sb[1];
    useEffect(function () {
      if (!token) return;
      api(token, 'GET', '/lojas').then(function (l) { setLojas(l); setLoja(function (a) { return a || (l[0] && l[0].id); }); })
        .catch(function () { gravarToken(''); setToken(''); });
    }, [token]);
    if (!token || !lojas) return token ? h('div', { className: 'pagina' }, h(K.EmptyState, null, 'Carregando…')) : h(Login, { onEntrar: function (t, l) { setToken(t); setLojas(l); setLoja(l[0] && l[0].id); } });
    var nome = (lojas.filter(function (l) { return l.id === loja; })[0] || {}).nome || '';
    var tela = aba === 'Reservas' ? Reservas : aba === 'Mapa de mesas' ? Mapa : aba === 'Configuração' ? Configuracao : Agentes;
    return h('div', null,
      h(K.TopBar, { logoSrc: '/app/logo.png', unit: nome, modules: ['Atendimento', 'Alimentos e Bebidas'], active: aba === 'Agentes' ? 'Atendimento' : 'Alimentos e Bebidas', user: 'Equipe', initials: 'EQ' }),
      h(K.Tabs, { items: ['Reservas', 'Mapa de mesas', 'Configuração', 'Agentes'], value: aba, onChange: setAba }),
      h('main', { className: 'pagina' },
        h('div', { className: 'k1-row' }, h('h1', null, aba + ' · ' + nome),
          h(K.Segmented, { items: lojas.map(function (l) { return l.nome; }), value: nome, onChange: function (n) { var l = lojas.filter(function (x) { return x.nome === n; })[0]; if (l) setLoja(l.id); } }),
          h(K.Button, { variant: 'ghost', onClick: function () { gravarToken(''); setToken(''); setLojas(null); } }, 'Sair')),
        h(tela, { token: token, loja: loja, key: aba + loja })));
  }

  ReactDOM.createRoot(document.getElementById('root')).render(h(App));
})();
