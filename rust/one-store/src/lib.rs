//! `one-store`: modelo de dados, a interface da plataforma e o repositório do ONE.
//!
//! Espelha `src/repositorio.js` e `src/plataforma.js`. O trait [`Repositorio`] é assíncrono (D1 será) e tem as
//! operações atômicas com nome próprio (ver `docs/atomicidade.md`). Hoje só existe a versão em memória ([`Memoria`]).

pub mod memoria;
pub mod modelo;
pub mod plataforma;

pub use memoria::{Memoria, iguais_tempo_constante};
pub use modelo::{Ambiente, Chave, Empresa, Mesa, Modulos, Reserva};
pub use plataforma::{Plataforma, iso_ms};
pub use serde_json::Value as Json;

use std::future::Future;

/// Resultado de [`Repositorio::reserva_criar`].
// valores curtos e passageiros: caixa extra não compensa
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone)]
pub enum CriarReserva {
    /// A chave de idempotência já tinha resposta: nada foi criado.
    Repetida(Json),
    /// Reserva inserida; `resposta` também foi guardada para a chave.
    Criada { resposta: Json, reserva: Reserva },
    /// Todas as mesas candidatas foram tomadas nesse meio-tempo; nada foi gravado.
    Conflito,
}

/// Resultado de operações que rechecam sobreposição de mesa.
// valores curtos e passageiros: caixa extra não compensa
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone)]
pub enum Muda {
    Ok(Reserva),
    Conflito,
}

/// Resultado de [`Repositorio::conhecimento_criar`].
#[derive(Debug, Clone)]
pub enum CriarItem {
    Ok(Json),
    Limite,
}

/// Todas as funções são assíncronas e devolvem valores (cópias). As marcadas ATÔMICA fazem tudo-ou-nada.
pub trait Repositorio: Send + Sync {
    // ---------- empresas ----------
    fn empresa_obter(&self, id: &str) -> impl Future<Output = Option<Empresa>> + Send;
    fn empresa_listar(&self) -> impl Future<Output = Vec<Empresa>> + Send;
    fn empresa_criar(&self, e: Empresa) -> impl Future<Output = Empresa> + Send;
    /// Próximo id livre; ids de empresas excluídas nunca são reaproveitados (confere o histórico).
    fn empresa_proximo_id(&self) -> impl Future<Output = String> + Send;
    fn empresa_nome_em_uso(
        &self,
        nome: &str,
        ignorar_id: Option<&str>,
    ) -> impl Future<Output = bool> + Send;
    fn empresa_renomear(&self, id: &str, nome: &str) -> impl Future<Output = ()> + Send;
    fn empresa_modulos_definir(
        &self,
        id: &str,
        reservas: Option<bool>,
        conhecimento: Option<bool>,
    ) -> impl Future<Output = Modulos> + Send;
    fn agente_atualizar(
        &self,
        id: &str,
        mudancas: Vec<(String, String)>,
    ) -> impl Future<Output = ()> + Send;

    // ---------- chave de API da empresa ----------
    fn chave_definir(&self, id: &str, chave: Chave) -> impl Future<Output = ()> + Send;
    fn chave_remover(&self, id: &str) -> impl Future<Output = ()> + Send;
    /// Acha a empresa dona do hash (comparação em tempo constante).
    fn empresa_por_chave_hash(&self, hash: &str) -> impl Future<Output = Option<String>> + Send;

    // ---------- ambientes e mesas ----------
    /// `false` se já existe ambiente com esse nome (sem diferenciar maiúsculas).
    fn ambiente_criar(&self, empresa_id: &str, nome: &str) -> impl Future<Output = bool> + Send;
    /// Cria a mesa com o próximo id livre; `None` se o ambiente não existe.
    fn mesa_criar(
        &self,
        empresa_id: &str,
        ambiente: &str,
        capacidade: i64,
        reservavel: bool,
    ) -> impl Future<Output = Option<Mesa>> + Send;
    /// Devolve `(antes, depois)` da mesa ou `None` se não existe.
    fn mesa_editar(
        &self,
        empresa_id: &str,
        mesa_id: &str,
        capacidade: Option<i64>,
        reservavel: Option<bool>,
    ) -> impl Future<Output = Option<(Mesa, Mesa)>> + Send;

    // ---------- reservas ----------
    fn reserva_listar(
        &self,
        empresa_id: &str,
        data: Option<&str>,
    ) -> impl Future<Output = Vec<Reserva>> + Send;
    fn reserva_obter(
        &self,
        empresa_id: &str,
        id: i64,
    ) -> impl Future<Output = Option<Reserva>> + Send;
    fn reserva_confirmadas(
        &self,
        empresa_id: &str,
        ignorar_id: Option<i64>,
    ) -> impl Future<Output = Vec<Reserva>> + Send;
    /// ATÔMICA: reserva a primeira candidata `(mesa, ambiente)` sem sobreposição e guarda a resposta da chave.
    fn reserva_criar(
        &self,
        empresa_id: &str,
        chave: Option<&str>,
        candidatas: Vec<(String, String)>,
        nova: Reserva,
    ) -> impl Future<Output = CriarReserva> + Send;
    fn idempotencia_obter(
        &self,
        empresa_id: &str,
        chave: &str,
    ) -> impl Future<Output = Option<Json>> + Send;
    fn idempotencia_gravar(
        &self,
        empresa_id: &str,
        chave: &str,
        resposta: Json,
    ) -> impl Future<Output = ()> + Send;
    /// ATÔMICA: muda pessoas/data/horário/mesa e dados do cliente, rechecando a sobreposição (ignora a própria reserva).
    fn reserva_editar(
        &self,
        empresa_id: &str,
        id: i64,
        dados: Reserva,
        nome_cliente: Option<String>,
        contato: Option<String>,
    ) -> impl Future<Output = Muda> + Send;
    /// ATÔMICA: marca cancelada.
    fn reserva_cancelar(
        &self,
        empresa_id: &str,
        id: i64,
    ) -> impl Future<Output = Option<Reserva>> + Send;
    /// ATÔMICA: volta a confirmada rechecando a sobreposição.
    fn reserva_reativar(&self, empresa_id: &str, id: i64) -> impl Future<Output = Muda> + Send;

    // ---------- base de conhecimento ----------
    fn conhecimento_listar(&self, empresa_id: &str) -> impl Future<Output = Vec<Json>> + Send;
    fn conhecimento_obter(
        &self,
        empresa_id: &str,
        id: i64,
    ) -> impl Future<Output = Option<Json>> + Send;
    /// ATÔMICA (id sequencial + limite). O item entra sem `id`; o repositório o coloca em primeiro lugar.
    fn conhecimento_criar(
        &self,
        empresa_id: &str,
        item: Json,
        max_itens: usize,
    ) -> impl Future<Output = CriarItem> + Send;
    /// As chaves de `mudancas` entram por cima do item; valor `null` remove a chave.
    fn conhecimento_editar(
        &self,
        empresa_id: &str,
        id: i64,
        mudancas: Vec<(String, Json)>,
    ) -> impl Future<Output = Option<Json>> + Send;
    fn conhecimento_excluir(
        &self,
        empresa_id: &str,
        id: i64,
    ) -> impl Future<Output = Option<Json>> + Send;

    // ---------- histórico (só acrescenta) ----------
    fn historico_acrescentar(&self, ev: Json) -> impl Future<Output = Json> + Send;
    fn historico_listar(
        &self,
        empresa_id: &str,
        entidade: Option<&str>,
        entidade_id: Option<&str>,
        limite: Option<&str>,
    ) -> impl Future<Output = Vec<Json>> + Send;
    fn historico_obter(
        &self,
        empresa_id: &str,
        seq: i64,
    ) -> impl Future<Output = Option<Json>> + Send;
    fn historico_desfeito(&self, empresa_id: &str, seq: i64) -> impl Future<Output = bool> + Send;
    fn historico_excluidas(&self) -> impl Future<Output = Vec<Json>> + Send;

    // ---------- exclusão de empresa ----------
    /// ATÔMICA: apaga a empresa com tudo o que é dela e grava o evento de auditoria junto.
    fn empresa_excluir(&self, id: &str, evento: Json) -> impl Future<Output = Json> + Send;
    /// Bloqueio por senha errada do administrador: `(n erros, bloqueado até ms)`.
    fn tentativas_admin_obter(&self) -> impl Future<Output = (u32, i64)> + Send;
    fn tentativas_admin_gravar(&self, n: u32, ate: i64) -> impl Future<Output = ()> + Send;
}
