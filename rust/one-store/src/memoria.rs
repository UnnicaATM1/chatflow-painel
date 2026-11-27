//! Repositório em memória (espelha `src/repositorio.js`).

use crate::modelo::{
    Ambiente, Chave, Credencial, Empresa, Mesa, Modulos, Reserva, Sessao, Usuario,
};
use crate::plataforma::{Plataforma, codigo_curto, codigo_seguinte, iso_ms, uuid};
use crate::{
    CriarItem, CriarReserva, ExcluirReserva, Json, Muda, RemoverLayout, RenomearAmbiente,
    Repositorio,
};
use serde_json::Map;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};

/// Sumidouro de auditoria: chamado com cada evento de histórico gravado (o adaptador grava em arquivo).
pub type Sink = Arc<dyn Fn(&Json) + Send + Sync>;

/// Base de conhecimento de uma empresa. Fica fora de `Empresa` para que ler a empresa (toda requisição) não copie
/// os itens, que podem ter documentos de vários MB.
#[derive(Default)]
struct Conh {
    itens: Vec<Json>,
    prox: i64,
}

/// Validade padrão das respostas de idempotência: 24 horas.
pub const IDEMPOTENCIA_TTL_PADRAO_MS: i64 = 24 * 60 * 60 * 1000;
/// Teto padrão de respostas de idempotência guardadas por empresa (as mais antigas saem primeiro).
pub const IDEMPOTENCIA_MAX_PADRAO: usize = 10_000;

/// Respostas de idempotência de uma empresa: o mapa e a fila de gravação (a mais antiga na frente).
/// Cada gravação leva um número de sequência; a fila pode ter entradas velhas de chaves regravadas, que se
/// reconhecem por o número não bater com o do mapa. A fila é compactada quando passa do dobro do mapa.
#[derive(Default)]
struct Idem {
    mapa: HashMap<String, (Json, i64, u64)>,
    fila: VecDeque<(String, u64)>,
    seq: u64,
}

impl Idem {
    /// Resposta guardada, ou `None` se não existe ou já venceu (e então é esquecida).
    fn obter(&mut self, chave: &str, agora: i64, ttl: i64) -> Option<Json> {
        let (_, quando, _) = self.mapa.get(chave)?;
        if agora - quando >= ttl {
            self.mapa.remove(chave);
            return None;
        }
        self.mapa.get(chave).map(|(r, _, _)| r.clone())
    }

    /// Guarda a resposta; descarta o que já venceu e, passando do teto, as entradas mais antigas.
    fn gravar(&mut self, chave: &str, resposta: Json, agora: i64, ttl: i64, max: usize) {
        self.seq += 1;
        self.mapa
            .insert(chave.to_string(), (resposta, agora, self.seq));
        self.fila.push_back((chave.to_string(), self.seq));
        while let Some((k, n)) = self.fila.front() {
            match self.mapa.get(k) {
                Some((_, _, atual)) if atual != n => {
                    self.fila.pop_front();
                }
                None => {
                    self.fila.pop_front();
                }
                Some((_, quando, _)) if agora - quando >= ttl || self.mapa.len() > max => {
                    let k = k.clone();
                    self.mapa.remove(&k);
                    self.fila.pop_front();
                }
                Some(_) => break,
            }
        }
        if self.fila.len() > 2 * self.mapa.len() + 16 {
            let mapa = &self.mapa;
            self.fila
                .retain(|(k, n)| mapa.get(k).is_some_and(|(_, _, atual)| atual == n));
        }
    }
}

#[derive(Default)]
struct Estado {
    empresas: Vec<Empresa>,
    conhecimento: HashMap<String, Conh>,
    reservas: Vec<Reserva>,
    idempotencia: HashMap<String, Idem>,
    historico: Vec<Json>,
    /// Códigos de reserva já emitidos por empresa. Sobrevive a cancelamentos e à exclusão da empresa: nunca reaproveita.
    codigos: HashMap<String, HashSet<String>>,
    tent_n: u32,
    tent_ate: i64,
    usuarios: Vec<Usuario>,
    sessoes: HashMap<String, Sessao>,
}

pub struct Memoria {
    plat: Arc<dyn Plataforma>,
    sink: Option<Sink>,
    boot: String,
    ttl_idem: i64,
    max_idem: usize,
    estado: Mutex<Estado>,
}

fn sobrepoe(r: &Reserva, mesa: &str, ini: i64, fim: i64, ignorar: Option<&str>) -> bool {
    ignorar != Some(r.id.as_str())
        && r.mesa_id.as_deref() == Some(mesa)
        && r.status == "confirmada"
        && ini < r.fim
        && fim > r.inicio
}

impl Estado {
    fn ocupada(
        &self,
        empresa: &str,
        mesa: &str,
        ini: i64,
        fim: i64,
        ignorar: Option<&str>,
    ) -> bool {
        self.reservas
            .iter()
            .any(|r| r.empresa_id == empresa && sobrepoe(r, mesa, ini, fim, ignorar))
    }
    fn empresa_mut(&mut self, id: &str) -> Option<&mut Empresa> {
        self.empresas.iter_mut().find(|e| e.id == id)
    }

    fn mesa_reservavel(&self, empresa: &str, ambiente: &str, mesa: &str, pessoas: i64) -> bool {
        self.empresas
            .iter()
            .find(|e| e.id == empresa)
            .and_then(|e| e.ambientes.iter().find(|a| a.nome == ambiente))
            .is_some_and(|a| {
                a.mesas
                    .iter()
                    .any(|m| m.id == mesa && m.reservavel && m.capacidade >= pessoas)
            })
    }

    fn desvincular_mesas(
        &mut self,
        empresa_id: &str,
        ids: &HashSet<&str>,
        agora: i64,
    ) -> Result<Vec<(String, String)>, Vec<String>> {
        let mut vinculadas: Vec<_> = self
            .reservas
            .iter_mut()
            .filter(|r| {
                r.empresa_id == empresa_id && r.mesa_id.as_deref().is_some_and(|m| ids.contains(m))
            })
            .collect();
        let mut ativas: Vec<_> = vinculadas
            .iter()
            .filter(|r| r.status == "confirmada" && r.fim > agora)
            .map(|r| r.id.clone())
            .collect();
        if !ativas.is_empty() {
            ativas.sort_unstable();
            return Err(ativas);
        }
        Ok(vinculadas
            .iter_mut()
            .filter_map(|r| r.mesa_id.take().map(|mesa| (r.id.clone(), mesa)))
            .collect())
    }
}

impl Memoria {
    pub fn nova(plat: Arc<dyn Plataforma>, sink: Option<Sink>) -> Self {
        let boot = uuid(plat.as_ref());
        Self {
            plat,
            sink,
            boot,
            ttl_idem: IDEMPOTENCIA_TTL_PADRAO_MS,
            max_idem: IDEMPOTENCIA_MAX_PADRAO,
            estado: Mutex::new(Estado::default()),
        }
    }

    /// Muda a validade (ms) e o teto por empresa das respostas de idempotência (valores 0 mantêm o padrão).
    #[must_use]
    pub fn com_idempotencia(mut self, ttl_ms: i64, max: usize) -> Self {
        if ttl_ms > 0 {
            self.ttl_idem = ttl_ms;
        }
        if max > 0 {
            self.max_idem = max;
        }
        self
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
        est.conhecimento.insert(
            e.id.clone(),
            Conh {
                itens: Vec::new(),
                prox: 1,
            },
        );
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
        e.ambientes.push(Ambiente {
            nome: nome.to_string(),
            mesas: Vec::new(),
        });
        true
    }

    async fn ambiente_renomear(
        &self,
        empresa_id: &str,
        ambiente_id: &str,
        nome: &str,
    ) -> RenomearAmbiente {
        let mut est = self.est();
        let Some(e) = est.empresa_mut(empresa_id) else {
            return RenomearAmbiente::Inexistente;
        };
        let Some(pos) = e.ambientes.iter().position(|a| a.nome == ambiente_id) else {
            return RenomearAmbiente::Inexistente;
        };
        let normalizado = nome.to_lowercase();
        if e.ambientes
            .iter()
            .enumerate()
            .any(|(i, a)| i != pos && a.nome.to_lowercase() == normalizado)
        {
            return RenomearAmbiente::NomeDuplicado;
        }
        e.ambientes[pos].nome = nome.to_string();
        let atualizado = e.ambientes[pos].clone();
        for r in &mut est.reservas {
            if r.empresa_id == empresa_id && r.ambiente == ambiente_id {
                r.ambiente = nome.to_string();
            }
        }
        RenomearAmbiente::Ok(atualizado)
    }

    async fn ambiente_remover(
        &self,
        empresa_id: &str,
        ambiente_id: &str,
        agora: i64,
    ) -> RemoverLayout<Ambiente> {
        let mut est = self.est();
        let Some(empresa_pos) = est.empresas.iter().position(|e| e.id == empresa_id) else {
            return RemoverLayout::Inexistente;
        };
        let ambientes = &est.empresas[empresa_pos].ambientes;
        let Some(pos) = ambientes.iter().position(|a| a.nome == ambiente_id) else {
            return RemoverLayout::Inexistente;
        };
        let ids: Vec<_> = ambientes[pos].mesas.iter().map(|m| m.id.clone()).collect();
        match est.desvincular_mesas(empresa_id, &ids.iter().map(String::as_str).collect(), agora) {
            Ok(reservas) => {
                RemoverLayout::Ok(est.empresas[empresa_pos].ambientes.remove(pos), reservas)
            }
            Err(ativas) => RemoverLayout::ReservasAtivas(ativas),
        }
    }

    async fn mesa_remover(
        &self,
        empresa_id: &str,
        mesa_id: &str,
        agora: i64,
    ) -> RemoverLayout<(Mesa, String)> {
        let mut est = self.est();
        let Some(empresa_pos) = est.empresas.iter().position(|e| e.id == empresa_id) else {
            return RemoverLayout::Inexistente;
        };
        let ambientes = &est.empresas[empresa_pos].ambientes;
        let Some((ambiente_pos, mesa_pos)) = ambientes
            .iter()
            .enumerate()
            .find_map(|(i, a)| a.mesas.iter().position(|m| m.id == mesa_id).map(|j| (i, j)))
        else {
            return RemoverLayout::Inexistente;
        };
        match est.desvincular_mesas(empresa_id, &HashSet::from([mesa_id]), agora) {
            Ok(reservas) => {
                let ambiente = &mut est.empresas[empresa_pos].ambientes[ambiente_pos];
                RemoverLayout::Ok(
                    (ambiente.mesas.remove(mesa_pos), ambiente.nome.clone()),
                    reservas,
                )
            }
            Err(ativas) => RemoverLayout::ReservasAtivas(ativas),
        }
    }

    async fn mesa_criar(
        &self,
        empresa_id: &str,
        ambiente: &str,
        capacidade: i64,
        reservavel: bool,
        descricao: &str,
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
            descricao: descricao.to_string(),
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
        descricao: Option<&str>,
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
        if let Some(d) = descricao {
            mesa.descricao = d.to_string();
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

    async fn reserva_obter(&self, empresa_id: &str, id: &str) -> Option<Reserva> {
        self.est()
            .reservas
            .iter()
            .find(|r| r.id == id && r.empresa_id == empresa_id)
            .cloned()
    }

    async fn reserva_confirmadas(
        &self,
        empresa_id: &str,
        ignorar_id: Option<&str>,
    ) -> Vec<Reserva> {
        self.est()
            .reservas
            .iter()
            .filter(|r| {
                r.empresa_id == empresa_id
                    && r.status == "confirmada"
                    && ignorar_id != Some(r.id.as_str())
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
        let agora = self.plat.agora_ms();
        if let Some(c) = chave
            && let Some(r) = est
                .idempotencia
                .get_mut(empresa_id)
                .and_then(|i| i.obter(c, agora, self.ttl_idem))
        {
            return CriarReserva::Repetida(r);
        }
        for (mesa, ambiente) in candidatas {
            if !est.mesa_reservavel(empresa_id, &ambiente, &mesa, nova.pessoas)
                || est.ocupada(empresa_id, &mesa, nova.inicio, nova.fim, None)
            {
                continue;
            }
            let mut codigo = codigo_curto(self.plat.as_ref());
            let mut tentativas = 0;
            while est
                .codigos
                .get(empresa_id)
                .is_some_and(|c| c.contains(&codigo))
            {
                tentativas += 1;
                codigo = if tentativas < 32 {
                    codigo_curto(self.plat.as_ref())
                } else {
                    codigo_seguinte(&codigo)
                };
            }
            est.codigos
                .entry(empresa_id.to_string())
                .or_default()
                .insert(codigo.clone());
            let r = Reserva {
                id: codigo,
                uuid: uuid(self.plat.as_ref()),
                empresa_id: empresa_id.to_string(),
                mesa_id: Some(mesa.clone()),
                ambiente: ambiente.clone(),
                status: "confirmada".into(),
                ..nova
            };
            let mut resp = Map::new();
            resp.insert("status".into(), "confirmada".into());
            resp.insert("reservaId".into(), r.id.clone().into());
            resp.insert("mesa".into(), mesa.into());
            resp.insert("ambiente".into(), ambiente.into());
            let resposta = Json::Object(resp);
            est.reservas.push(r.clone());
            if let Some(c) = chave {
                est.idempotencia
                    .entry(empresa_id.to_string())
                    .or_default()
                    .gravar(c, resposta.clone(), agora, self.ttl_idem, self.max_idem);
            }
            return CriarReserva::Criada {
                resposta,
                reserva: r,
            };
        }
        CriarReserva::Conflito
    }

    async fn idempotencia_obter(&self, empresa_id: &str, chave: &str) -> Option<Json> {
        let agora = self.plat.agora_ms();
        self.est()
            .idempotencia
            .get_mut(empresa_id)?
            .obter(chave, agora, self.ttl_idem)
    }

    async fn idempotencia_gravar(&self, empresa_id: &str, chave: &str, resposta: Json) {
        let agora = self.plat.agora_ms();
        self.est()
            .idempotencia
            .entry(empresa_id.to_string())
            .or_default()
            .gravar(chave, resposta, agora, self.ttl_idem, self.max_idem);
    }

    async fn idempotencia_tamanho(&self, empresa_id: &str) -> usize {
        self.est()
            .idempotencia
            .get(empresa_id)
            .map_or(0, |i| i.mapa.len())
    }

    async fn reserva_editar(
        &self,
        empresa_id: &str,
        id: &str,
        dados: Reserva,
        nome_cliente: Option<String>,
        contato: Option<String>,
    ) -> Muda {
        let mut est = self.est();
        let Some(mesa_id) = dados.mesa_id.as_deref() else {
            return Muda::Conflito;
        };
        if !est.mesa_reservavel(empresa_id, &dados.ambiente, mesa_id, dados.pessoas)
            || est.ocupada(empresa_id, mesa_id, dados.inicio, dados.fim, Some(id))
        {
            return Muda::Conflito;
        }
        let Some(r) = est
            .reservas
            .iter_mut()
            .find(|r| r.id == id && r.empresa_id == empresa_id && r.status == "confirmada")
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

    async fn reserva_cancelar(&self, empresa_id: &str, id: &str) -> Option<Reserva> {
        let mut est = self.est();
        let r = est
            .reservas
            .iter_mut()
            .find(|r| r.id == id && r.empresa_id == empresa_id)?;
        r.status = "cancelada".into();
        Some(r.clone())
    }

    async fn reserva_reativar(&self, empresa_id: &str, id: &str) -> Muda {
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
        let Some(mesa_id) = atual.mesa_id.as_deref() else {
            return Muda::Conflito;
        };
        if !est.mesa_reservavel(empresa_id, &atual.ambiente, mesa_id, atual.pessoas)
            || est.ocupada(empresa_id, mesa_id, atual.inicio, atual.fim, Some(id))
        {
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

    async fn reserva_excluir(&self, empresa_id: &str, id: &str) -> ExcluirReserva {
        let mut est = self.est();
        let Some(pos) = est
            .reservas
            .iter()
            .position(|r| r.empresa_id == empresa_id && r.id == id)
        else {
            return ExcluirReserva::Inexistente;
        };
        if est.reservas[pos].status != "cancelada" {
            return ExcluirReserva::Ativa;
        }
        ExcluirReserva::Ok(est.reservas.remove(pos))
    }

    async fn conhecimento_listar(&self, empresa_id: &str) -> Vec<Json> {
        self.est()
            .conhecimento
            .get(empresa_id)
            .map(|c| c.itens.clone())
            .unwrap_or_default()
    }

    async fn conhecimento_obter(&self, empresa_id: &str, id: i64) -> Option<Json> {
        let est = self.est();
        est.conhecimento
            .get(empresa_id)?
            .itens
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
        let Some(c) = est.conhecimento.get_mut(empresa_id) else {
            return CriarItem::Limite;
        };
        if c.itens.len() >= max_itens {
            return CriarItem::Limite;
        }
        let mut m = Map::new();
        m.insert("id".into(), c.prox.into());
        if let Json::Object(o) = item {
            for (k, v) in o {
                m.insert(k, v);
            }
        }
        c.prox += 1;
        let novo = Json::Object(m);
        c.itens.push(novo.clone());
        CriarItem::Ok(novo)
    }

    async fn conhecimento_editar(
        &self,
        empresa_id: &str,
        id: i64,
        mudancas: Vec<(String, Json)>,
    ) -> Option<Json> {
        let mut est = self.est();
        let item = est
            .conhecimento
            .get_mut(empresa_id)?
            .itens
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
        let c = est.conhecimento.get_mut(empresa_id)?;
        let pos = c
            .itens
            .iter()
            .position(|i| i.get("id").and_then(Json::as_i64) == Some(id))?;
        Some(c.itens.remove(pos))
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
        est.conhecimento.remove(id);
        est.reservas.retain(|r| r.empresa_id != id);
        est.idempotencia.remove(id);
        for u in &mut est.usuarios {
            u.empresas.retain(|e| e != id);
        }
        self.acrescentar(&mut est, &evento)
    }

    async fn usuario_criar(&self, mut u: Usuario) -> Result<Usuario, ()> {
        let mut est = self.est();
        if est.usuarios.iter().any(|x| x.email == u.email) {
            return Err(());
        }
        let existentes: Vec<String> = est.empresas.iter().map(|e| e.id.clone()).collect();
        u.empresas.retain(|e| existentes.contains(e));
        u.empresas.sort();
        u.empresas.dedup();
        est.usuarios.push(u.clone());
        Ok(u)
    }

    async fn usuario_por_email(&self, email: &str) -> Option<Usuario> {
        self.est()
            .usuarios
            .iter()
            .find(|u| u.email == email)
            .cloned()
    }

    async fn usuario_obter(&self, id: &str) -> Option<Usuario> {
        self.est().usuarios.iter().find(|u| u.id == id).cloned()
    }

    async fn usuario_listar(&self) -> Vec<Usuario> {
        self.est().usuarios.clone()
    }

    async fn usuario_atualizar(
        &self,
        id: &str,
        nome: Option<String>,
        papel: Option<String>,
        ativo: Option<bool>,
        empresas: Option<Vec<String>>,
    ) -> Option<Usuario> {
        let mut est = self.est();
        let existentes: Vec<String> = est.empresas.iter().map(|e| e.id.clone()).collect();
        let u = est.usuarios.iter_mut().find(|u| u.id == id)?;
        if let Some(n) = nome {
            u.nome = n;
        }
        if let Some(p) = papel {
            u.papel = p;
        }
        if let Some(a) = ativo {
            u.ativo = a;
        }
        if let Some(mut e) = empresas {
            e.retain(|x| existentes.contains(x));
            e.sort();
            e.dedup();
            u.empresas = e;
        }
        Some(u.clone())
    }

    async fn usuario_senha_definir(&self, id: &str, c: Credencial) -> bool {
        let mut est = self.est();
        match est.usuarios.iter_mut().find(|u| u.id == id) {
            Some(u) => {
                u.senha_hash = c.senha_hash;
                u.salt = c.salt;
                u.iteracoes = c.iteracoes;
                true
            }
            None => false,
        }
    }

    async fn usuario_login_marcar(&self, id: &str, quando: &str) {
        if let Some(u) = self.est().usuarios.iter_mut().find(|u| u.id == id) {
            u.ultimo_login = Some(quando.to_string());
        }
    }

    async fn usuario_superadmins_ativos(&self) -> Vec<String> {
        self.est()
            .usuarios
            .iter()
            .filter(|u| u.papel == "superadmin" && u.ativo)
            .map(|u| u.id.clone())
            .collect()
    }

    async fn sessao_criar(&self, hash: &str, s: Sessao) {
        self.est().sessoes.insert(hash.to_string(), s);
    }

    async fn sessao_por_hash(&self, hash: &str) -> Option<Sessao> {
        self.est().sessoes.get(hash).cloned()
    }

    async fn sessao_reautenticar(&self, hash: &str, quando: &str) {
        if let Some(s) = self.est().sessoes.get_mut(hash) {
            s.reautenticado_em = Some(quando.to_string());
        }
    }

    async fn sessao_remover(&self, hash: &str) {
        self.est().sessoes.remove(hash);
    }

    async fn sessoes_remover_do_usuario(&self, usuario_id: &str, exceto: Option<&str>) {
        self.est()
            .sessoes
            .retain(|h, s| s.usuario_id != usuario_id || Some(h.as_str()) == exceto);
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

#[cfg(test)]
mod testes {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use serde_json::json;
    use std::future::Future;
    use std::pin::pin;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::task::{Context, Poll, Waker};

    /// Relógio que o teste move à mão.
    struct Relogio(AtomicI64);

    impl Plataforma for Relogio {
        fn agora_ms(&self) -> i64 {
            self.0.load(Ordering::SeqCst)
        }
        fn aleatorio(&self, n: usize) -> Vec<u8> {
            vec![7; n]
        }
    }

    fn bloquear<F: Future>(f: F) -> F::Output {
        let mut f = pin!(f);
        let mut cx = Context::from_waker(Waker::noop());
        loop {
            if let Poll::Ready(v) = f.as_mut().poll(&mut cx) {
                return v;
            }
        }
    }

    fn repo(ttl: i64, max: usize) -> (Memoria, Arc<Relogio>) {
        let r = Arc::new(Relogio(AtomicI64::new(1_000_000)));
        let m = Memoria::nova(r.clone(), None).com_idempotencia(ttl, max);
        semear_empresa(&m, "e1");
        semear_empresa(&m, "e2");
        (m, r)
    }

    fn semear_empresa(m: &Memoria, id: &str) {
        bloquear(m.empresa_criar(Empresa::nova(
            id,
            id,
            json!({}),
            vec![Ambiente {
                nome: "salao".into(),
                mesas: vec![Mesa {
                    id: "S1".into(),
                    capacidade: 4,
                    reservavel: true,
                    descricao: String::new(),
                }],
            }],
            Modulos::default(),
        )));
    }

    #[test]
    fn resposta_vencida_some_e_a_chave_e_esquecida() {
        let (m, rel) = repo(60_000, 100);
        bloquear(m.idempotencia_gravar("e1", "k1", json!({ "n": 1 })));
        rel.0.fetch_add(59_999, Ordering::SeqCst);
        assert_eq!(
            bloquear(m.idempotencia_obter("e1", "k1")),
            Some(json!({ "n": 1 }))
        );
        rel.0.fetch_add(1, Ordering::SeqCst);
        assert_eq!(bloquear(m.idempotencia_obter("e1", "k1")), None);
        assert_eq!(bloquear(m.idempotencia_tamanho("e1")), 0);
    }

    #[test]
    fn gravar_varre_o_que_ja_venceu() {
        let (m, rel) = repo(1000, 100);
        for i in 0..50 {
            bloquear(m.idempotencia_gravar("e1", &format!("k{i}"), json!({ "i": i })));
        }
        rel.0.fetch_add(1000, Ordering::SeqCst);
        bloquear(m.idempotencia_gravar("e1", "nova", json!({ "i": "nova" })));
        assert_eq!(bloquear(m.idempotencia_tamanho("e1")), 1);
    }

    #[test]
    fn teto_por_empresa_e_respeitado_e_as_mais_antigas_saem_primeiro() {
        let (m, rel) = repo(3_600_000, 3);
        for i in 1..=5 {
            rel.0.fetch_add(10, Ordering::SeqCst);
            bloquear(m.idempotencia_gravar("e1", &format!("k{i}"), json!({ "i": i })));
        }
        bloquear(m.idempotencia_gravar("e2", "x", json!({ "x": 1 })));
        assert_eq!(bloquear(m.idempotencia_tamanho("e1")), 3);
        assert_eq!(bloquear(m.idempotencia_obter("e1", "k1")), None);
        assert_eq!(bloquear(m.idempotencia_obter("e1", "k2")), None);
        for i in 3..=5 {
            assert_eq!(
                bloquear(m.idempotencia_obter("e1", &format!("k{i}"))),
                Some(json!({ "i": i }))
            );
        }
        assert_eq!(
            bloquear(m.idempotencia_obter("e2", "x")),
            Some(json!({ "x": 1 })),
            "o teto é por empresa"
        );
        // regravar a chave a torna a mais nova
        bloquear(m.idempotencia_gravar("e1", "k3", json!({ "i": "3b" })));
        bloquear(m.idempotencia_gravar("e1", "k6", json!({ "i": 6 })));
        assert_eq!(
            bloquear(m.idempotencia_obter("e1", "k3")),
            Some(json!({ "i": "3b" }))
        );
        assert_eq!(bloquear(m.idempotencia_obter("e1", "k4")), None);
        assert_eq!(bloquear(m.idempotencia_tamanho("e1")), 3);
    }

    #[test]
    fn a_fila_nao_cresce_com_a_mesma_chave_regravada() {
        let (m, _) = repo(3_600_000, 5);
        for _ in 0..1000 {
            bloquear(m.idempotencia_gravar("e1", "mesma", json!({ "a": 1 })));
        }
        let est = m.est();
        assert_eq!(est.idempotencia["e1"].mapa.len(), 1);
        assert!(
            est.idempotencia["e1"].fila.len() <= 6,
            "fila: {}",
            est.idempotencia["e1"].fila.len()
        );
    }

    fn nova_reserva(inicio: i64) -> Reserva {
        Reserva {
            id: String::new(),
            uuid: String::new(),
            empresa_id: "e1".into(),
            mesa_id: None,
            ambiente: String::new(),
            data: "2026-11-20".into(),
            horario: "20:00".into(),
            pessoas: 2,
            inicio,
            fim: inicio + 90,
            status: "confirmada".into(),
            nome_cliente: None,
            contato: None,
        }
    }

    /// Plataforma que entrega primeiro os sorteios combinados e depois bytes fixos.
    struct Roteiro {
        fila: Mutex<VecDeque<Vec<u8>>>,
    }

    impl Plataforma for Roteiro {
        fn agora_ms(&self) -> i64 {
            1_000_000
        }
        fn aleatorio(&self, n: usize) -> Vec<u8> {
            let mut f = self.fila.lock().unwrap();
            let mut v = f.pop_front().unwrap_or_else(|| vec![5; n]);
            v.resize(n, 5);
            v
        }
    }

    fn repo_roteiro(sorteios: Vec<u8>) -> Memoria {
        // o primeiro sorteio é consumido por `Memoria::nova` (identificador de boot)
        let fila = std::iter::once(9)
            .chain(sorteios)
            .map(|b| vec![b; 16])
            .collect();
        let m = Memoria::nova(
            Arc::new(Roteiro {
                fila: Mutex::new(fila),
            }),
            None,
        );
        semear_empresa(&m, "e1");
        m
    }

    fn criar(m: &Memoria, empresa: &str, inicio: i64) -> Reserva {
        let cand = vec![("S1".to_string(), "salao".to_string())];
        let mut nova = nova_reserva(inicio);
        nova.empresa_id = empresa.into();
        match bloquear(m.reserva_criar(empresa, None, cand, nova)) {
            CriarReserva::Criada { reserva, .. } => reserva,
            _ => panic!("devia criar"),
        }
    }

    #[test]
    fn codigo_tem_8_caracteres_do_alfabeto_e_o_uuid_nunca_sai_na_resposta() {
        let (m, _) = repo(60_000, 100);
        let cand = vec![("S1".to_string(), "salao".to_string())];
        for i in 0..50 {
            let CriarReserva::Criada { resposta, reserva } =
                bloquear(m.reserva_criar("e1", None, cand.clone(), nova_reserva(1000 + i * 100)))
            else {
                panic!("devia criar")
            };
            assert_eq!(reserva.id.len(), 8);
            assert!(
                reserva
                    .id
                    .bytes()
                    .all(|b| crate::plataforma::ALFABETO_CODIGO.contains(&b))
            );
            assert_eq!(resposta["reservaId"], json!(reserva.id));
            assert_eq!(reserva.uuid.len(), 36);
            assert_eq!(&reserva.uuid[14..15], "4");
            assert!(!resposta.to_string().contains(&reserva.uuid));
            assert_ne!(reserva.id, reserva.uuid);
        }
    }

    #[test]
    fn codigos_sao_unicos_por_empresa_mesmo_com_plataforma_de_valores_fixos() {
        let (m, _) = repo(60_000, 100); // aleatorio() devolve sempre os mesmos bytes: só o desempate separa os códigos
        let mut vistos = std::collections::HashSet::new();
        for i in 0..200 {
            assert!(
                vistos.insert(criar(&m, "e1", 1000 + i * 100).id),
                "código repetido"
            );
        }
        // outra empresa tem o próprio conjunto: o primeiro sorteio dela pode coincidir com o de e1
        assert!(vistos.contains(&criar(&m, "e2", 1000).id));
    }

    #[test]
    fn colisao_sorteia_de_novo() {
        // sorteio 1: reserva 1 (código, uuid); 2: reserva 2 repete o código (colide) e sorteia outro
        let m = repo_roteiro(vec![0, 9, 0, 1, 9]);
        assert_eq!(criar(&m, "e1", 1000).id, "22222222");
        assert_eq!(criar(&m, "e1", 2000).id, "33333333");
    }

    #[test]
    fn codigo_nao_e_reaproveitado_apos_excluir_a_reserva_ou_a_empresa() {
        let m = repo_roteiro(vec![0, 9, 0, 1, 9, 0, 2, 9]);
        let r1 = criar(&m, "e1", 1000);
        assert_eq!(r1.id, "22222222");
        assert!(bloquear(m.reserva_cancelar("e1", &r1.id)).is_some());
        assert!(matches!(
            bloquear(m.reserva_excluir("e1", &r1.id)),
            ExcluirReserva::Ok(_)
        ));
        assert_eq!(
            criar(&m, "e1", 2000).id,
            "33333333",
            "a exclusão definitiva mantém o código emitido"
        );
        bloquear(m.empresa_excluir("e1", json!({ "empresaId": "e1", "acao": "excluida" })));
        assert!(bloquear(m.reserva_obter("e1", "22222222")).is_none());
        semear_empresa(&m, "e1");
        assert_eq!(
            criar(&m, "e1", 3000).id,
            "44444444",
            "excluir a empresa não libera os códigos"
        );
    }

    #[test]
    fn reserva_e_achada_pelo_codigo_e_nunca_pelo_uuid() {
        let (m, _) = repo(60_000, 100);
        let r = criar(&m, "e1", 1000);
        assert!(bloquear(m.reserva_obter("e1", &r.id)).is_some());
        assert!(bloquear(m.reserva_obter("e1", &r.uuid)).is_none());
        assert!(
            bloquear(m.reserva_obter("e2", &r.id)).is_none(),
            "o código vale só na empresa dela"
        );
        assert!(bloquear(m.reserva_obter("e1", "1")).is_none());
    }

    #[test]
    fn mesma_chave_dentro_da_validade_repete_a_resposta_identica_e_vencida_e_tratada_de_novo() {
        let (m, rel) = repo(3_600_000, 100);
        let cand = vec![("S1".to_string(), "salao".to_string())];
        let CriarReserva::Criada { resposta, .. } =
            bloquear(m.reserva_criar("e1", Some("k1"), cand.clone(), nova_reserva(1000)))
        else {
            panic!("devia criar")
        };
        rel.0.fetch_add(3_599_999, Ordering::SeqCst);
        let CriarReserva::Repetida(de_novo) =
            bloquear(m.reserva_criar("e1", Some("k1"), cand.clone(), nova_reserva(1000)))
        else {
            panic!("devia repetir")
        };
        assert_eq!(de_novo, resposta);
        assert_eq!(
            bloquear(m.reserva_listar("e1", None)).len(),
            1,
            "sem reserva duplicada"
        );
        rel.0.fetch_add(1, Ordering::SeqCst);
        // vencida: a chave é esquecida e o pedido é tratado de novo (a mesa continua ocupada pela reserva original)
        assert!(matches!(
            bloquear(m.reserva_criar("e1", Some("k1"), cand, nova_reserva(1000))),
            CriarReserva::Conflito
        ));
    }

    #[test]
    fn excluir_a_empresa_apaga_as_respostas_dela() {
        let (m, _) = repo(60_000, 100);
        bloquear(m.idempotencia_gravar("e1", "k", json!({ "a": 1 })));
        bloquear(m.empresa_excluir("e1", json!({ "empresaId": "e1", "acao": "excluida" })));
        assert_eq!(bloquear(m.idempotencia_tamanho("e1")), 0);
    }
}
