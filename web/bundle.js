/* @ds-bundle: {"format":4,"namespace":"ChatFlow","components":[{"name":"Button"},{"name":"Tabs"},{"name":"Segmented"},{"name":"FilterChip"},{"name":"Tag"},{"name":"StatusPill"},{"name":"StatusLegend"},{"name":"ColumnHeader"},{"name":"IssueCard"},{"name":"TaskRow"},{"name":"StatCard"},{"name":"TopBar"},{"name":"EmptyState"},{"name":"ChatFab"}]} */
(function () {
  var R = window.React, h = R.createElement;
  function cx() { return Array.prototype.filter.call(arguments, Boolean).join(" "); }
  function omit(o, keys) { var r = {}; for (var k in o) if (keys.indexOf(k) < 0) r[k] = o[k]; return r; }

  function Button(p) {
    var v = p.variant || "primary";
    return h("button", Object.assign({ type: "button" }, omit(p, ["variant", "size", "accessible", "className"]), {
      className: cx("k1-btn", "k1-btn-" + v, p.size === "lg" && "k1-btn-lg", p.accessible && "k1-a11y", p.className)
    }), p.children);
  }

  function Tabs(p) {
    var st = R.useState(p.value != null ? p.value : (p.items[0] && p.items[0]));
    var cur = p.value != null ? p.value : st[0];
    return h("div", { className: "k1-tabs", role: "tablist" }, p.items.map(function (it) {
      return h("button", { key: it, role: "tab", className: "k1-tab", "aria-selected": String(it === cur),
        onClick: function () { st[1](it); p.onChange && p.onChange(it); } }, it);
    }));
  }

  function Segmented(p) {
    var st = R.useState(p.value != null ? p.value : p.items[0]);
    var cur = p.value != null ? p.value : st[0];
    return h("div", { className: "k1-seg", role: "group" }, p.items.map(function (it) {
      return h("button", { key: it, type: "button", "aria-pressed": String(it === cur),
        onClick: function () { st[1](it); p.onChange && p.onChange(it); } }, it);
    }));
  }

  function FilterChip(p) {
    return h("button", { type: "button", className: cx("k1-chip", p.tone && "k1-chip-" + p.tone), "aria-pressed": String(!!p.active), onClick: p.onClick },
      p.children, p.count != null && h("span", { className: "k1-chip-n" }, p.count));
  }

  var SECTOR = { "A&B": "aeb", "Recepção": "recepcao", "Governança": "governanca", "Manutenção": "manutencao", "RH": "rh", "Financeiro": "financeiro", "Controladoria": "controladoria", "Gerência": "gerencia", "Almoxarifado": "almoxarifado" };
  function Tag(p) {
    if (p.kind === "date") return h("span", { className: "k1-tag k1-tag-date" }, "Prazo", h("b", null, p.children));
    if (p.kind === "priority") return h("span", { className: "k1-tag k1-tag-" + String(p.children).toLowerCase() }, p.children);
    return h("span", { className: cx("k1-tag", SECTOR[p.children] && "k1-tag-" + SECTOR[p.children]) }, p.children);
  }

  var PILL = { "Pendente": "pendente", "Em andamento": "andamento", "Para aprovar": "aprovar", "Concluída": "concluida", "Encerrado": "concluida", "Resolvido": "concluida" };
  function StatusPill(p) { return h("span", { className: "k1-pill k1-pill-" + (PILL[p.children] || "pendente") }, p.children); }

  var EVENT = [["Confirmado", "confirmado"], ["Realizado", "realizado"], ["Pendente", "pendente"], ["Em negociação", "negociacao"], ["Cancelado", "cancelado"], ["No-show", "noshow"], ["Interno", "interno"]];
  function StatusLegend(p) {
    var counts = p.counts || {}, active = p.active || ["Confirmado", "Realizado", "Pendente", "Interno"];
    return h("div", { className: "k1-legend" }, EVENT.map(function (e) {
      return h("div", { key: e[0], className: "k1-legend-item", "data-active": String(active.indexOf(e[0]) >= 0), style: { "--dot": "var(--status-" + e[1] + ")" } },
        h("span", { className: "k1-dot" }), e[0], h("span", { className: "k1-n" }, counts[e[0]] || 0));
    }));
  }

  var COL = { "Pendente": "pendente", "Em andamento": "andamento", "Para aprovar": "aprovar", "Encerrado": "encerrado", "Resolvido": "encerrado", "Aguardando": "aprovar" };
  function ColumnHeader(p) { return h("div", { className: "k1-colhead k1-colhead-" + (COL[p.title] || "pendente") }, p.title, h("span", { className: "k1-n" }, p.count || 0)); }

  function IssueCard(p) {
    var actions = p.actions || ["Iniciar", "Descartar", "Editar"];
    return h("article", { className: "k1-card" },
      h("h4", null, p.title),
      h("div", { className: "k1-row", style: { gap: "6px" } },
        p.priority && h(Tag, { kind: "priority" }, p.priority),
        p.due && h(Tag, { kind: "date" }, p.due),
        p.sector && h(Tag, null, p.sector)),
      h("div", { className: "k1-actions" }, actions.map(function (a, i) {
        return h(Button, { key: a, variant: i === 0 ? "primary" : "secondary" }, a);
      })));
  }

  var BAR = { "Alta": "var(--prio-alta)", "Urgente": "var(--prio-urgente)", "Baixa": "var(--prio-baixa)" };
  function TaskRow(p) {
    var done = p.status === "Concluída";
    var act = p.action || (done ? "Arquivar" : p.status === "Em andamento" ? "Concluir" : "Iniciar");
    return h("div", { className: "k1-task", style: { "--bar": BAR[p.priority] || "var(--ink-muted)" } },
      h("div", { className: "k1-task-main" },
        h("div", { className: "k1-task-title" }, p.title, h(StatusPill, null, p.status || "Pendente"), p.priority && h(Tag, { kind: "priority" }, p.priority)),
        h("div", { className: "k1-task-meta" }, h("span", null, "Para: ", h("b", null, p.assignee || "—")), h("span", null, "Prazo: ", h("b", null, p.due)))),
      h(Button, { variant: act === "Concluir" ? "primary" : act === "Arquivar" ? "secondary" : "neutral" }, act));
  }

  var ACC = { pendente: "var(--status-pendente)", andamento: "var(--status-realizado)", resolvido: "var(--col-encerrado-fg)" };
  function StatCard(p) {
    return h("div", { className: "k1-stat", style: { "--accent": ACC[p.tone] || "var(--border)" } },
      h("div", { className: "k1-v" }, p.value),
      h("div", { className: "k1-l" }, p.tone && h("i"), p.label));
  }

  function TopBar(p) {
    var mods = p.modules || ["Gestão", "Operação", "Atendimento", "Controle", "Pessoas", "Negócio"];
    return h("header", { className: "k1-topbar" },
      p.logoSrc && h("span", { className: "k1-brand" }, h("img", { src: p.logoSrc, alt: "ChatFlow" }), p.brandSub && h("small", null, p.brandSub)),
      h("span", { className: "k1-unit" }, p.unit || "Hotel Demonstração"),
      h("nav", { className: "k1-modules" }, mods.map(function (m) { return h("a", { key: m, href: "#", "aria-current": m === p.active ? "page" : undefined }, m); })),
      h("div", { className: "k1-search" }, "Buscar módulo ou submódulo…"),
      h("div", { className: "k1-hello" }, "Olá, ", h("b", null, p.user || "Revisor"), h("span", { className: "k1-avatar" }, p.initials || "RP")));
  }

  function EmptyState(p) { return h("div", { className: "k1-empty" }, p.children || "Nada aqui."); }

  function ChatFab(p) {
    return h("button", { type: "button", className: "k1-fab", "aria-label": p.label || "Abrir chat" },
      h("svg", { viewBox: "0 0 24 24" }, h("path", { d: "M4 20l1.4-4.2A8 8 0 1 1 8.2 18.6L4 20z", strokeLinejoin: "round" })));
  }

  window.ChatFlow = Object.assign(window.ChatFlow || {}, {
    Button: Button, Tabs: Tabs, Segmented: Segmented, FilterChip: FilterChip, Tag: Tag, StatusPill: StatusPill,
    StatusLegend: StatusLegend, ColumnHeader: ColumnHeader, IssueCard: IssueCard, TaskRow: TaskRow, StatCard: StatCard,
    TopBar: TopBar, EmptyState: EmptyState, ChatFab: ChatFab
  });
})();
