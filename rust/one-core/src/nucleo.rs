//! Núcleo da API (espelha `src/nucleo.js`): `tratar(req, ctx) -> Resp`, sem I/O.
//!
//! Roteamento, autenticação, CORS, limite de requisições, validações e histórico. O corpo só é lido depois de
//! autenticar, pela rota que precisa dele, com o limite da rota (`Req::fonte`).

use crate::agentes::{atualizar_varios, empresa, ler_config};
use crate::conhecimento;
use crate::contexto::{contexto, recursos_de};
use crate::historico::{Ator, diff, evento, registrar};
use crate::mapa::mapa;
use crate::reservas::{
    Mudancas, PedidoReserva, cancelar_reserva, disponibilidade, editar_reserva, publica,
    reativar_reserva, reservar_detalhado,
};
use crate::util::{
    Erro, Res, data_ok, decodificar_uri, err, erro, horario_ok, inteiro, js_string, parse_query,
    tam,
};
use one_store::{
    Chave, Empresa, Json, Modulos, Plataforma, Repositorio, iguais_tempo_constante, iso_ms,
};
use serde_json::{Map, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

/// 512 KiB: cinco campos de texto somam até ~49 mil caracteres.
pub const LIMITE_CORPO: usize = 512 * 1024;
/// 6 MiB: documento de até 4 MB em base64.
pub const LIMITE_CORPO_ARQUIVO: usize = 6 * 1024 * 1024;
const JANELA_MS: i64 = 60_000;
const CORS_METODOS: &str = "GET, POST, PATCH, DELETE, OPTIONS";
const CORS_CABECALHOS: &str = "Authorization, Content-Type, Idempotency-Key, X-Operador";
const PERMISSAO_PADRAO: [&str; 6] = [
    "nome",
    "descricao",
    "personalidade",
    "habilidades",
    "produtos",
    "restricoes",
];

/// Futuro da leitura do corpo.
pub type Leitura<'a> = Pin<Box<dyn Future<Output = Result<Option<Vec<u8>>, ()>> + Send + 'a>>;

/// De onde o núcleo lê o corpo, sob demanda. `Err(())` significa que passou do limite (vira 413).
pub trait FonteCorpo: Send + Sync {
    fn ler<'a>(&'a mut self, limite: usize) -> Leitura<'a>;
}

/// Corpo já em mãos (testes e adaptadores que recebem tudo de uma vez).
pub struct CorpoPronto(pub Option<Vec<u8>>);

impl FonteCorpo for CorpoPronto {
    fn ler<'a>(&'a mut self, limite: usize) -> Leitura<'a> {
        let r = match &self.0 {
            Some(b) if b.len() > limite => Err(()),
            outro => Ok(outro.clone()),
        };
        Box::pin(async move { r })
    }
}

/// Requisição que o adaptador entrega ao núcleo. `headers` com chaves em minúsculas; `url` é caminho + query.
pub struct Req {
    pub metodo: String,
    pub url: String,
    pub headers: HashMap<String, String>,
    pub ip: String,
    pub fonte: Box<dyn FonteCorpo>,
}

#[derive(Debug)]
#[allow(clippy::large_enum_variant)]
pub enum CorpoResp {
    Vazio,
    Json(Json),
    Bytes(Vec<u8>),
}

#[derive(Debug)]
pub struct Resp {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub corpo: CorpoResp,
}

/// Chaves globais por papel. A do chat é legada: vê TODAS as empresas.
#[derive(Debug, Clone, Default)]
pub struct Tokens {
    pub chat: Option<String>,
    pub cliente: Option<String>,
    pub integracao: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub tokens: Tokens,
    /// `CHATFLOW_ADMIN_SENHA`: sem ela, excluir empresa fica desativado.
    pub admin_senha: Option<String>,
    /// `CHATFLOW_CORS_ORIGENS`: lista exata. Vazia: nenhum cabeçalho CORS.
    pub cors_origens: Vec<String>,
    /// `CHATFLOW_CONFIAR_PROXY=1`: usar `X-Forwarded-For`.
    pub confiar_proxy: bool,
    /// Fuso de negócio (`CHATFLOW_FUSO`). Carregado e exposto; nenhuma regra o usa ainda.
    pub fuso: String,
    pub limite_invalidas: u32,
    pub limite_validas: u32,
}

impl Config {
    pub fn nova(tokens: Tokens) -> Self {
        Self {
            tokens,
            admin_senha: None,
            cors_origens: Vec::new(),
            confiar_proxy: false,
            fuso: crate::tempo::FUSO_PADRAO.to_string(),
            limite_invalidas: 20,
            limite_validas: 300,
        }
    }
}

/// Janela fixa de 1 minuto por chave, em memória.
#[derive(Default)]
struct Limitador {
    baldes: HashMap<String, (i64, u32)>,
}

impl Limitador {
    /// `Ok(())` ou `Err(retry_after_segundos)`.
    fn contar(&mut self, chave: &str, agora: i64, maximo: u32) -> Result<(), i64> {
        if self.baldes.len() > 10_000 {
            self.baldes.retain(|_, b| agora - b.0 < JANELA_MS);
        }
        let b = self.baldes.entry(chave.to_string()).or_insert((agora, 0));
        if agora - b.0 >= JANELA_MS {
            *b = (agora, 0);
        }
        b.1 += 1;
        if b.1 <= maximo {
            Ok(())
        } else {
            Err(((b.0 + JANELA_MS - agora) as f64 / 1000.0).ceil().max(1.0) as i64)
        }
    }
}

pub struct Contexto<R: Repositorio> {
    pub repo: R,
    pub plat: Arc<dyn Plataforma>,
    pub cfg: Config,
    inv: Mutex<Limitador>,
    val: Mutex<Limitador>,
}

impl<R: Repositorio> Contexto<R> {
    pub fn novo(repo: R, plat: Arc<dyn Plataforma>, cfg: Config) -> Res<Self> {
        let t = &cfg.tokens;
        if [&t.chat, &t.cliente, &t.integracao]
            .iter()
            .all(|x| x.as_deref().is_none_or(str::is_empty))
        {
            return erro(500, "nenhum token configurado");
        }
        let mut cfg = cfg;
        cfg.cors_origens = cfg
            .cors_origens
            .iter()
            .map(|o| o.trim().to_string())
            .filter(|o| !o.is_empty())
            .collect();
        Ok(Self {
            repo,
            plat,
            cfg,
            inv: Mutex::new(Limitador::default()),
            val: Mutex::new(Limitador::default()),
        })
    }
}

fn sha256_hex(s: &str) -> String {
    Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// CORS: só com a origem na lista exata; nunca `*` nem credenciais. O adaptador reaproveita nas respostas estáticas.
pub fn cabecalhos_cors(cfg: &Config, metodo: &str, origem: Option<&str>) -> Vec<(String, String)> {
    let mut h = Vec::new();
    if cfg.cors_origens.is_empty() {
        return h;
    }
    h.push(("Vary".to_string(), "Origin".to_string()));
    if let Some(o) = origem.filter(|o| cfg.cors_origens.iter().any(|x| x == o)) {
        h.push(("Access-Control-Allow-Origin".into(), o.to_string()));
        if metodo == "OPTIONS" {
            h.push(("Access-Control-Allow-Methods".into(), CORS_METODOS.into()));
            h.push((
                "Access-Control-Allow-Headers".into(),
                CORS_CABECALHOS.into(),
            ));
            h.push(("Access-Control-Max-Age".into(), "600".into()));
        }
    }
    h
}

struct Auth {
    papel: String,
    empresa_escopo: Option<String>,
}

async fn autenticar<R: Repositorio>(ctx: &Contexto<R>, req: &Req) -> Option<Auth> {
    let bruto = req.headers.get("authorization")?;
    let token = bruto
        .strip_prefix("Bearer ")
        .filter(|t| !t.is_empty() && !t.contains('\n'))?;
    let t = &ctx.cfg.tokens;
    for (papel, valor) in [
        ("chat", &t.chat),
        ("cliente", &t.cliente),
        ("integracao", &t.integracao),
    ] {
        if let Some(v) = valor.as_deref().filter(|v| !v.is_empty())
            && iguais_tempo_constante(token, v)
        {
            return Some(Auth {
                papel: papel.into(),
                empresa_escopo: None,
            });
        }
    }
    let id = ctx.repo.empresa_por_chave_hash(&sha256_hex(token)).await?;
    Some(Auth {
        papel: "chat".into(),
        empresa_escopo: Some(id),
    })
}

/// IP do cliente; atrás de proxy confiável usa o último valor de `X-Forwarded-For` (o que o proxy acrescentou).
fn ip_de(cfg: &Config, req: &Req) -> String {
    if cfg.confiar_proxy
        && let Some(ultimo) = req
            .headers
            .get("x-forwarded-for")
            .and_then(|x| x.split(',').map(str::trim).rfind(|s| !s.is_empty()))
    {
        return ultimo.to_string();
    }
    if req.ip.is_empty() {
        "desconhecido".into()
    } else {
        req.ip.clone()
    }
}

fn dec(s: &str) -> Res<String> {
    decodificar_uri(s).ok_or_else(|| err(400, "URI malformed"))
}

/// `Number(texto)` do JavaScript para valores de query (`None`/vazio dão 0; inválido dá NaN).
fn numero(s: Option<&str>) -> f64 {
    match s.map(str::trim) {
        None | Some("") => 0.0,
        Some(t) => t.parse::<f64>().unwrap_or(f64::NAN),
    }
}

fn numero_inteiro(s: &str) -> Option<i64> {
    let n = numero(Some(s));
    (n.is_finite() && n.fract() == 0.0 && n.abs() < 9.0e15).then_some(n as i64)
}

async fn ler_corpo(req: &mut Req, limite: usize) -> Res<Json> {
    match req.fonte.ler(limite).await {
        Err(()) => erro(413, "corpo grande demais"),
        Ok(None) => Ok(json!({})),
        Ok(Some(b)) if b.is_empty() => Ok(json!({})),
        Ok(Some(b)) => serde_json::from_slice(&b).map_err(|_| err(400, "JSON inválido")),
    }
}

fn resp(status: u16, corpo: Json, cors: &[(String, String)]) -> Resp {
    Resp {
        status,
        headers: cors.to_vec(),
        corpo: CorpoResp::Json(corpo),
    }
}

fn passa(cors: &[(String, String)], status: u16, corpo: Json) -> Res<Resp> {
    Ok(resp(status, corpo, cors))
}

fn so_staff(staff: bool) -> Res<()> {
    if staff {
        Ok(())
    } else {
        erro(403, "sem permissão")
    }
}

fn modulos_json(m: Modulos) -> Json {
    json!({ "reservas": m.reservas, "conhecimento": m.conhecimento })
}

/// `validarModulos`: `{ reservas?, conhecimento? }` ou mensagem de erro.
fn validar_modulos(b: Option<&Json>) -> Result<(Option<bool>, Option<bool>), String> {
    let Some(b) = b else { return Ok((None, None)) };
    let Some(o) = b.as_object() else {
        return Err("modulos inválido".into());
    };
    let (mut r, mut c) = (None, None);
    for (k, v) in o {
        if k != "reservas" && k != "conhecimento" {
            return Err(format!("módulo desconhecido: {k}"));
        }
        let Some(x) = v.as_bool() else {
            return Err(format!("módulo {k} deve ser verdadeiro ou falso"));
        };
        if k == "reservas" {
            r = Some(x)
        } else {
            c = Some(x)
        }
    }
    Ok((r, c))
}

/// Valida o nome de uma empresa: 1 a 60 caracteres e único entre as empresas.
async fn validar_nome<R: Repositorio>(
    repo: &R,
    bruto: Option<&Json>,
    ignorar_id: Option<&str>,
) -> Res<String> {
    let nome = bruto.and_then(Json::as_str).map(str::trim).unwrap_or("");
    if nome.is_empty() || tam(nome) > 60 {
        return erro(400, "nome da empresa deve ter de 1 a 60 caracteres");
    }
    if repo.empresa_nome_em_uso(nome, ignorar_id).await {
        return erro(409, "já existe outra empresa com esse nome");
    }
    Ok(nome.to_string())
}

async fn modulo_ligado<R: Repositorio>(repo: &R, id: &str, nome: &str) -> bool {
    match repo.empresa_obter(id).await {
        None => true,
        Some(e) => {
            if nome == "reservas" {
                e.modulos.reservas
            } else {
                e.modulos.conhecimento
            }
        }
    }
}

fn ambientes_json(e: &Empresa) -> Json {
    Json::Array(
        e.ambientes
            .iter()
            .map(|a| json!({ "nome": a.nome, "mesas": a.mesas.iter().map(|m| json!({ "id": m.id, "capacidade": m.capacidade, "reservavel": m.reservavel })).collect::<Vec<_>>() }))
            .collect(),
    )
}

fn mesa_json(m: &one_store::Mesa) -> Json {
    json!({ "id": m.id, "capacidade": m.capacidade, "reservavel": m.reservavel })
}

enum Op {
    Cancelar,
    Reativar,
    Editar(Box<Mudancas>),
}

async fn executar<R: Repositorio>(repo: &R, lid: &str, rid: &str, op: &Op) -> Res<Json> {
    match op {
        Op::Cancelar => cancelar_reserva(repo, lid, rid).await,
        Op::Reativar => reativar_reserva(repo, lid, rid).await,
        Op::Editar(m) => editar_reserva(repo, lid, rid, m.as_ref()).await,
    }
}

/// Executa a operação sobre a reserva e registra o que mudou (se mudou).
async fn mudar_reserva<R: Repositorio>(
    repo: &R,
    lid: &str,
    rid: &str,
    op: Op,
    ator: &Ator,
    extra: Option<(&str, i64)>,
) -> Res<Json> {
    let antes = repo.reserva_obter(lid, rid).await.map(|r| publica(&r));
    let r = executar(repo, lid, rid, &op).await?;
    if r["status"] == "indisponivel" {
        return Ok(r);
    }
    let depois = repo.reserva_obter(lid, rid).await.map(|r| publica(&r));
    let (da, dd) = diff(
        antes.as_ref().and_then(Json::as_object),
        depois.as_ref().and_then(Json::as_object),
    );
    if !dd.is_empty() {
        let acao = match (extra, dd.get("status").and_then(Json::as_str)) {
            (Some((a, _)), _) => a,
            (None, Some("cancelada")) => "cancelada",
            (None, Some("confirmada")) => "reativada",
            _ => "editada",
        };
        let mut p: Vec<(&str, Json)> = vec![
            ("empresaId", lid.into()),
            ("entidade", "reserva".into()),
            ("entidadeId", rid.into()),
        ];
        p.extend(ator.pares());
        if let Some((a, seq)) = extra {
            p.push(("acao", a.into()));
            p.push(("refSeq", seq.into()));
        }
        p.push(("acao", acao.into()));
        p.push(("antes", Json::Object(da)));
        p.push(("depois", Json::Object(dd)));
        registrar(repo, evento(p)).await;
    }
    Ok(r)
}

async fn desfazer<R: Repositorio>(repo: &R, lid: &str, seq: i64, ator: &Ator) -> Res<Json> {
    empresa(repo, lid).await?;
    let Some(ev) = repo
        .historico_obter(lid, seq)
        .await
        .filter(|e| e["entidade"] == "reserva")
    else {
        return erro(404, "evento não desfazível");
    };
    if repo.historico_desfeito(lid, seq).await {
        return erro(409, "este evento já foi desfeito");
    }
    let rid = ev["entidadeId"].as_str().unwrap_or("").to_string();
    let Some(atual) = repo.reserva_obter(lid, &rid).await else {
        return erro(404, "reserva inexistente");
    };
    let pub_atual = publica(&atual);
    if let Some(dep) = ev["depois"].as_object() {
        for (k, v) in dep {
            if pub_atual.get(k).map(Json::to_string) != Some(v.to_string()) {
                return erro(
                    409,
                    "há mudanças posteriores nesta reserva; desfaça na ordem inversa",
                );
            }
        }
    }
    let antes = &ev["antes"];
    let op = if ev["acao"] == "criada" || antes["status"] == "cancelada" {
        Op::Cancelar
    } else if antes["status"] == "confirmada" {
        Op::Reativar
    } else {
        Op::Editar(Box::new(Mudancas {
            pessoas: antes.get("pessoas").cloned(),
            data: antes.get("data").cloned(),
            horario: antes.get("horario").cloned(),
            mesa_id: antes.get("mesaId").cloned(),
            ..Mudancas::default()
        }))
    };
    mudar_reserva(repo, lid, &rid, op, ator, Some(("desfeita", seq))).await
}

/// Ponto de entrada: sempre devolve uma resposta (erros viram `{ "erro": mensagem }`).
pub async fn tratar<R: Repositorio>(ctx: &Contexto<R>, req: &mut Req) -> Resp {
    let origem = req.headers.get("origin").cloned();
    let cors = cabecalhos_cors(&ctx.cfg, &req.metodo, origem.as_deref());
    match rotear(ctx, req, &cors).await {
        Ok(r) => r,
        Err(Erro { codigo, msg }) => resp(codigo, json!({ "erro": msg }), &cors),
    }
}

#[allow(clippy::too_many_lines)]
async fn rotear<R: Repositorio>(
    ctx: &Contexto<R>,
    req: &mut Req,
    cors: &[(String, String)],
) -> Res<Resp> {
    let repo = &ctx.repo;
    let metodo = req.metodo.clone();
    let m = metodo.as_str();
    // Preflight: sempre 204 (sem cabeçalhos CORS quando a origem não é permitida ou a variável não existe)
    if m == "OPTIONS" {
        return Ok(Resp {
            status: 204,
            headers: cors.to_vec(),
            corpo: CorpoResp::Vazio,
        });
    }
    let (caminho, query) = {
        let sem_fragmento = req.url.split('#').next().unwrap_or("");
        match sem_fragmento.split_once('?') {
            Some((c, q)) => (c.to_string(), q.to_string()),
            None => (sem_fragmento.to_string(), String::new()),
        }
    };
    // GET /saude: sem autenticação, só { ok: true }
    if m == "GET" && caminho == "/saude" {
        return passa(cors, 200, json!({ "ok": true }));
    }
    let auth = autenticar(ctx, req).await;
    let agora = ctx.plat.agora_ms();
    let limite = match &auth {
        Some(_) => {
            let chave = sha256_hex(req.headers.get("authorization").map_or("", String::as_str));
            ctx.val.lock().unwrap_or_else(|e| e.into_inner()).contar(
                &chave,
                agora,
                ctx.cfg.limite_validas,
            )
        }
        None => ctx.inv.lock().unwrap_or_else(|e| e.into_inner()).contar(
            &ip_de(&ctx.cfg, req),
            agora,
            ctx.cfg.limite_invalidas,
        ),
    };
    if let Err(retry) = limite {
        let mut r = resp(
            429,
            json!({ "erro": "muitas requisições; tente novamente em instantes" }),
            cors,
        );
        r.headers.push(("Retry-After".into(), retry.to_string()));
        return Ok(r);
    }
    let Some(auth) = auth else {
        return erro(401, "não autenticado");
    };
    let papel = auth.papel.as_str();
    let ator = Ator::novo(papel, req.headers.get("x-operador").map(String::as_str));

    let partes: Vec<&str> = caminho.split('/').filter(|s| !s.is_empty()).collect();
    let p = |i: usize| partes.get(i).copied();
    let staff = papel == "cliente" || papel == "integracao";
    let consulta = parse_query(&query);
    let q = |k: &str| {
        consulta
            .iter()
            .find(|(c, _)| c == k)
            .map(|(_, v)| v.as_str())
    };

    // chave de API de uma empresa só alcança as rotas dessa empresa
    if let Some(escopo) = &auth.empresa_escopo {
        let propria =
            p(0) == Some("empresas") && p(1).is_some() && dec(p(1).unwrap_or(""))? == *escopo;
        if !propria {
            return erro(403, "esta chave só acessa a própria empresa");
        }
    }

    // GET /historico/excluidas: resumo das empresas excluídas (o instantâneo completo fica gravado no histórico)
    if p(0) == Some("historico") && p(1) == Some("excluidas") && partes.len() == 2 && m == "GET" {
        so_staff(staff)?;
        let lista: Vec<Json> = repo
            .historico_excluidas()
            .await
            .iter()
            .map(|e| {
                let a = &e["antes"];
                let mesas: usize = a["ambientes"].as_array().map_or(0, |v| v.iter().map(|x| x["mesas"].as_array().map_or(0, Vec::len)).sum());
                json!({
                    "seq": e["seq"], "quando": e["quando"], "papel": e["papel"], "operador": e["operador"], "empresaId": e["empresaId"], "nome": a["nome"],
                    "reservas": a["reservas"].as_array().map_or(0, Vec::len), "ambientes": a["ambientes"].as_array().map_or(0, Vec::len), "mesas": mesas,
                })
            })
            .collect();
        return passa(cors, 200, Json::Array(lista));
    }
    // POST /empresas { nome }  (nasce com agente vazio, sem ambientes e sem chave de API)
    if p(0) == Some("empresas") && partes.len() == 1 && m == "POST" {
        so_staff(staff)?;
        let b = ler_corpo(req, LIMITE_CORPO).await?;
        let nome = validar_nome(repo, b.get("nome"), None).await?;
        let (mr, mc) = validar_modulos(b.get("modulos")).map_err(|e| err(400, e))?;
        let id = repo.empresa_proximo_id().await;
        let mut modulos = Modulos::default();
        modulos.reservas = mr.unwrap_or(modulos.reservas);
        modulos.conhecimento = mc.unwrap_or(modulos.conhecimento);
        let mut ag = Map::new();
        for c in [
            "nome",
            "descricao",
            "personalidade",
            "habilidades",
            "produtos",
            "restricoes",
        ] {
            ag.insert(c.into(), "".into());
        }
        ag.insert(
            "editavelPor".into(),
            Json::Object(
                PERMISSAO_PADRAO
                    .iter()
                    .map(|c| ((*c).to_string(), json!(["cliente", "integracao"])))
                    .collect(),
            ),
        );
        let criada = repo
            .empresa_criar(Empresa::nova(
                &id,
                &nome,
                Json::Object(ag),
                Vec::new(),
                modulos,
            ))
            .await;
        let mut ev = vec![
            ("empresaId", Json::from(id.clone())),
            ("entidade", "empresa".into()),
            ("entidadeId", id.clone().into()),
            ("acao", "criada".into()),
        ];
        ev.extend(ator.pares());
        ev.push(("depois", json!({ "nome": nome })));
        registrar(repo, evento(ev)).await;
        return passa(
            cors,
            201,
            json!({ "id": id, "nome": nome, "modulos": modulos_json(criada.modulos) }),
        );
    }
    // Chave de API da empresa (só equipe de integração). A chave aparece uma única vez, ao gerar; só o hash fica guardado.
    if p(0) == Some("empresas")
        && p(2) == Some("api")
        && (partes.len() == 3 || (partes.len() == 4 && p(3) == Some("chave")))
    {
        if papel != "integracao" {
            return erro(
                403,
                "somente a equipe de integração gerencia a chave de API",
            );
        }
        let l = empresa(repo, &dec(p(1).unwrap_or(""))?).await?;
        if partes.len() == 3 && m == "GET" {
            return passa(
                cors,
                200,
                json!({ "ativa": l.chave.is_some(), "prefixo": l.chave.as_ref().map(|c| c.prefixo.clone()), "criadaEm": l.chave.as_ref().map(|c| c.criada_em.clone()) }),
            );
        }
        if partes.len() == 4 && m == "POST" {
            let chave = format!("k1_{}", crate::codigos::base64url(&ctx.plat.aleatorio(32)));
            let antes = l
                .chave
                .as_ref()
                .map_or_else(|| json!({}), |c| json!({ "prefixo": c.prefixo }));
            let nova = Chave {
                hash: sha256_hex(&chave),
                prefixo: chave.chars().take(11).collect(),
                criada_em: iso_ms(ctx.plat.agora_ms()),
            };
            repo.chave_definir(&l.id, nova.clone()).await;
            let mut ev = vec![
                ("empresaId", Json::from(l.id.clone())),
                ("entidade", "api".into()),
                ("entidadeId", "chave".into()),
                ("acao", "chave_gerada".into()),
            ];
            ev.extend(ator.pares());
            ev.push(("antes", antes));
            ev.push(("depois", json!({ "prefixo": nova.prefixo })));
            registrar(repo, evento(ev)).await;
            return passa(
                cors,
                201,
                json!({ "chave": chave, "prefixo": nova.prefixo, "criadaEm": nova.criada_em }),
            );
        }
        if partes.len() == 4 && m == "DELETE" {
            if let Some(c) = &l.chave {
                let mut ev = vec![
                    ("empresaId", Json::from(l.id.clone())),
                    ("entidade", "api".into()),
                    ("entidadeId", "chave".into()),
                    ("acao", "chave_revogada".into()),
                ];
                ev.extend(ator.pares());
                ev.push(("antes", json!({ "prefixo": c.prefixo })));
                ev.push(("depois", json!({})));
                registrar(repo, evento(ev)).await;
            }
            repo.chave_remover(&l.id).await;
            return passa(cors, 200, json!({ "ativa": false }));
        }
    }

    if p(0) == Some("empresas") && partes.len() == 1 && m == "GET" {
        so_staff(staff)?;
        let lista: Vec<Json> = repo
            .empresa_listar()
            .await
            .iter()
            .map(|l| json!({ "id": l.id, "nome": l.nome, "modulos": modulos_json(l.modulos) }))
            .collect();
        return passa(cors, 200, Json::Array(lista));
    }
    // PATCH /empresas/:id { nome }  (renomear a empresa)
    if p(0) == Some("empresas") && partes.len() == 2 && m == "PATCH" {
        so_staff(staff)?;
        let l = empresa(repo, &dec(p(1).unwrap_or(""))?).await?;
        let b = ler_corpo(req, LIMITE_CORPO).await?;
        let nome = validar_nome(repo, b.get("nome"), Some(&l.id)).await?;
        repo.empresa_renomear(&l.id, &nome).await;
        let (da, dd) = diff(
            json!({ "nome": l.nome }).as_object(),
            json!({ "nome": nome }).as_object(),
        );
        if !dd.is_empty() {
            let mut ev = vec![
                ("empresaId", Json::from(l.id.clone())),
                ("entidade", "empresa".into()),
                ("entidadeId", l.id.clone().into()),
                ("acao", "editada".into()),
            ];
            ev.extend(ator.pares());
            ev.push(("antes", Json::Object(da)));
            ev.push(("depois", Json::Object(dd)));
            registrar(repo, evento(ev)).await;
        }
        return passa(
            cors,
            200,
            json!({ "id": l.id, "nome": nome, "modulos": modulos_json(l.modulos) }),
        );
    }
    // PATCH /empresas/:id/mesas/:mesaId { capacidade?, reservavel? }
    if p(0) == Some("empresas") && p(2) == Some("mesas") && partes.len() == 4 && m == "PATCH" {
        so_staff(staff)?;
        let l = empresa(repo, &dec(p(1).unwrap_or(""))?).await?;
        if !modulo_ligado(repo, &l.id, "reservas").await {
            return erro(404, "recurso \"reservas\" não habilitado para esta empresa");
        }
        let mesa_id = dec(p(3).unwrap_or(""))?;
        if !l
            .ambientes
            .iter()
            .flat_map(|a| a.mesas.iter())
            .any(|x| x.id == mesa_id)
        {
            return erro(404, "mesa inexistente");
        }
        let b = ler_corpo(req, LIMITE_CORPO).await?;
        let mut capacidade = None;
        if let Some(c) = b.get("capacidade") {
            match inteiro(Some(c)).filter(|n| (1..=100).contains(n)) {
                Some(n) => capacidade = Some(n),
                None => return erro(400, "capacidade inválida"),
            }
        }
        let mut reservavel = None;
        if let Some(r) = b.get("reservavel") {
            match r.as_bool() {
                Some(x) => reservavel = Some(x),
                None => return erro(400, "reservavel inválido"),
            }
        }
        let Some((antes, depois)) = repo
            .mesa_editar(&l.id, &mesa_id, capacidade, reservavel)
            .await
        else {
            return erro(404, "mesa inexistente");
        };
        let (da, dd) = diff(
            json!({ "capacidade": antes.capacidade, "reservavel": antes.reservavel }).as_object(),
            json!({ "capacidade": depois.capacidade, "reservavel": depois.reservavel }).as_object(),
        );
        if !dd.is_empty() {
            let mut ev = vec![
                ("empresaId", Json::from(l.id.clone())),
                ("entidade", "mesa".into()),
                ("entidadeId", mesa_id.clone().into()),
                ("acao", "editada".into()),
            ];
            ev.extend(ator.pares());
            ev.push(("antes", Json::Object(da)));
            ev.push(("depois", Json::Object(dd)));
            registrar(repo, evento(ev)).await;
        }
        return passa(cors, 200, mesa_json(&depois));
    }
    // PATCH /empresas/:id/reservas/:rid {pessoas?,data?,horario?,mesaId?} | {status:'cancelada'|'confirmada'}; DELETE cancela
    if p(0) == Some("empresas")
        && p(2) == Some("reservas")
        && partes.len() == 4
        && (m == "PATCH" || m == "DELETE")
    {
        so_staff(staff)?;
        let lid = dec(p(1).unwrap_or(""))?;
        let rid = p(3).filter(|x| !x.is_empty()).map(str::to_string);
        if !modulo_ligado(repo, &lid, "reservas").await {
            return erro(404, "recurso \"reservas\" não habilitado para esta empresa");
        }
        let Some(rid) = rid else {
            return erro(404, "reserva inexistente");
        };
        let op = if m == "DELETE" {
            Op::Cancelar
        } else {
            let b = ler_corpo(req, LIMITE_CORPO).await?;
            match b.get("status").and_then(Json::as_str) {
                Some("cancelada") => Op::Cancelar,
                Some("confirmada") => Op::Reativar,
                _ => Op::Editar(Box::new(Mudancas {
                    pessoas: b.get("pessoas").cloned(),
                    data: b.get("data").cloned(),
                    horario: b.get("horario").cloned(),
                    mesa_id: b.get("mesaId").cloned(),
                    nome_cliente: b.get("nomeCliente").cloned(),
                    contato: b.get("contato").cloned(),
                })),
            }
        };
        let r = mudar_reserva(repo, &lid, &rid, op, &ator, None).await?;
        let status = if m == "DELETE" || r["status"] != "indisponivel" {
            200
        } else {
            409
        };
        return passa(cors, status, r);
    }
    // POST /empresas/:id/historico/:seq/desfazer
    if p(0) == Some("empresas")
        && p(2) == Some("historico")
        && partes.len() == 5
        && p(4) == Some("desfazer")
        && m == "POST"
    {
        so_staff(staff)?;
        let Some(seq) = numero_inteiro(p(3).unwrap_or("")) else {
            return erro(404, "evento inexistente");
        };
        let r = desfazer(repo, &dec(p(1).unwrap_or(""))?, seq, &ator).await?;
        return passa(
            cors,
            if r["status"] == "indisponivel" {
                409
            } else {
                200
            },
            r,
        );
    }
    // Base de conhecimento: GET (chat e equipe) lê; POST/PATCH/DELETE (equipe) editam.
    //  /empresas/:id/conhecimento | /conhecimento/:itemId | /conhecimento/:itemId/arquivo
    if p(0) == Some("empresas") && p(2) == Some("conhecimento") && (3..=5).contains(&partes.len()) {
        let eid = dec(p(1).unwrap_or(""))?;
        let e = empresa(repo, &eid).await?;
        if !e.modulos.conhecimento {
            return erro(
                404,
                "recurso \"conhecimento\" não habilitado para esta empresa",
            );
        }
        if partes.len() == 3 && m == "GET" {
            return passa(
                cors,
                200,
                json!({ "itens": conhecimento::listar_publico(repo, &eid).await? }),
            );
        }
        if partes.len() == 3 && m == "POST" {
            so_staff(staff)?;
            let b = ler_corpo(req, LIMITE_CORPO_ARQUIVO).await?;
            let item = conhecimento::criar(repo, ctx.plat.as_ref(), &eid, &b).await?;
            let mut ev = vec![
                ("empresaId", Json::from(eid.clone())),
                ("entidade", "conhecimento".into()),
                ("entidadeId", item["id"].clone()),
                ("acao", "criada".into()),
            ];
            ev.extend(ator.pares());
            ev.push(("depois", conhecimento::resumo(&item)));
            registrar(repo, evento(ev)).await;
            return passa(cors, 201, conhecimento::publica(&eid, &item));
        }
        if partes.len() == 4 && p(3) == Some("buscar") && m == "GET" {
            return passa(
                cors,
                200,
                conhecimento::buscar(repo, &eid, q("q"), q("limite")).await?,
            );
        }
        let Some(item_id) = numero_inteiro(p(3).unwrap_or("x")) else {
            return erro(404, "item de conhecimento inexistente");
        };
        if partes.len() == 4 && m == "GET" {
            return passa(cors, 200, conhecimento::obter(repo, &eid, item_id).await?);
        }
        if partes.len() == 4 && m == "PATCH" {
            so_staff(staff)?;
            let antes = conhecimento::resumo(&conhecimento::achar_item(repo, &eid, item_id).await?);
            let b = ler_corpo(req, LIMITE_CORPO_ARQUIVO).await?;
            let item = conhecimento::editar(repo, ctx.plat.as_ref(), &eid, item_id, &b).await?;
            let (da, dd) = diff(antes.as_object(), conhecimento::resumo(&item).as_object());
            if !dd.is_empty() {
                let mut ev = vec![
                    ("empresaId", Json::from(eid.clone())),
                    ("entidade", "conhecimento".into()),
                    ("entidadeId", item_id.into()),
                    ("acao", "editada".into()),
                ];
                ev.extend(ator.pares());
                ev.push(("antes", Json::Object(da)));
                ev.push(("depois", Json::Object(dd)));
                registrar(repo, evento(ev)).await;
            }
            return passa(cors, 200, conhecimento::publica(&eid, &item));
        }
        if partes.len() == 4 && m == "DELETE" {
            so_staff(staff)?;
            let item = conhecimento::excluir(repo, &eid, item_id).await?;
            let mut ev = vec![
                ("empresaId", Json::from(eid.clone())),
                ("entidade", "conhecimento".into()),
                ("entidadeId", item_id.into()),
                ("acao", "excluida".into()),
            ];
            ev.extend(ator.pares());
            ev.push(("antes", conhecimento::resumo(&item)));
            ev.push(("depois", json!({})));
            registrar(repo, evento(ev)).await;
            return passa(cors, 200, json!({ "excluido": true, "id": item_id }));
        }
        if partes.len() == 5 && p(4) == Some("arquivo") && m == "GET" {
            let a = conhecimento::arquivo_de(repo, &eid, item_id).await?;
            let mut h = cors.to_vec();
            h.push(("Content-Type".into(), a.mime));
            h.push((
                "Content-Disposition".into(),
                conhecimento::content_disposition(&a.nome),
            ));
            h.push(("X-Content-Type-Options".into(), "nosniff".into()));
            h.push(("Content-Security-Policy".into(), "sandbox".into()));
            return Ok(Resp {
                status: 200,
                headers: h,
                corpo: CorpoResp::Bytes(a.bytes),
            });
        }
    }
    if p(0) != Some("empresas") || partes.len() != 3 {
        return erro(404, "rota inexistente");
    }
    let empresa_id = dec(p(1).unwrap_or(""))?;
    let recurso = p(2).unwrap_or("");
    if ["reservas", "disponibilidade", "mapa", "ambientes", "mesas"].contains(&recurso)
        && !modulo_ligado(repo, &empresa_id, "reservas").await
    {
        return erro(404, "recurso \"reservas\" não habilitado para esta empresa");
    }

    // GET /empresas/:id/recursos: o que esta empresa usa e quais endereços o sistema de conversa pode chamar
    if recurso == "recursos" && m == "GET" {
        return passa(cors, 200, recursos_de(&empresa(repo, &empresa_id).await?));
    }
    // GET /empresas/:id/contexto: tudo o que o agente precisa em uma chamada (config, conhecimento, recursos e prompt pronto)
    if recurso == "contexto" && m == "GET" {
        return passa(cors, 200, contexto(repo, &empresa_id).await?);
    }
    // PATCH /empresas/:id/modulos { reservas?, conhecimento? }: liga ou desliga recursos (os dados são mantidos)
    if recurso == "modulos" && m == "PATCH" {
        so_staff(staff)?;
        let e = empresa(repo, &empresa_id).await?;
        let b = ler_corpo(req, LIMITE_CORPO).await?;
        let (mr, mc) = validar_modulos(Some(&b)).map_err(|x| err(400, x))?;
        if mr.is_none() && mc.is_none() {
            return erro(400, "nenhum módulo informado");
        }
        let novos = repo.empresa_modulos_definir(&e.id, mr, mc).await;
        let a = json!({ "modulo_reservas": e.modulos.reservas, "modulo_conhecimento": e.modulos.conhecimento });
        let d =
            json!({ "modulo_reservas": novos.reservas, "modulo_conhecimento": novos.conhecimento });
        let (da, dd) = diff(a.as_object(), d.as_object());
        if !dd.is_empty() {
            let mut ev = vec![
                ("empresaId", Json::from(e.id.clone())),
                ("entidade", "empresa".into()),
                ("entidadeId", e.id.clone().into()),
                ("acao", "editada".into()),
            ];
            ev.extend(ator.pares());
            ev.push(("antes", Json::Object(da)));
            ev.push(("depois", Json::Object(dd)));
            registrar(repo, evento(ev)).await;
        }
        return passa(cors, 200, modulos_json(novos));
    }

    if recurso == "agente" && m == "GET" {
        return passa(cors, 200, ler_config(repo, &empresa_id).await?);
    }
    // PATCH /empresas/:id/agente { campos: {...} } (tudo ou nada) ou, por compatibilidade, { campo, valor }
    if recurso == "agente" && m == "PATCH" {
        so_staff(staff)?;
        let b = ler_corpo(req, LIMITE_CORPO).await?;
        let mud: Vec<(String, Option<Json>)> = match b.get("campos").and_then(Json::as_object) {
            Some(o) => o
                .iter()
                .map(|(k, v)| (k.clone(), Some(v.clone())))
                .collect(),
            _ => vec![(js_string(b.get("campo")), b.get("valor").cloned())],
        };
        let antes_cfg = ler_config(repo, &empresa_id).await?;
        atualizar_varios(repo, &empresa_id, &mud, papel).await?;
        let cfg = ler_config(repo, &empresa_id).await?;
        for (campo, _) in &mud {
            let a = Map::from_iter([(
                campo.clone(),
                antes_cfg.get(campo).cloned().unwrap_or(Json::Null),
            )]);
            let d =
                Map::from_iter([(campo.clone(), cfg.get(campo).cloned().unwrap_or(Json::Null))]);
            let (da, dd) = diff(Some(&a), Some(&d));
            if !dd.is_empty() {
                let mut ev = vec![
                    ("empresaId", Json::from(empresa_id.clone())),
                    ("entidade", "agente".into()),
                    ("entidadeId", campo.clone().into()),
                    ("acao", "editada".into()),
                ];
                ev.extend(ator.pares());
                ev.push(("antes", Json::Object(da)));
                ev.push(("depois", Json::Object(dd)));
                registrar(repo, evento(ev)).await;
            }
        }
        return passa(cors, 200, cfg);
    }
    if recurso == "reservas" && m == "POST" {
        let b = ler_corpo(req, LIMITE_CORPO).await?;
        let chave = req
            .headers
            .get("idempotency-key")
            .filter(|c| !c.is_empty())
            .cloned()
            .or_else(|| crate::util::texto_ou_nada(b.get("chave")));
        let Some(chave) = chave else {
            return erro(400, "chave de idempotência obrigatória (Idempotency-Key)");
        };
        let data = crate::util::texto_ou_nada(b.get("data")).unwrap_or_default();
        let horario = crate::util::texto_ou_nada(b.get("horario")).unwrap_or_default();
        if !data_ok(&data) || !horario_ok(&horario) {
            return erro(400, "data (AAAA-MM-DD) e horario (HH:MM) obrigatórios");
        }
        let pedido = PedidoReserva {
            empresa_id: empresa_id.clone(),
            data,
            horario,
            pessoas: b.get("pessoas").cloned(),
            ambiente: b.get("ambiente").cloned(),
            mesa_id: b.get("mesaId").cloned(),
            chave: Some(chave),
            nome_cliente: b.get("nomeCliente").cloned(),
            contato: b.get("contato").cloned(),
        };
        let det = reservar_detalhado(repo, &pedido).await?;
        if let Some(c) = &det.criada {
            let mut ev = vec![
                ("empresaId", Json::from(empresa_id.clone())),
                ("entidade", "reserva".into()),
                ("entidadeId", det.resposta["reservaId"].clone()),
                ("acao", "criada".into()),
            ];
            ev.extend(ator.pares());
            ev.push(("depois", publica(c)));
            registrar(repo, evento(ev)).await;
        }
        let status = if det.resposta["status"] == "confirmada" {
            201
        } else {
            200
        };
        return passa(cors, status, det.resposta);
    }
    // Consulta do agente antes de reservar: mesas livres por ambiente
    if recurso == "disponibilidade" && m == "GET" {
        let (data, horario) = (q("data"), q("horario"));
        let n = numero(q("pessoas"));
        let pessoas = (n.is_finite() && n.fract() == 0.0 && n >= 1.0).then_some(n as i64);
        if !data_ok(data.unwrap_or("")) || !horario_ok(horario.unwrap_or("")) || pessoas.is_none() {
            return erro(
                400,
                "data (AAAA-MM-DD), horario (HH:MM) e pessoas obrigatórios",
            );
        }
        let ign = q("ignorar").filter(|x| !x.is_empty());
        return passa(
            cors,
            200,
            disponibilidade(
                repo,
                &empresa_id,
                data.unwrap_or(""),
                horario.unwrap_or(""),
                pessoas,
                ign,
            )
            .await?,
        );
    }
    if recurso == "reservas" && m == "GET" {
        so_staff(staff)?;
        empresa(repo, &empresa_id).await?;
        let lista: Vec<Json> = repo
            .reserva_listar(&empresa_id, q("data"))
            .await
            .iter()
            .map(publica)
            .collect();
        return passa(cors, 200, Json::Array(lista));
    }
    if recurso == "historico" && m == "GET" {
        so_staff(staff)?;
        empresa(repo, &empresa_id).await?;
        return passa(
            cors,
            200,
            Json::Array(
                repo.historico_listar(&empresa_id, q("entidade"), q("id"), q("limite"))
                    .await,
            ),
        );
    }
    // POST /empresas/:id/excluir { senha, confirmarNome }: exige a senha do administrador. Irreversível; grava instantâneo no histórico.
    if recurso == "excluir" && m == "POST" {
        so_staff(staff)?;
        let l = empresa(repo, &empresa_id).await?;
        let Some(admin) = ctx.cfg.admin_senha.as_deref().filter(|s| !s.is_empty()) else {
            return erro(
                503,
                "exclusão de empresa desativada: a senha do administrador não está configurada no servidor",
            );
        };
        let agora = ctx.plat.agora_ms();
        let (mut n, mut ate) = repo.tentativas_admin_obter().await;
        if ate > agora {
            return erro(
                429,
                format!(
                    "muitas tentativas incorretas; tente de novo em {} min",
                    ((ate - agora) as f64 / 60_000.0).ceil() as i64
                ),
            );
        }
        let b = ler_corpo(req, LIMITE_CORPO).await?;
        let senha_ok = b
            .get("senha")
            .and_then(Json::as_str)
            .is_some_and(|s| iguais_tempo_constante(&sha256_hex(s), &sha256_hex(admin)));
        if !senha_ok {
            n += 1;
            if n >= 5 {
                ate = agora + 15 * 60_000;
                n = 0;
            }
            repo.tentativas_admin_gravar(n, ate).await;
            let mut ev = vec![
                ("empresaId", Json::from(l.id.clone())),
                ("entidade", "empresa".into()),
                ("entidadeId", l.id.clone().into()),
                ("acao", "exclusao_negada".into()),
            ];
            ev.extend(ator.pares());
            registrar(repo, evento(ev)).await;
            return erro(403, "senha do administrador incorreta");
        }
        repo.tentativas_admin_gravar(0, ate).await;
        if b.get("confirmarNome").and_then(Json::as_str) != Some(l.nome.as_str()) {
            return erro(400, "digite o nome exato da empresa para confirmar");
        }
        let instantaneo = json!({
            "nome": l.nome,
            "agente": ler_config(repo, &l.id).await?,
            "ambientes": ambientes_json(&l),
            "chaveApiAtiva": l.chave.is_some(),
            "modulos": modulos_json(l.modulos),
            "conhecimento": repo.conhecimento_listar(&l.id).await.iter().map(conhecimento::resumo).collect::<Vec<_>>(),
            "reservas": repo.reserva_listar(&l.id, None).await.iter().map(publica).collect::<Vec<_>>(),
        });
        let mut ev = vec![
            ("empresaId", Json::from(l.id.clone())),
            ("entidade", "empresa".into()),
            ("entidadeId", l.id.clone().into()),
            ("acao", "excluida".into()),
        ];
        ev.extend(ator.pares());
        ev.push(("antes", instantaneo));
        ev.push(("depois", json!({})));
        repo.empresa_excluir(&l.id, evento(ev)).await;
        return passa(
            cors,
            200,
            json!({ "excluida": true, "id": l.id, "nome": l.nome }),
        );
    }
    // POST /empresas/:id/ambientes { nome }
    if recurso == "ambientes" && m == "POST" {
        so_staff(staff)?;
        let l = empresa(repo, &empresa_id).await?;
        let b = ler_corpo(req, LIMITE_CORPO).await?;
        let nome = b
            .get("nome")
            .and_then(Json::as_str)
            .map(str::trim)
            .unwrap_or("");
        if nome.is_empty() || tam(nome) > 40 {
            return erro(400, "nome do ambiente deve ter de 1 a 40 caracteres");
        }
        if !repo.ambiente_criar(&l.id, nome).await {
            return erro(409, "já existe um ambiente com esse nome");
        }
        let mut ev = vec![
            ("empresaId", Json::from(l.id.clone())),
            ("entidade", "ambiente".into()),
            ("entidadeId", nome.into()),
            ("acao", "criada".into()),
        ];
        ev.extend(ator.pares());
        ev.push(("depois", json!({ "nome": nome })));
        registrar(repo, evento(ev)).await;
        return passa(cors, 201, json!({ "nome": nome, "mesas": [] }));
    }
    // POST /empresas/:id/mesas { ambiente, capacidade, reservavel? }
    if recurso == "mesas" && m == "POST" {
        so_staff(staff)?;
        let l = empresa(repo, &empresa_id).await?;
        let b = ler_corpo(req, LIMITE_CORPO).await?;
        let Some(amb) = l
            .ambientes
            .iter()
            .find(|a| b.get("ambiente").and_then(Json::as_str) == Some(a.nome.as_str()))
        else {
            return erro(404, "ambiente inexistente");
        };
        let Some(capacidade) = inteiro(b.get("capacidade")).filter(|n| (1..=100).contains(n))
        else {
            return erro(400, "capacidade inválida");
        };
        let reservavel = !matches!(b.get("reservavel"), Some(Json::Bool(false)));
        let Some(mesa) = repo
            .mesa_criar(&l.id, &amb.nome, capacidade, reservavel)
            .await
        else {
            return erro(404, "ambiente inexistente");
        };
        let mut ev = vec![
            ("empresaId", Json::from(l.id.clone())),
            ("entidade", "mesa".into()),
            ("entidadeId", mesa.id.clone().into()),
            ("acao", "criada".into()),
        ];
        ev.extend(ator.pares());
        ev.push(("depois", json!({ "ambiente": amb.nome, "capacidade": mesa.capacidade, "reservavel": mesa.reservavel })));
        registrar(repo, evento(ev)).await;
        return passa(cors, 201, mesa_json(&mesa));
    }
    if recurso == "estrutura" && m == "GET" {
        so_staff(staff)?;
        let l = empresa(repo, &empresa_id).await?;
        return passa(
            cors,
            200,
            json!({ "id": l.id, "nome": l.nome, "ambientes": ambientes_json(&l), "modulos": modulos_json(l.modulos) }),
        );
    }
    if recurso == "mapa" && m == "GET" {
        so_staff(staff)?;
        let (data, horario) = (q("data").unwrap_or(""), q("horario").unwrap_or(""));
        if data.is_empty() || horario.is_empty() {
            return erro(400, "data e horario obrigatórios");
        }
        return passa(cors, 200, mapa(repo, &empresa_id, data, horario).await?);
    }
    erro(404, "rota inexistente")
}
