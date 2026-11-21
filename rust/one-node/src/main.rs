//! `one-node`: adaptador nativo do ONE (axum + tokio). É o único crate com I/O: rede, arquivos de `web/`,
//! variáveis de ambiente e o sumidouro de auditoria em arquivo. Mesmas variáveis `CHATFLOW_*` do servidor em JavaScript.

use axum::Router;
use axum::body::Body;
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderName, HeaderValue, Request, StatusCode};
use axum::response::Response;
use http_body_util::BodyExt;
use one_core::{
    Config, Contexto, CorpoResp, FonteCorpo, LIMITE_CORPO_ARQUIVO, Req, Tokens, cabecalhos_cors,
    tratar,
};
use one_store::{Empresa, Json, Memoria, Plataforma};
use serde_json::json;
use std::collections::HashMap;
use std::io::Write;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Acima disto, o corpo que ninguém pediu (ou que passou do limite) deixa de ser descartado e a conexão é derrubada.
const DESCARTE_MAX: usize = 32 * 1024 * 1024;

const ESTATICOS: [(&str, &str); 9] = [
    ("index.html", "text/html; charset=utf-8"),
    ("app.js", "text/javascript; charset=utf-8"),
    ("config.js", "text/javascript; charset=utf-8"),
    ("bundle.js", "text/javascript; charset=utf-8"),
    ("bundle.css", "text/css; charset=utf-8"),
    ("tokens.css", "text/css; charset=utf-8"),
    ("logo-chatflow.png", "image/png"),
    ("vendor/react.production.min.js", "text/javascript; charset=utf-8"),
    ("vendor/react-dom.production.min.js", "text/javascript; charset=utf-8"),
];

/// Relógio e aleatoriedade do sistema.
struct Nativa;

impl Plataforma for Nativa {
    fn agora_ms(&self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as i64)
    }
    fn aleatorio(&self, n: usize) -> Vec<u8> {
        let mut b = vec![0u8; n];
        if let Err(e) = getrandom::fill(&mut b) {
            // sem aleatoriedade segura não se gera chave nem identificador: encerra em vez de seguir inseguro
            eprintln!("falha ao obter bytes aleatórios do sistema: {e}");
            std::process::exit(1);
        }
        b
    }
}

type Estado = Arc<(Contexto<Memoria>, Option<PathBuf>)>;

/// Corpo lido sob demanda do `hyper`. O que sobrar (limite estourado ou ninguém pediu) é descartado depois da resposta.
struct FonteAxum {
    corpo: Arc<Mutex<Option<Body>>>,
}

impl FonteCorpo for FonteAxum {
    fn ler<'a>(&'a mut self, limite: usize) -> one_core::nucleo::Leitura<'a> {
        Box::pin(async move {
            let Some(mut body) = self.corpo.lock().unwrap_or_else(|e| e.into_inner()).take() else {
                return Ok(None);
            };
            let mut buf: Vec<u8> = Vec::new();
            loop {
                match body.frame().await {
                    None => return Ok(if buf.is_empty() { None } else { Some(buf) }),
                    Some(Err(_)) => return Err(()),
                    Some(Ok(frame)) => {
                        if let Ok(dados) = frame.into_data() {
                            if buf.len() + dados.len() > limite {
                                // devolve o resto para ser descartado
                                *self.corpo.lock().unwrap_or_else(|e| e.into_inner()) = Some(body);
                                return Err(());
                            }
                            buf.extend_from_slice(&dados);
                        }
                    }
                }
            }
        })
    }
}

/// Descarta (sem guardar) o corpo restante, até `DESCARTE_MAX`; depois disso, solta a conexão.
async fn drenar(mut body: Body) {
    let mut total = 0usize;
    while let Some(Ok(frame)) = body.frame().await {
        if let Ok(d) = frame.into_data() {
            total += d.len();
            if total > DESCARTE_MAX {
                return;
            }
        }
    }
}

fn montar(status: u16, headers: &[(String, String)], corpo: CorpoResp) -> Response {
    let mut r = Response::new(Body::empty());
    *r.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let bytes = match corpo {
        CorpoResp::Vazio => Vec::new(),
        CorpoResp::Bytes(b) => b,
        CorpoResp::Json(j) => {
            r.headers_mut().insert(
                "content-type",
                HeaderValue::from_static("application/json; charset=utf-8"),
            );
            serde_json::to_vec(&j).unwrap_or_default()
        }
    };
    for (k, v) in headers {
        if let (Ok(n), Ok(val)) = (
            HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_str(v),
        ) {
            r.headers_mut().insert(n, val);
        }
    }
    if status != 204 && status != 301 {
        r.headers_mut()
            .insert("content-length", HeaderValue::from(bytes.len()));
    }
    *r.body_mut() = Body::from(bytes);
    r
}

fn cabecalhos_req(req: &Request<Body>) -> HashMap<String, String> {
    let mut h: HashMap<String, String> = HashMap::new();
    for (k, v) in req.headers() {
        if let Ok(v) = v.to_str() {
            h.entry(k.as_str().to_string())
                .and_modify(|x| {
                    x.push_str(", ");
                    x.push_str(v)
                })
                .or_insert_with(|| v.to_string());
        }
    }
    h
}

/// Painel estático (sem dados sensíveis), lista fechada de arquivos. Só aqui existe acesso a `web/`.
async fn estatico(
    web: &Option<PathBuf>,
    caminho: &str,
    query: Option<&str>,
    cors: &[(String, String)],
) -> Response {
    if caminho == "/app" {
        let mut h = cors.to_vec();
        h.push((
            "Location".into(),
            format!("/app/{}", query.map_or(String::new(), |q| format!("?{q}"))),
        ));
        return montar(301, &h, CorpoResp::Vazio);
    }
    let nome = if caminho == "/app/" {
        "index.html"
    } else {
        &caminho[5..]
    };
    let Some((_, tipo)) = ESTATICOS.iter().find(|(n, _)| *n == nome) else {
        return montar(
            404,
            cors,
            CorpoResp::Json(json!({ "erro": "arquivo inexistente" })),
        );
    };
    let lido = match web {
        Some(dir) => tokio::fs::read(dir.join(nome)).await.ok(),
        None => None,
    };
    match lido {
        Some(bytes) => {
            let mut h = cors.to_vec();
            h.push(("Content-Type".into(), (*tipo).to_string()));
            montar(200, &h, CorpoResp::Bytes(bytes))
        }
        None => montar(
            404,
            cors,
            CorpoResp::Json(json!({ "erro": "arquivo inexistente" })),
        ),
    }
}

async fn atender(
    State(estado): State<Estado>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request<Body>,
) -> Response {
    let (ctx, web) = (&estado.0, &estado.1);
    let metodo = req.method().as_str().to_string();
    let url = req
        .uri()
        .path_and_query()
        .map_or_else(|| req.uri().path().to_string(), |p| p.as_str().to_string());
    let headers = cabecalhos_req(&req);
    let (caminho, query) = match url.split_once('?') {
        Some((c, q)) => (c.to_string(), Some(q.to_string())),
        None => (url.clone(), None),
    };
    if metodo == "GET" && (caminho == "/app" || caminho.starts_with("/app/")) {
        let cors = cabecalhos_cors(&ctx.cfg, &metodo, headers.get("origin").map(String::as_str));
        return estatico(web, &caminho, query.as_deref(), &cors).await;
    }
    let compartilhado = Arc::new(Mutex::new(Some(req.into_body())));
    let mut r = Req {
        metodo,
        url,
        headers,
        ip: addr.ip().to_string(),
        fonte: Box::new(FonteAxum {
            corpo: Arc::clone(&compartilhado),
        }),
    };
    let resp = tratar(ctx, &mut r).await;
    // corpo que o núcleo não pediu (401, 404, 413...): descarta sem guardar, para o cliente conseguir ler a resposta
    let resto = compartilhado
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    if let Some(b) = resto {
        tokio::spawn(drenar(b));
    }
    montar(resp.status, &resp.headers, resp.corpo)
}

fn variavel(nome: &str) -> Option<String> {
    std::env::var(nome).ok().filter(|v| !v.is_empty())
}

/// Pasta `web/`: `CHATFLOW_WEB_DIR`, ou `web/` a partir do diretório atual e dos pais do executável.
fn achar_web() -> Option<PathBuf> {
    if let Some(d) = variavel("CHATFLOW_WEB_DIR") {
        return Some(PathBuf::from(d));
    }
    let mut candidatos: Vec<PathBuf> = vec![PathBuf::from("web")];
    if let Ok(exe) = std::env::current_exe() {
        candidatos.extend(exe.ancestors().skip(1).map(|p| p.join("web")));
    }
    candidatos
        .into_iter()
        .find(|p| p.join("index.html").is_file())
}

/// As 3 empresas de demonstração (só com `CHATFLOW_DEMO=1`).
fn demo() -> Vec<Json> {
    let campos = [
        "nome",
        "descricao",
        "personalidade",
        "habilidades",
        "produtos",
        "restricoes",
    ];
    (1..=3)
        .map(|n| {
            let mut agente = serde_json::Map::new();
            for c in campos {
                agente.insert(c.into(), if c == "nome" { format!("Agente da Empresa {n}").into() } else { "".into() });
            }
            agente.insert("editavelPor".into(), Json::Object(campos.iter().map(|c| ((*c).to_string(), json!(["cliente", "integracao"]))).collect()));
            json!({
                "id": format!("empresa_{n}"),
                "nome": format!("Empresa {n}"),
                "ambientes": [
                    { "nome": "salao", "mesas": [{ "id": "S1", "capacidade": 4, "reservavel": true }, { "id": "S2", "capacidade": 6, "reservavel": true }] },
                    { "nome": "externa", "mesas": [{ "id": "E1", "capacidade": 4, "reservavel": true }] },
                ],
                "agente": Json::Object(agente),
            })
        })
        .collect()
}

#[tokio::main]
async fn main() {
    let plat: Arc<dyn Plataforma> = Arc::new(Nativa);
    // CHATFLOW_HISTORICO_ARQUIVO: grava cada evento de histórico (JSON por linha) neste arquivo, além da memória.
    let sink: Option<one_store::memoria::Sink> =
        variavel("CHATFLOW_HISTORICO_ARQUIVO").map(|arq| {
            let f: one_store::memoria::Sink = Arc::new(move |e: &Json| {
                let gravado = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&arq)
                    .and_then(|mut f| writeln!(f, "{e}"));
                if let Err(err) = gravado {
                    eprintln!("falha ao gravar histórico em arquivo: {err}");
                }
            });
            f
        });
    // CHATFLOW_IDEMPOTENCIA_HORAS (padrão 24) e CHATFLOW_IDEMPOTENCIA_MAX (padrão 10000 por empresa): validade e teto das
    // respostas de idempotência guardadas em memória.
    let ttl_ms = variavel("CHATFLOW_IDEMPOTENCIA_HORAS")
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|h| *h > 0.0)
        .map_or(0, |h| (h * 3_600_000.0) as i64);
    let max_idem = variavel("CHATFLOW_IDEMPOTENCIA_MAX")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    let repo = Memoria::nova(Arc::clone(&plat), sink).com_idempotencia(ttl_ms, max_idem);

    let mut empresas: Vec<Json> = Vec::new();
    if variavel("CHATFLOW_DEMO").as_deref() == Some("1") {
        empresas.extend(demo());
    }
    // CHATFLOW_SEMENTE_ARQUIVO (só para testes de contrato): JSON com a lista de empresas iniciais.
    if let Some(arq) = variavel("CHATFLOW_SEMENTE_ARQUIVO") {
        match std::fs::read_to_string(&arq)
            .map_err(|e| e.to_string())
            .and_then(|t| serde_json::from_str::<Vec<Json>>(&t).map_err(|e| e.to_string()))
        {
            Ok(v) => empresas.extend(v),
            Err(e) => {
                eprintln!("não consegui ler CHATFLOW_SEMENTE_ARQUIVO: {e}");
                std::process::exit(1);
            }
        }
    }
    for e in &empresas {
        match Empresa::de_json(e) {
            Ok(emp) => {
                use one_store::Repositorio;
                repo.empresa_criar(emp).await;
            }
            Err(msg) => {
                eprintln!("empresa inicial inválida: {msg}");
                std::process::exit(1);
            }
        }
    }

    let mut cfg = Config::nova(Tokens {
        chat: variavel("CHATFLOW_TOKEN_CHAT"),
        cliente: variavel("CHATFLOW_TOKEN_CLIENTE"),
        integracao: variavel("CHATFLOW_TOKEN_INTEGRACAO"),
    });
    cfg.admin_senha = variavel("CHATFLOW_ADMIN_SENHA");
    cfg.cors_origens = std::env::var("CHATFLOW_CORS_ORIGENS")
        .unwrap_or_default()
        .split(',')
        .map(str::to_string)
        .collect();
    cfg.confiar_proxy = variavel("CHATFLOW_CONFIAR_PROXY").as_deref() == Some("1");
    // CHATFLOW_LIMITE_CHAVE / CHATFLOW_LIMITE_INVALIDAS: requisições por minuto por chave válida (padrão 300) e por IP com chave inválida (padrão 20).
    cfg.limite_validas = variavel("CHATFLOW_LIMITE_CHAVE")
        .and_then(|v| v.parse().ok())
        .filter(|n| *n > 0)
        .unwrap_or(cfg.limite_validas);
    cfg.limite_invalidas = variavel("CHATFLOW_LIMITE_INVALIDAS")
        .and_then(|v| v.parse().ok())
        .filter(|n| *n > 0)
        .unwrap_or(cfg.limite_invalidas);
    cfg.fuso = one_core::tempo::fuso_de(std::env::var("CHATFLOW_FUSO").ok().as_deref());
    let ctx = match Contexto::novo(repo, plat, cfg) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{}", e.msg);
            std::process::exit(1);
        }
    };

    let porta: u16 = variavel("PORT")
        .and_then(|p| p.parse().ok())
        .unwrap_or(3000);
    let estado: Estado = Arc::new((ctx, achar_web()));
    let app = Router::new().fallback(atender).with_state(estado);
    let listener = match tokio::net::TcpListener::bind(("0.0.0.0", porta)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("não consegui abrir a porta {porta}: {e}");
            std::process::exit(1);
        }
    };
    println!("ChatFlow Painel API na porta {porta}");
    let _ = LIMITE_CORPO_ARQUIVO; // o limite de cada rota é aplicado no núcleo
    if let Err(e) = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    {
        eprintln!("servidor encerrado: {e}");
        std::process::exit(1);
    }
}
