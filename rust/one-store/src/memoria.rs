//! Repositório em memória (espelha `src/repositorio.js`).

use crate::modelo::{Chave, Empresa, Mesa, Modulos, Reserva};
use crate::plataforma::{Plataforma, iso_ms, uuid};
use crate::{CriarItem, CriarReserva, Json, Muda, Repositorio};
use serde_json::Map;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

/// Sumidouro de auditoria: chamado com cada evento de histórico gravado (o adaptador grava em arquivo).
pub type Sink = Arc<dyn Fn(&Json) + Send + Sync>;

#[derive(Default)]
struct Estado {
    empresas: Vec<Empresa>,
    reservas: Vec<Reserva>,
    idempotencia: HashMap<String, Json>,
    historico: Vec<Json>,
    seq_reserva: i64,
    tent_n: u32,
    tent_ate: i64,
}

pub struct Memoria {
    plat: Arc<dyn Plataforma>,
    sink: Option<Sink>,
    boot: String,
    estado: Mutex<Estado>,
}

fn sobrepoe(r: &Reserva, mesa: &str, ini: i64, fim: i64, ignorar: Option<i64>) -> bool {
    Some(r.id) != ignorar
        && r.mesa_id == mesa
        && r.status == "confirmada"
        && ini < r.fim
        && fim > r.inicio
}

impl Estado {
    fn ocupada(&self, empresa: &str, mesa: &str, ini: i64, fim: i64, ignorar: Option<i64>) -> bool {
        self.reservas
            .iter()
            .any(|r| r.empresa_id == empresa && sobrepoe(r, mesa, ini, fim, ignorar))
    }
    fn empresa_mut(&mut self, id: &str) -> Option<&mut Empresa> {
        self.empresas.iter_mut().find(|e| e.id == id)
    }
}

impl Memoria {
    pub fn nova(plat: Arc<dyn Plataforma>, sink: Option<Sink>) -> Self {
        let boot = uuid(plat.as_ref());
        Self {
            plat,
            sink,
            boot,
            estado: Mutex::new(Estado::default()),
        }
    }

    /// O lock nunca atravessa um `.await`; um pânico em outra tarefa não deve derrubar as demais.
    fn est(&self) -> MutexGuard<'_, Estado> {
        self.estado.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn acrescentar(&self, est: &mut Estado, ev: &Json) -> Json {
        let mut m = Map::new();
        m.insert("seq".into(), Json::from(est.historico.len() as i64 + 1));
        m.insert("boot".into(), Json::from(self.boot.clone()));
        m.insert("quando".into(), Json::from(iso_ms(self.plat.agora_ms())));
        if let Some(o) = ev.as_object() {
            for (k, v) in o {
                m.insert(k.clone(), v.clone());
            }
        }
        let e = Json::Object(m);
        est.historico.push(e.clone());
        if let Some(s) = &self.sink {
            s(&e);
        }
        e
    }
}

fn texto_de(v: Option<&Json>) -> String {
    match v {
        Some(Json::String(s)) => s.clone(),
        Some(Json::Null) | None => String::new(),
        Some(o) => o.to_string(),
    }
}

/// `Number(limite) || 200`, limitado a 1..1000 (como `Math.min(Math.max(...))` do JavaScript).
fn limite_historico(limite: Option<&str>) -> usize {
    let n = limite.map_or(0.0, |s| {
        let t = s.trim();
        if t.is_empty() {
            0.0
        } else {
            t.parse::<f64>().unwrap_or(f64::NAN)
        }
    });
    let n = if n.is_nan() || n == 0.0 { 200.0 } else { n };
    n.clamp(1.0, 1000.0).trunc() as usize
}

impl Repositorio for Memoria {
    async fn empresa_obter(&self, id: &str) -> Option<Empresa> {
        self.est().empresas.iter().find(|e| e.id == id).cloned()
    }

    async fn empresa_listar(&self) -> Vec<Empresa> {
        self.est().empresas.clone()
    }

    async fn empresa_criar(&self, e: Empresa) -> Empresa {
        let mut est = self.est();
        est.empresas.retain(|x| x.id != e.id);
        est.empresas.push(e.clone());
        e
    }

    async fn empresa_proximo_id(&self) -> String {
        let est = self.est();
        let mut n = est.empresas.len() + 1;
        loop {
            let id = format!("empresa_{n}");
            let usado = est.empresas.iter().any(|e| e.id == id)
                || est
                    .historico
                    .iter()
                    .any(|e| e.get("empresaId").and_then(Json::as_str) == Some(id.as_str()));
            if !usado {
                return id;
            }
            n += 1;
        }
    }

    async fn empresa_nome_em_uso(&self, nome: &str, ignorar_id: Option<&str>) -> bool {
        let n = nome.to_lowercase();
        self.est()
            .empresas
            .iter()
            .any(|x| Some(x.id.as_str()) != ignorar_id && x.nome.to_lowercase() == n)
    }

    async fn empresa_renomear(&self, id: &str, nome: &str) {
        if let Some(e) = self.est().empresa_mut(id) {
            e.nome = nome.to_string();
        }
    }

    async fn empresa_modulos_definir(
        &self,
        id: &str,
        reservas: Option<bool>,
        conhecimento: Option<bool>,
    ) -> Modulos {
        let mut est = self.est();
        let Some(e) = est.empresa_mut(id) else {
            return Modulos::default();
        };
        if let Some(b) = reservas {
            e.modulos.reservas = b;
        }
        if let Some(b) = conhecimento {
            e.modulos.conhecimento = b;
        }
        e.modulos
    }

    async fn agente_atualizar(&self, id: &str, mudancas: Vec<(String, String)>) {
        let mut est = self.est();
        if let Some(Json::Object(a)) = est.empresa_mut(id).map(|e| &mut e.agente) {
            for (k, v) in mudancas {
                a.insert(k, Json::from(v));
            }
        }
    }

    async fn chave_definir(&self, id: &str, chave: Chave) {
        if let Some(e) = self.est().empresa_mut(id) {
            e.chave = Some(chave);
        }
    }

    async fn chave_remover(&self, id: &str) {
        if let Some(e) = self.est().empresa_mut(id) {
            e.chave = None;
        }
    }

    async fn empresa_por_chave_hash(&self, hash: &str) -> Option<String> {
        let est = self.est();
        let mut achada = None;
        for e in &est.empresas {
            // não sai no primeiro: compara todas, em tempo constante por chave
            if let Some(c) = &e.chave
                && iguais_tempo_constante(&c.hash, hash)
                && achada.is_none()
            {
                achada = Some(e.id.clone());
            }
        }
        achada
    }

    async fn ambiente_criar(&self, empresa_id: &str, nome: &str) -> bool {
        let mut est = self.est();
        let Some(e) = est.empresa_mut(empresa_id) else {
            return false;
        };
        let n = nome.to_lowercase();
        if e.ambientes.iter().any(|a| a.nome.to_lowercase() == n) {
            return false;
        }
        e.ambientes.push(crate::modelo::Ambiente {
            nome: nome.to_string(),
            mesas: Vec::new(),
        });
        true
    }

    async fn mesa_criar(
        &self,
        empresa_id: &str,
        ambiente: &str,
        capacidade: i64,
        reservavel: bool,
    ) -> Option<Mesa> {
        let mut est = self.est();
        let e = est.empresa_mut(empresa_id)?;
        let existentes: Vec<String> = e
            .ambientes
            .iter()
            .flat_map(|a| a.mesas.iter().map(|m| m.id.clone()))
            .collect();
        let amb = e.ambientes.iter_mut().find(|a| a.nome == ambiente)?;
        let base = amb
            .nome
            .chars()
            .find(char::is_ascii_alphabetic)
            .map_or('M', |c| c.to_ascii_uppercase());
        let mut n = 1;
        while existentes.contains(&format!("{base}{n}")) {
            n += 1;
        }
        let mesa = Mesa {
            id: format!("{base}{n}"),
            capacidade,
            reservavel,
        };
        amb.mesas.push(mesa.clone());
        Some(mesa)
    }

    async fn mesa_editar(
        &self,
        empresa_id: &str,
        mesa_id: &str,
        capacidade: Option<i64>,
        reservavel: Option<bool>,
    ) -> Option<(Mesa, Mesa)> {
        let mut est = self.est();
        let e = est.empresa_mut(empresa_id)?;
        let mesa = e
            .ambientes
            .iter_mut()
            .flat_map(|a| a.mesas.iter_mut())
            .find(|m| m.id == mesa_id)?;
        let antes = mesa.clone();
        if let Some(c) = capacidade {
            mesa.capacidade = c;
        }
        if let Some(r) = reservavel {
            mesa.reservavel = r;
        }
        Some((antes, mesa.clone()))
    }

    async fn reserva_listar(&self, empresa_id: &str, data: Option<&str>) -> Vec<Reserva> {
        self.est()
            .reservas
            .iter()
            .filter(|r| {
                r.empresa_id == empresa_id && data.is_none_or(|d| d.is_empty() || r.data == d)
            })
            .cloned()
            .collect()
    }

    async fn reserva_obter(&self, empresa_id: &str, id: i64) -> Option<Reserva> {
        self.est()
            .reservas
            .iter()
            .find(|r| r.id == id && r.empresa_id == empresa_id)
            .cloned()
    }

    async fn reserva_confirmadas(&self, empresa_id: &str, ignorar_id: Option<i64>) -> Vec<Reserva> {
        self.est()
            .reservas
            .iter()
            .filter(|r| {
                r.empresa_id == empresa_id && r.status == "confirmada" && Some(r.id) != ignorar_id
            })
            .cloned()
            .collect()
    }

    async fn reserva_criar(
        &self,
        empresa_id: &str,
        chave: Option<&str>,
        candidatas: Vec<(String, String)>,
        nova: Reserva,
    ) -> CriarReserva {
        let mut est = self.est();
        let k = chave.map(|c| format!("{empresa_id}:{c}"));
        if let Some(r) = k.as_ref().and_then(|k| est.idempotencia.get(k)) {
            return CriarReserva::Repetida(r.clone());
        }
        for (mesa, ambiente) in candidatas {
            if est.ocupada(empresa_id, &mesa, nova.inicio, nova.fim, None) {
                continue;
            }
            est.seq_reserva += 1;
            let r = Reserva {
                id: est.seq_reserva,
                empresa_id: empresa_id.to_string(),
                mesa_id: mesa.clone(),
                ambiente: ambiente.clone(),
                status: "confirmada".into(),
                ..nova
            };
            let mut resp = Map::new();
            resp.insert("status".into(), "confirmada".into());
            resp.insert("reservaId".into(), r.id.into());
            resp.insert("mesa".into(), mesa.into());
            resp.insert("ambiente".into(), ambiente.into());
            let resposta = Json::Object(resp);
            est.reservas.push(r.clone());
            if let Some(k) = k {
                est.idempotencia.insert(k, resposta.clone());
            }
            return CriarReserva::Criada {
                resposta,
                reserva: r,
            };
        }
        CriarReserva::Conflito
    }

    async fn idempotencia_obter(&self, empresa_id: &str, chave: &str) -> Option<Json> {
        self.est()
            .idempotencia
            .get(&format!("{empresa_id}:{chave}"))
            .cloned()
    }

    async fn idempotencia_gravar(&self, empresa_id: &str, chave: &str, resposta: Json) {
        self.est()
            .idempotencia
            .insert(format!("{empresa_id}:{chave}"), resposta);
    }

    async fn reserva_editar(
        &self,
        empresa_id: &str,
        id: i64,
        dados: Reserva,
        nome_cliente: Option<String>,
        contato: Option<String>,
    ) -> Muda {
        let mut est = self.est();
        if est.ocupada(
            empresa_id,
            &dados.mesa_id,
            dados.inicio,
            dados.fim,
            Some(id),
        ) {
            return Muda::Conflito;
        }
        let Some(r) = est
            .reservas
            .iter_mut()
            .find(|r| r.id == id && r.empresa_id == empresa_id)
        else {
            return Muda::Conflito;
        };
        r.pessoas = dados.pessoas;
        r.data = dados.data;
        r.horario = dados.horario;
        r.mesa_id = dados.mesa_id;
        r.ambiente = dados.ambiente;
        r.inicio = dados.inicio;
        r.fim = dados.fim;
        if let Some(n) = nome_cliente {
            r.nome_cliente = if n.is_empty() { None } else { Some(n) };
        }
        if let Some(c) = contato {
            r.contato = if c.is_empty() { None } else { Some(c) };
        }
        Muda::Ok(r.clone())
    }

    async fn reserva_cancelar(&self, empresa_id: &str, id: i64) -> Option<Reserva> {
        let mut est = self.est();
        let r = est
            .reservas
            .iter_mut()
            .find(|r| r.id == id && r.empresa_id == empresa_id)?;
        r.status = "cancelada".into();
        Some(r.clone())
    }

    async fn reserva_reativar(&self, empresa_id: &str, id: i64) -> Muda {
        let mut est = self.est();
        let Some(atual) = est
            .reservas
            .iter()
            .find(|r| r.id == id && r.empresa_id == empresa_id)
            .cloned()
        else {
            return Muda::Conflito;
        };
        if atual.status == "confirmada" {
            return Muda::Ok(atual);
        }
        if est.ocupada(
            empresa_id,
            &atual.mesa_id,
            atual.inicio,
            atual.fim,
            Some(id),
        ) {
            return Muda::Conflito;
        }
        match est
            .reservas
            .iter_mut()
            .find(|r| r.id == id && r.empresa_id == empresa_id)
        {
            Some(r) => {
                r.status = "confirmada".into();
                Muda::Ok(r.clone())
            }
            None => Muda::Conflito,
        }
    }

    async fn conhecimento_listar(&self, empresa_id: &str) -> Vec<Json> {
        self.est()
            .empresas
            .iter()
            .find(|e| e.id == empresa_id)
            .map(|e| e.conhecimento.clone())
            .unwrap_or_default()
    }

    async fn conhecimento_obter(&self, empresa_id: &str, id: i64) -> Option<Json> {
        let est = self.est();
        est.empresas
            .iter()
            .find(|e| e.id == empresa_id)?
            .conhecimento
            .iter()
            .find(|i| i.get("id").and_then(Json::as_i64) == Some(id))
            .cloned()
    }

    async fn conhecimento_criar(
        &self,
        empresa_id: &str,
        item: Json,
        max_itens: usize,
    ) -> CriarItem {
        let mut est = self.est();
        let Some(e) = est.empresa_mut(empresa_id) else {
            return CriarItem::Limite;
        };
        if e.conhecimento.len() >= max_itens {
            return CriarItem::Limite;
        }
        let mut m = Map::new();
        m.insert("id".into(), e.prox_conhecimento.into());
        if let Json::Object(o) = item {
            for (k, v) in o {
                m.insert(k, v);
            }
        }
        e.prox_conhecimento += 1;
        let novo = Json::Object(m);
        e.conhecimento.push(novo.clone());
        CriarItem::Ok(novo)
    }

    async fn conhecimento_editar(
        &self,
        empresa_id: &str,
        id: i64,
        mudancas: Vec<(String, Json)>,
    ) -> Option<Json> {
        let mut est = self.est();
        let e = est.empresa_mut(empresa_id)?;
        let item = e
            .conhecimento
            .iter_mut()
            .find(|i| i.get("id").and_then(Json::as_i64) == Some(id))?;
        if let Json::Object(o) = item {
            for (k, v) in mudancas {
                if v.is_null() {
                    o.shift_remove(&k);
                } else {
                    o.insert(k, v);
                }
            }
        }
        Some(item.clone())
    }

    async fn conhecimento_excluir(&self, empresa_id: &str, id: i64) -> Option<Json> {
        let mut est = self.est();
        let e = est.empresa_mut(empresa_id)?;
        let pos = e
            .conhecimento
            .iter()
            .position(|i| i.get("id").and_then(Json::as_i64) == Some(id))?;
        Some(e.conhecimento.remove(pos))
    }

    async fn historico_acrescentar(&self, ev: Json) -> Json {
        let mut est = self.est();
        self.acrescentar(&mut est, &ev)
    }

    async fn historico_listar(
        &self,
        empresa_id: &str,
        entidade: Option<&str>,
        entidade_id: Option<&str>,
        limite: Option<&str>,
    ) -> Vec<Json> {
        let n = limite_historico(limite);
        let est = self.est();
        let filtrados: Vec<&Json> = est
            .historico
            .iter()
            .filter(|e| {
                e.get("empresaId").and_then(Json::as_str) == Some(empresa_id)
                    && entidade.is_none_or(|x| {
                        x.is_empty() || e.get("entidade").and_then(Json::as_str) == Some(x)
                    })
                    && entidade_id
                        .is_none_or(|x| x.is_empty() || texto_de(e.get("entidadeId")) == x)
            })
            .collect();
        let inicio = filtrados.len().saturating_sub(n);
        filtrados[inicio..]
            .iter()
            .rev()
            .map(|e| (*e).clone())
            .collect()
    }

    async fn historico_obter(&self, empresa_id: &str, seq: i64) -> Option<Json> {
        self.est()
            .historico
            .iter()
            .find(|e| {
                e.get("seq").and_then(Json::as_i64) == Some(seq)
                    && e.get("empresaId").and_then(Json::as_str) == Some(empresa_id)
            })
            .cloned()
    }

    async fn historico_desfeito(&self, empresa_id: &str, seq: i64) -> bool {
        self.est().historico.iter().any(|e| {
            e.get("empresaId").and_then(Json::as_str) == Some(empresa_id)
                && e.get("acao").and_then(Json::as_str) == Some("desfeita")
                && e.get("refSeq").and_then(Json::as_i64) == Some(seq)
        })
    }

    async fn historico_excluidas(&self) -> Vec<Json> {
        self.est()
            .historico
            .iter()
            .rev()
            .filter(|e| {
                e.get("acao").and_then(Json::as_str) == Some("excluida")
                    && e.get("entidade").and_then(Json::as_str) == Some("empresa")
            })
            .cloned()
            .collect()
    }

    async fn empresa_excluir(&self, id: &str, evento: Json) -> Json {
        let mut est = self.est();
        est.empresas.retain(|e| e.id != id);
        est.reservas.retain(|r| r.empresa_id != id);
        let prefixo = format!("{id}:");
        est.idempotencia.retain(|k, _| !k.starts_with(&prefixo));
        self.acrescentar(&mut est, &evento)
    }

    async fn tentativas_admin_obter(&self) -> (u32, i64) {
        let est = self.est();
        (est.tent_n, est.tent_ate)
    }

    async fn tentativas_admin_gravar(&self, n: u32, ate: i64) {
        let mut est = self.est();
        est.tent_n = n;
        est.tent_ate = ate;
    }
}

/// Comparação em tempo constante de duas strings (sem sair no primeiro byte diferente).
pub fn iguais_tempo_constante(a: &str, b: &str) -> bool {
    let (x, y) = (a.as_bytes(), b.as_bytes());
    let mut d = x.len() ^ y.len();
    for i in 0..x.len().max(y.len()) {
        d |= usize::from(x.get(i).copied().unwrap_or(0) ^ y.get(i).copied().unwrap_or(0));
    }
    d == 0
}
