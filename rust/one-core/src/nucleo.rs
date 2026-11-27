//! Núcleo da API (espelha `src/nucleo.js`): `tratar(req, ctx) -> Resp`, sem I/O.
//!
//! Roteamento, autenticação, CORS, limite de requisições, validações e histórico. O corpo só é lido depois de
//! autenticar, pela rota que precisa dele, com o limite da rota (`Req::fonte`).

use crate::agentes::{atualizar_varios, empresa, ler_config};
use crate::conhecimento;
use crate::contexto::{contexto, recursos_de};
use crate::historico::{Ator, diff, evento, registrar};
use crate::mapa::mapa;
use crate::permissoes::pode_fazer;
use crate::reservas::{
    Mudancas, PedidoReserva, cancelar_reserva, disponibilidade, editar_reserva, publica,
    reativar_reserva, reservar_detalhado,
};
use crate::usuarios::{
    NovoUsuario, PAPEIS_USUARIO, conferir_senha, criar_credencial, eh_superadmin, lista_de_ids,
    normalizar_email, validar_novo_usuario, validar_senha_nova,
};
use crate::util::{
    Erro, Res, data_ok, decodificar_uri, err, erro, horario_ok, inteiro, js_string, parse_query,
    tam,
};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use one_store::{
    Ambiente, Chave, Empresa, ExcluirReserva, Json, Modulos, Plataforma, RemoverLayout,
    RenomearAmbiente, Repositorio, Sessao, Usuario, iguais_tempo_constante, iso_ms,
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
/// Validade da sessão de usuário.
const SESSAO_MS: i64 = 12 * 60 * 60 * 1000;
/// Quanto tempo a reautenticação vale.
const REAUTENTICACAO_MS: i64 = 5 * 60 * 1000;
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
    /// Tentativas de login por minuto, por e-mail e por IP.
    pub limite_login: u32,
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
            limite_login: 10,
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
    login: Mutex<Limitador>,
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
            login: Mutex::new(Limitador::default()),
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

struct UsuarioSessao {
    id: String,
    nome: String,
    email: String,
    empresas: Vec<String>,
}

struct Auth {
    papel: String,
    empresa_escopo: Option<String>,
    usuario: Option<UsuarioSessao>,
    sessao_hash: Option<String>,
    reautenticado_em: Option<String>,
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
                usuario: None,
                sessao_hash: None,
                reautenticado_em: None,
            });
        }
    }
    // Sessão de usuário (token "s1_…"): papel, nome e empresas vêm do servidor.
    if token.starts_with("s1_") {
        let hash = sha256_hex(token);
        let s = ctx.repo.sessao_por_hash(&hash).await?;
        if s.expira_em.as_str() > iso_ms(ctx.plat.agora_ms()).as_str() {
            let u = ctx.repo.usuario_obter(&s.usuario_id).await?;
            if u.ativo {
                return Some(Auth {
                    papel: u.papel.clone(),
                    empresa_escopo: None,
                    usuario: Some(UsuarioSessao {
                        id: u.id.clone(),
                        nome: u.nome.clone(),
                        email: u.email.clone(),
                        empresas: u.empresas.clone(),
                    }),
                    sessao_hash: Some(hash),
                    reautenticado_em: s.reautenticado_em.clone(),
                });
            }
        }
        return None;
    }
    let id = ctx.repo.empresa_por_chave_hash(&sha256_hex(token)).await?;
    Some(Auth {
        papel: "chat".into(),
        empresa_escopo: Some(id),
        usuario: None,
        sessao_hash: None,
        reautenticado_em: None,
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

/// Código de reserva válido: 8 caracteres do alfabeto sem 0, O, 1, I e L (igual a `codigoReservaValido` do JavaScript).
fn codigo_reserva_valido(c: &str) -> bool {
    c.len() == 8
        && c.bytes()
            .all(|b| one_store::plataforma::ALFABETO_CODIGO.contains(&b))
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

fn usuario_publico(u: &Usuario) -> Json {
    json!({
        "id": u.id, "nome": u.nome, "email": u.email, "papel": u.papel, "ativo": u.ativo,
        "empresas": u.empresas, "criadoEm": u.criado_em, "ultimoLogin": u.ultimo_login,
    })
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
    Json::Array(e.ambientes.iter().map(ambiente_json).collect())
}

fn ambiente_json(ambiente: &Ambiente) -> Json {
    json!({ "nome": ambiente.nome, "mesas": ambiente.mesas.iter().map(mesa_json).collect::<Vec<_>>() })
}

fn mesa_json(m: &one_store::Mesa) -> Json {
    let mut v = json!({ "id": m.id, "capacidade": m.capacidade, "reservavel": m.reservavel });
    if !m.descricao.is_empty() {
        v["descricao"] = m.descricao.clone().into();
    }
    v
}

const ERRO_DESCRICAO_MESA: &str = "descrição da mesa deve ter uma linha com até 150 caracteres";

/// Descrição do local da mesa: uma linha de texto, até 150 caracteres; vazio apaga. `None` quando inválida.
fn descricao_de_mesa(valor: &Json) -> Option<&str> {
    let texto = valor.as_str()?.trim();
    let invalida = texto
        .chars()
        .any(|c| c.is_control() || c == '\u{2028}' || c == '\u{2029}');
    (!invalida && texto.chars().count() <= 150).then_some(texto)
}

async fn registrar_gestao<R: Repositorio>(
    repo: &R,
    empresa_id: &str,
    entidade: &str,
    id: &str,
    acao: &str,
    ator: &Ator,
    (antes, depois): (Json, Json),
) {
    let mut ev = vec![
        ("empresaId", empresa_id.into()),
        ("entidade", entidade.into()),
        ("entidadeId", id.into()),
        ("acao", acao.into()),
    ];
    ev.extend(ator.pares());
    ev.push(("antes", antes));
    ev.push(("depois", depois));
    registrar(repo, evento(ev)).await;
}

fn vinculos_json(reservas: &[(String, String)]) -> Json {
    Json::Array(
        reservas
            .iter()
            .map(|(id, mesa)| json!({ "id": id, "mesaId": mesa }))
            .collect(),
    )
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
    let (da, dd) = diff(
        antes.as_ref().and_then(Json::as_object),
        r.get("reserva").and_then(Json::as_object),
    );
    // campo apagado só aparece em `antes`: também é mudança
    if !dd.is_empty() || !da.is_empty() {
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
    // campo que a mudança apagou: se voltou a ter valor, há mudança posterior
    if let Some(ant) = ev["antes"].as_object() {
        if ant
            .keys()
            .any(|k| ev["depois"].get(k).is_none() && pub_atual.get(k).is_some())
        {
            return erro(
                409,
                "há mudanças posteriores nesta reserva; desfaça na ordem inversa",
            );
        }
    }
    let antes = &ev["antes"];
    // dados do cliente que a edição mudou voltam ao valor anterior ("" apaga o que não existia)
    let voltar = |k: &str| {
        (antes.get(k).is_some() || ev["depois"].get(k).is_some()).then(|| {
            antes
                .get(k)
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or_else(|| Json::from(""))
        })
    };
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
            nome_cliente: voltar("nomeCliente"),
            contato: voltar("contato"),
            observacao: voltar("observacao"),
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
    // POST /login { email, senha }: sem autenticação prévia; a falha é sempre a mesma resposta
    if m == "POST" && caminho == "/login" {
        let b = ler_corpo(req, LIMITE_CORPO).await?;
        let email = normalizar_email(b.get("email").and_then(Json::as_str).unwrap_or(""));
        let agora = ctx.plat.agora_ms();
        let (r1, r2) = {
            let mut l = ctx.login.lock().unwrap_or_else(|e| e.into_inner());
            (
                l.contar(
                    &format!("ip:{}", ip_de(&ctx.cfg, req)),
                    agora,
                    ctx.cfg.limite_login,
                ),
                l.contar(&format!("email:{email}"), agora, ctx.cfg.limite_login),
            )
        };
        if let Err(retry) = r1.and(r2) {
            let mut r = resp(
                429,
                json!({ "erro": "muitas tentativas; tente novamente em instantes" }),
                cors,
            );
            r.headers.push(("Retry-After".into(), retry.to_string()));
            return Ok(r);
        }
        let senha = b.get("senha").and_then(Json::as_str);
        let u = match (email.is_empty(), senha) {
            (false, Some(_)) => repo.usuario_por_email(&email).await,
            _ => None,
        };
        // Sem usuário, gasta o mesmo tempo de derivação para não revelar se o e-mail existe.
        let ok = match (senha, &u) {
            (Some(s), Some(u)) => conferir_senha(s, &u.salt, u.iteracoes, &u.senha_hash),
            (Some(s), None) => conferir_senha(
                s,
                &"00".repeat(16),
                crate::usuarios::ITERACOES_PBKDF2,
                &"0".repeat(64),
            ),
            _ => false,
        };
        let Some(u) = u.filter(|u| ok && u.ativo) else {
            return erro(401, "e-mail ou senha inválidos");
        };
        let token = format!("s1_{}", URL_SAFE_NO_PAD.encode(ctx.plat.aleatorio(32)));
        repo.sessao_criar(
            &sha256_hex(&token),
            Sessao {
                usuario_id: u.id.clone(),
                criada_em: iso_ms(agora),
                expira_em: iso_ms(agora + SESSAO_MS),
                reautenticado_em: None,
            },
        )
        .await;
        repo.usuario_login_marcar(&u.id, &iso_ms(agora)).await;
        return passa(
            cors,
            200,
            json!({ "token": token, "usuario": { "id": u.id, "nome": u.nome, "email": u.email, "papel": u.papel, "empresas": u.empresas } }),
        );
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
    let ator = match &auth.usuario {
        Some(u) => Ator::de_usuario(papel, &u.id, &u.nome),
        None => Ator::novo(papel, req.headers.get("x-operador").map(String::as_str)),
    };

    let partes: Vec<&str> = caminho.split('/').filter(|s| !s.is_empty()).collect();
    let p = |i: usize| partes.get(i).copied();
    let pode = |acao: &str| pode_fazer(papel, acao); // quem pode o quê: permissoes.rs
    let staff = pode("painel.usar");
    // papel legado das regras de edição do agente
    let base = if eh_superadmin(papel) {
        "integracao"
    } else {
        "cliente"
    };
    let do_usuario = auth.usuario.is_some();
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

    // Usuário que não é superadmin só enxerga as empresas liberadas para ele.
    if let Some(u) = &auth.usuario
        && !pode("empresas.todas")
        && p(0) == Some("empresas")
        && p(1).is_some()
        && !u.empresas.contains(&dec(p(1).unwrap_or(""))?)
    {
        return erro(403, "empresa não liberada");
    }
    // Configuração sensível: equipe e admin reautenticam com a própria senha (vale 5 min); superadmin e tokens do env dispensam.
    let reautenticado = !do_usuario
        || pode("configuracao.sem-senha")
        || auth
            .reautenticado_em
            .as_deref()
            .is_some_and(|r| r >= iso_ms(agora - REAUTENTICACAO_MS).as_str());
    let exigir_reautenticacao = || {
        let mut r = resp(
            403,
            json!({ "erro": "digite novamente a sua senha para continuar", "reautenticar": true }),
            cors,
        );
        r.status = 403;
        r
    };

    // ---------- sessão do usuário ----------
    if p(0) == Some("logout") && partes.len() == 1 && m == "POST" {
        if let Some(h) = &auth.sessao_hash {
            repo.sessao_remover(h).await;
        }
        return passa(cors, 200, json!({ "ok": true }));
    }
    if p(0) == Some("eu") && partes.len() == 1 && m == "GET" {
        if auth.empresa_escopo.is_some() {
            return erro(403, "sem permissão");
        }
        return passa(
            cors,
            200,
            match &auth.usuario {
                Some(u) => {
                    json!({ "id": u.id, "nome": u.nome, "email": u.email, "papel": papel, "empresas": u.empresas, "reautenticadoEm": auth.reautenticado_em })
                }
                None => {
                    json!({ "id": null, "nome": null, "email": null, "papel": papel, "empresas": null, "reautenticadoEm": null })
                }
            },
        );
    }
    if p(0) == Some("eu") && p(1) == Some("reautenticar") && partes.len() == 2 && m == "POST" {
        let Some(u) = &auth.usuario else {
            return erro(403, "somente usuários com login reautenticam");
        };
        let lim = ctx.login.lock().unwrap_or_else(|e| e.into_inner()).contar(
            &format!("email:{}", u.email),
            agora,
            ctx.cfg.limite_login,
        );
        if let Err(retry) = lim {
            let mut r = resp(
                429,
                json!({ "erro": "muitas tentativas; tente novamente em instantes" }),
                cors,
            );
            r.headers.push(("Retry-After".into(), retry.to_string()));
            return Ok(r);
        }
        let b = ler_corpo(req, LIMITE_CORPO).await?;
        let completo = repo.usuario_obter(&u.id).await;
        let certa = match (b.get("senha").and_then(Json::as_str), completo) {
            (Some(s), Some(c)) => conferir_senha(s, &c.salt, c.iteracoes, &c.senha_hash),
            _ => false,
        };
        if !certa {
            return erro(403, "senha incorreta");
        }
        if let Some(h) = &auth.sessao_hash {
            repo.sessao_reautenticar(h, &iso_ms(agora)).await;
        }
        return passa(cors, 200, json!({ "ok": true }));
    }
    if p(0) == Some("eu") && p(1) == Some("senha") && partes.len() == 2 && m == "POST" {
        let Some(u) = &auth.usuario else {
            return erro(403, "somente usuários com login trocam a senha");
        };
        let lim = ctx.login.lock().unwrap_or_else(|e| e.into_inner()).contar(
            &format!("email:{}", u.email),
            agora,
            ctx.cfg.limite_login,
        );
        if let Err(retry) = lim {
            let mut r = resp(
                429,
                json!({ "erro": "muitas tentativas; tente novamente em instantes" }),
                cors,
            );
            r.headers.push(("Retry-After".into(), retry.to_string()));
            return Ok(r);
        }
        let b = ler_corpo(req, LIMITE_CORPO).await?;
        if let Some(e) = validar_senha_nova(b.get("nova")) {
            return erro(400, e);
        }
        let completo = repo.usuario_obter(&u.id).await;
        let certa = match (b.get("atual").and_then(Json::as_str), completo) {
            (Some(s), Some(c)) => conferir_senha(s, &c.salt, c.iteracoes, &c.senha_hash),
            _ => false,
        };
        if !certa {
            return erro(403, "senha atual incorreta");
        }
        let nova = b.get("nova").and_then(Json::as_str).unwrap_or("");
        repo.usuario_senha_definir(&u.id, criar_credencial(nova, ctx.plat.aleatorio(16)))
            .await;
        repo.sessoes_remover_do_usuario(&u.id, auth.sessao_hash.as_deref())
            .await;
        return passa(cors, 200, json!({ "ok": true }));
    }
    // ---------- gestão de usuários (só superadmin) ----------
    if p(0) == Some("usuarios") {
        if !pode("usuarios.gerir") {
            return erro(403, "sem permissão");
        }
        let ids_empresas = || async {
            repo.empresa_listar()
                .await
                .into_iter()
                .map(|e| e.id)
                .collect::<Vec<_>>()
        };
        if partes.len() == 1 && m == "GET" {
            let lista: Vec<Json> = repo
                .usuario_listar()
                .await
                .iter()
                .map(usuario_publico)
                .collect();
            return passa(cors, 200, Json::Array(lista));
        }
        if partes.len() == 1 && m == "POST" {
            let corpo = ler_corpo(req, LIMITE_CORPO).await?;
            let NovoUsuario {
                nome,
                email,
                papel: papel_novo,
                empresas,
            } = validar_novo_usuario(&corpo).map_err(|e| err(400, e))?;
            let existentes = ids_empresas().await;
            if let Some(d) = empresas.iter().find(|e| !existentes.contains(e)) {
                return erro(400, format!("empresa inexistente: {d}"));
            }
            let senha = corpo.get("senha").and_then(Json::as_str).unwrap_or("");
            let c = criar_credencial(senha, ctx.plat.aleatorio(16));
            let novo = Usuario {
                id: one_store::plataforma::uuid(ctx.plat.as_ref()),
                nome,
                email,
                papel: papel_novo,
                ativo: true,
                empresas,
                senha_hash: c.senha_hash,
                salt: c.salt,
                iteracoes: c.iteracoes,
                criado_em: iso_ms(agora),
                ultimo_login: None,
            };
            return match repo.usuario_criar(novo).await {
                Ok(u) => passa(cors, 201, usuario_publico(&u)),
                Err(()) => erro(409, "e-mail já cadastrado"),
            };
        }
        if partes.len() >= 2 {
            let uid = dec(p(1).unwrap_or(""))?;
            let Some(alvo) = repo.usuario_obter(&uid).await else {
                return erro(404, "usuário inexistente");
            };
            if partes.len() == 2 && m == "PATCH" {
                let b = ler_corpo(req, LIMITE_CORPO).await?;
                let mut nome: Option<String> = None;
                let mut papel_m: Option<String> = None;
                let mut ativo: Option<bool> = None;
                let mut empresas: Option<Vec<String>> = None;
                if let Some(v) = b.get("nome") {
                    let t = v.as_str().map_or("", str::trim);
                    if t.is_empty() || t.encode_utf16().count() > 80 {
                        return erro(400, "nome de 1 a 80 caracteres");
                    }
                    nome = Some(t.to_string());
                }
                if let Some(v) = b.get("papel") {
                    let t = v.as_str().unwrap_or("");
                    if !PAPEIS_USUARIO.contains(&t) {
                        return erro(400, "papel deve ser equipe, admin ou superadmin");
                    }
                    papel_m = Some(t.to_string());
                }
                if let Some(v) = b.get("ativo") {
                    let Some(a) = v.as_bool() else {
                        return erro(400, "ativo deve ser verdadeiro ou falso");
                    };
                    ativo = Some(a);
                }
                if b.get("empresas").is_some() {
                    let Some(l) = lista_de_ids(b.get("empresas")) else {
                        return erro(400, "empresas deve ser uma lista de ids");
                    };
                    let existentes = ids_empresas().await;
                    if let Some(d) = l.iter().find(|e| !existentes.contains(e)) {
                        return erro(400, format!("empresa inexistente: {d}"));
                    }
                    empresas = Some(l);
                }
                // Nunca ficar sem superadmin ativo.
                let deixa_de_ser = alvo.papel == "superadmin"
                    && alvo.ativo
                    && (papel_m.as_deref().is_some_and(|x| x != "superadmin")
                        || ativo == Some(false));
                if deixa_de_ser
                    && repo
                        .usuario_superadmins_ativos()
                        .await
                        .iter()
                        .all(|i| *i == alvo.id)
                {
                    return erro(409, "precisa existir pelo menos um superadmin ativo");
                }
                let mudou_papel = papel_m.as_deref().is_some_and(|x| x != alvo.papel);
                let r = repo
                    .usuario_atualizar(&uid, nome, papel_m, ativo, empresas)
                    .await;
                if ativo == Some(false) || mudou_papel {
                    repo.sessoes_remover_do_usuario(&uid, None).await;
                }
                return match r {
                    Some(u) => passa(cors, 200, usuario_publico(&u)),
                    None => erro(404, "usuário inexistente"),
                };
            }
            if partes.len() == 3 && p(2) == Some("senha") && m == "POST" {
                let b = ler_corpo(req, LIMITE_CORPO).await?;
                if let Some(e) = validar_senha_nova(b.get("senha")) {
                    return erro(400, e);
                }
                let senha = b.get("senha").and_then(Json::as_str).unwrap_or("");
                repo.usuario_senha_definir(&uid, criar_credencial(senha, ctx.plat.aleatorio(16)))
                    .await;
                repo.sessoes_remover_do_usuario(&uid, None).await;
                return passa(cors, 200, json!({ "ok": true }));
            }
        }
    }

    // GET /historico/excluidas: resumo das empresas excluídas (o instantâneo completo fica gravado no histórico)
    if p(0) == Some("historico") && p(1) == Some("excluidas") && partes.len() == 2 && m == "GET" {
        so_staff(pode("historico.excluidas"))?;
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
        so_staff(pode("empresa.criar"))?;
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
        if !pode("api.gerir") {
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
            .filter(|l| {
                auth.usuario
                    .as_ref()
                    .is_none_or(|u| pode("empresas.todas") || u.empresas.contains(&l.id))
            })
            .map(|l| json!({ "id": l.id, "nome": l.nome, "modulos": modulos_json(l.modulos) }))
            .collect();
        return passa(cors, 200, Json::Array(lista));
    }
    // PATCH /empresas/:id { nome }  (renomear a empresa)
    if p(0) == Some("empresas") && partes.len() == 2 && m == "PATCH" {
        so_staff(staff)?;
        if !reautenticado {
            return Ok(exigir_reautenticacao());
        }
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
    // PATCH/DELETE ambientes e DELETE mesas; o nome é o identificador do ambiente.
    if p(0) == Some("empresas")
        && partes.len() == 4
        && matches!(
            (p(2), m),
            (Some("ambientes"), "PATCH" | "DELETE") | (Some("mesas"), "DELETE")
        )
    {
        so_staff(staff)?;
        let lid = dec(p(1).unwrap_or(""))?;
        let id = dec(p(3).unwrap_or(""))?;
        if !modulo_ligado(repo, &lid, "reservas").await {
            return erro(404, "recurso \"reservas\" não habilitado para esta empresa");
        }
        if m == "PATCH" {
            let corpo = ler_corpo(req, LIMITE_CORPO).await?;
            let nome = corpo
                .get("nome")
                .and_then(Json::as_str)
                .unwrap_or("")
                .trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}');
            if nome.is_empty() || nome.chars().count() > 60 {
                return erro(400, "nome do ambiente deve ter de 1 a 60 caracteres");
            }
            empresa(repo, &lid).await?;
            return match repo.ambiente_renomear(&lid, &id, nome).await {
                RenomearAmbiente::Inexistente => erro(404, "ambiente inexistente"),
                RenomearAmbiente::NomeDuplicado => erro(409, "nome já usado"),
                RenomearAmbiente::Ok(ambiente) => {
                    if id != ambiente.nome {
                        registrar_gestao(
                            repo,
                            &lid,
                            "ambiente",
                            &id,
                            "ambiente_renomeado",
                            &ator,
                            (json!({ "nome": id }), json!({ "nome": ambiente.nome })),
                        )
                        .await;
                    }
                    passa(cors, 200, ambiente_json(&ambiente))
                }
            };
        }
        empresa(repo, &lid).await?;
        let agora = crate::tempo::agora_minutos(ctx.plat.agora_ms(), &ctx.cfg.fuso)?;
        let conflito = |reservas| {
            passa(
                cors,
                409,
                json!({ "erro": "mesa com reserva ativa", "reservas": reservas }),
            )
        };
        if p(2) == Some("ambientes") {
            return match repo.ambiente_remover(&lid, &id, agora).await {
                RemoverLayout::Inexistente => erro(404, "ambiente inexistente"),
                RemoverLayout::ReservasAtivas(reservas) => conflito(reservas),
                RemoverLayout::Ok(ambiente, reservas) => {
                    let mut antes = ambiente_json(&ambiente);
                    antes["reservas"] = vinculos_json(&reservas);
                    registrar_gestao(
                        repo,
                        &lid,
                        "ambiente",
                        &id,
                        "ambiente_removido",
                        &ator,
                        (antes, Json::Null),
                    )
                    .await;
                    let mesas: Vec<_> = ambiente.mesas.into_iter().map(|m| m.id).collect();
                    passa(cors, 200, json!({ "ok": true, "mesasRemovidas": mesas }))
                }
            };
        }
        return match repo.mesa_remover(&lid, &id, agora).await {
            RemoverLayout::Inexistente => erro(404, "mesa inexistente"),
            RemoverLayout::ReservasAtivas(reservas) => conflito(reservas),
            RemoverLayout::Ok((mesa, ambiente), reservas) => {
                let mut antes = mesa_json(&mesa);
                antes["ambiente"] = ambiente.into();
                antes["reservas"] = vinculos_json(&reservas);
                registrar_gestao(
                    repo,
                    &lid,
                    "mesa",
                    &id,
                    "mesa_removida",
                    &ator,
                    (antes, Json::Null),
                )
                .await;
                let mut desligadas: Vec<_> =
                    reservas.into_iter().map(|(codigo, _)| codigo).collect();
                desligadas.sort_unstable();
                passa(
                    cors,
                    200,
                    json!({ "ok": true, "reservasDesligadas": desligadas }),
                )
            }
        };
    }
    // PATCH /empresas/:id/mesas/:mesaId { capacidade?, reservavel?, descricao? }
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
        let mut descricao = None;
        if let Some(d) = b.get("descricao") {
            match descricao_de_mesa(d) {
                Some(x) => descricao = Some(x),
                None => return erro(400, ERRO_DESCRICAO_MESA),
            }
        }
        let Some((antes, depois)) = repo
            .mesa_editar(&l.id, &mesa_id, capacidade, reservavel, descricao)
            .await
        else {
            return erro(404, "mesa inexistente");
        };
        let (da, dd) = diff(
            json!({ "capacidade": antes.capacidade, "reservavel": antes.reservavel, "descricao": antes.descricao }).as_object(),
            json!({ "capacidade": depois.capacidade, "reservavel": depois.reservavel, "descricao": depois.descricao }).as_object(),
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
        let rid = dec(p(3).unwrap_or(""))?;
        if !modulo_ligado(repo, &lid, "reservas").await {
            return erro(404, "recurso \"reservas\" não habilitado para esta empresa");
        }
        if !codigo_reserva_valido(&rid) {
            return erro(404, "reserva inexistente");
        }
        if m == "DELETE" && q("definitivo") == Some("1") {
            empresa(repo, &lid).await?;
            return match repo.reserva_excluir(&lid, &rid).await {
                ExcluirReserva::Inexistente => erro(404, "reserva inexistente"),
                ExcluirReserva::Ativa => erro(409, "reserva ativa; cancele antes de excluir"),
                ExcluirReserva::Ok(reserva) => {
                    let mut antes = publica(&reserva);
                    antes["inicio"] = reserva.inicio.into();
                    antes["fim"] = reserva.fim.into();
                    registrar_gestao(
                        repo,
                        &lid,
                        "reserva",
                        &rid,
                        "reserva_excluida",
                        &ator,
                        (antes, Json::Null),
                    )
                    .await;
                    passa(cors, 200, json!({ "ok": true }))
                }
            };
        }
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
                    observacao: b.get("observacao").cloned(),
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
        so_staff(pode("historico.desfazer"))?;
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
        let agora = ctx.plat.agora_ms();
        return passa(
            cors,
            200,
            contexto(repo, &empresa_id, agora, &ctx.cfg.fuso).await?,
        );
    }
    // PATCH /empresas/:id/modulos { reservas?, conhecimento? }: liga ou desliga recursos (os dados são mantidos)
    if recurso == "modulos" && m == "PATCH" {
        so_staff(staff)?;
        if !reautenticado {
            return Ok(exigir_reautenticacao());
        }
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
        atualizar_varios(repo, &empresa_id, &mud, base).await?;
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
            observacao: b.get("observacao").cloned(),
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
        let ign = q("ignorar");
        if ign.is_some_and(|x| !codigo_reserva_valido(x)) {
            return erro(400, "código de reserva inválido em ignorar");
        }
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
        so_staff(pode("historico.ver"))?;
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
        if !pode("empresa.excluir") {
            return erro(403, "somente admin ou superadmin exclui empresa");
        }
        let l = empresa(repo, &empresa_id).await?;
        // Usuário logado confirma com a PRÓPRIA senha; o token do env usa CHATFLOW_ADMIN_SENHA.
        let admin = ctx.cfg.admin_senha.as_deref().filter(|s| !s.is_empty());
        if !do_usuario && admin.is_none() {
            return erro(
                503,
                "exclusão de empresa desativada: a senha do administrador não está configurada no servidor",
            );
        }
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
        let senha_ok = match (&auth.usuario, b.get("senha").and_then(Json::as_str)) {
            (Some(u), Some(s)) => match repo.usuario_obter(&u.id).await {
                Some(c) => conferir_senha(s, &c.salt, c.iteracoes, &c.senha_hash),
                None => false,
            },
            (None, Some(s)) => {
                admin.is_some_and(|a| iguais_tempo_constante(&sha256_hex(s), &sha256_hex(a)))
            }
            _ => false,
        };
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
            return erro(
                403,
                if do_usuario {
                    "senha incorreta"
                } else {
                    "senha do administrador incorreta"
                },
            );
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
    // POST /empresas/:id/mesas { ambiente, capacidade, reservavel?, descricao? }
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
        let descricao = match b.get("descricao") {
            None => "",
            Some(d) => match descricao_de_mesa(d) {
                Some(x) => x,
                None => return erro(400, ERRO_DESCRICAO_MESA),
            },
        };
        let Some(mesa) = repo
            .mesa_criar(&l.id, &amb.nome, capacidade, reservavel, descricao)
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
        let mut criada = json!({ "ambiente": amb.nome, "capacidade": mesa.capacidade, "reservavel": mesa.reservavel });
        if !mesa.descricao.is_empty() {
            criada["descricao"] = mesa.descricao.clone().into();
        }
        ev.push(("depois", criada));
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
