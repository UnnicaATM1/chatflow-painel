//! Base de conhecimento de uma empresa (espelha `src/conhecimento.js`): textos, tabelas e documentos, e a busca.

use crate::agentes::empresa;
use crate::util::{Res, codificar_uri, err, erro, js_string, len16, slice16, tam};
use base64::Engine;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use one_store::{CriarItem, Json, Plataforma, Repositorio, iso_ms};
use serde_json::{Map, json};
use unicode_normalization::UnicodeNormalization;

pub const LIM_TITULO: usize = 120;
pub const LIM_TEXTO: usize = 50_000;
pub const LIM_TEXTO_DOC: usize = 200_000;
pub const LIM_COLUNAS: usize = 20;
pub const LIM_NOME_COLUNA: usize = 60;
pub const LIM_LINHAS: usize = 1000;
pub const LIM_CELULA: usize = 500;
pub const LIM_ITENS: usize = 200;
pub const LIM_ARQUIVO_BYTES: usize = 4 * 1024 * 1024;
pub const LIM_NOME_ARQUIVO: usize = 120;
const TIPOS: [&str; 3] = ["texto", "tabela", "documento"];

/// Tipos de arquivo aceitos: extensão, mime, se o texto é extraído e a assinatura (magic) esperada.
struct Ext {
    ext: &'static str,
    mime: &'static str,
    texto: bool,
    magic: fn(&[u8]) -> bool,
}

fn qualquer(_: &[u8]) -> bool {
    true
}
fn pdf(b: &[u8]) -> bool {
    b.len() > 4 && b.starts_with(b"%PDF")
}
fn zip(b: &[u8]) -> bool {
    b.len() > 4 && b[0] == 0x50 && b[1] == 0x4b
}

const EXTS: [Ext; 6] = [
    Ext {
        ext: "txt",
        mime: "text/plain; charset=utf-8",
        texto: true,
        magic: qualquer,
    },
    Ext {
        ext: "md",
        mime: "text/plain; charset=utf-8",
        texto: true,
        magic: qualquer,
    },
    Ext {
        ext: "csv",
        mime: "text/plain; charset=utf-8",
        texto: true,
        magic: qualquer,
    },
    Ext {
        ext: "pdf",
        mime: "application/pdf",
        texto: false,
        magic: pdf,
    },
    Ext {
        ext: "docx",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        texto: false,
        magic: zip,
    },
    Ext {
        ext: "xlsx",
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        texto: false,
        magic: zip,
    },
];

fn texto(v: Option<&Json>, campo: &str, max: usize, obrigatorio: bool) -> Res<String> {
    let Some(s) = v.and_then(Json::as_str) else {
        return erro(400, format!("{campo} deve ser texto"));
    };
    if obrigatorio && s.trim().is_empty() {
        return erro(400, format!("{campo} é obrigatório"));
    }
    if tam(s) > max {
        return erro(400, format!("{campo} passa do limite de {max} caracteres"));
    }
    Ok(s.to_string())
}

/// Um número vira o texto que o JavaScript daria (`String(n)`); o resto segue como veio.
fn numero_como_texto(v: &Json) -> Json {
    if v.is_number() {
        Json::from(js_string(Some(v)))
    } else {
        v.clone()
    }
}

fn validar_tabela(t: Option<&Json>) -> Res<Json> {
    let colunas_brutas = t.and_then(|t| t.get("colunas")).and_then(Json::as_array);
    let linhas_brutas = t.and_then(|t| t.get("linhas")).and_then(Json::as_array);
    let (Some(cb), Some(lb)) = (colunas_brutas, linhas_brutas) else {
        return erro(400, "tabela deve ter colunas e linhas");
    };
    if cb.is_empty() || cb.len() > LIM_COLUNAS {
        return erro(
            400,
            format!("a tabela deve ter de 1 a {LIM_COLUNAS} colunas"),
        );
    }
    if lb.len() > LIM_LINHAS {
        return erro(
            400,
            format!("a tabela passa do limite de {LIM_LINHAS} linhas"),
        );
    }
    let mut colunas = Vec::new();
    for c in cb {
        colunas.push(
            texto(
                Some(&numero_como_texto(c)),
                "nome de coluna",
                LIM_NOME_COLUNA,
                true,
            )?
            .trim()
            .to_string(),
        );
    }
    let mut linhas = Vec::new();
    for (i, l) in lb.iter().enumerate() {
        let Some(celulas) = l.as_array().filter(|a| a.len() == colunas.len()) else {
            return erro(
                400,
                format!("a linha {} deve ter {} células", i + 1, colunas.len()),
            );
        };
        let mut nova = Vec::new();
        for c in celulas {
            nova.push(Json::from(texto(
                Some(&numero_como_texto(c)),
                "célula",
                LIM_CELULA,
                false,
            )?));
        }
        linhas.push(Json::Array(nova));
    }
    Ok(json!({ "colunas": colunas, "linhas": linhas }))
}

fn base64_leitor() -> GeneralPurpose {
    GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    )
}

/// Decodifica base64 como o `Buffer.from(x, 'base64')` tolerante (sem exigir padding).
pub fn base64_decodificar(s: &str) -> Res<Vec<u8>> {
    let limpo: String = s
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .trim_end_matches('=')
        .to_string();
    if !limpo
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/')
        || limpo.len() % 4 == 1
    {
        return erro(400, "base64 inválido");
    }
    base64_leitor()
        .decode(limpo)
        .map_err(|_| err(400, "base64 inválido"))
}

/// Arquivo validado: o objeto `arquivo` guardado e o texto extraído (só `.txt`, `.md`, `.csv`).
struct Lido {
    arquivo: Json,
    texto: Option<String>,
}

fn ler_arquivo(a: Option<&Json>) -> Res<Lido> {
    let (Some(nome_bruto), Some(b64)) = (
        a.and_then(|a| a.get("nome")).and_then(Json::as_str),
        a.and_then(|a| a.get("base64")).and_then(Json::as_str),
    ) else {
        return erro(400, "arquivo deve ter nome e base64");
    };
    let ultimo = nome_bruto.rsplit(['\\', '/']).next().unwrap_or("");
    let nome: String = ultimo
        .chars()
        .filter(|c| *c > '\u{1f}')
        .collect::<String>()
        .trim()
        .to_string();
    if nome.is_empty() || tam(&nome) > LIM_NOME_ARQUIVO {
        return erro(
            400,
            format!("nome do arquivo deve ter de 1 a {LIM_NOME_ARQUIVO} caracteres"),
        );
    }
    let ext = if nome.contains('.') {
        nome.rsplit('.').next().unwrap_or("").to_lowercase()
    } else {
        String::new()
    };
    let Some(regra) = EXTS.iter().find(|e| e.ext == ext) else {
        let lista: Vec<&str> = EXTS.iter().map(|e| e.ext).collect();
        return erro(
            400,
            format!("tipo de arquivo não permitido; use {}", lista.join(", ")),
        );
    };
    let sem_pad = b64.trim_end_matches('=');
    let pad = b64.len() - sem_pad.len();
    if pad > 2
        || !sem_pad
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/')
    {
        return erro(400, "base64 inválido");
    }
    if b64.len() * 3 / 4 > LIM_ARQUIVO_BYTES + 2 {
        return erro(
            400,
            format!(
                "arquivo passa do limite de {} MB",
                LIM_ARQUIVO_BYTES / 1024 / 1024
            ),
        );
    }
    let bytes = base64_decodificar(b64)?;
    if bytes.is_empty() {
        return erro(400, "arquivo vazio");
    }
    if bytes.len() > LIM_ARQUIVO_BYTES {
        return erro(
            400,
            format!(
                "arquivo passa do limite de {} MB",
                LIM_ARQUIVO_BYTES / 1024 / 1024
            ),
        );
    }
    if !(regra.magic)(&bytes) {
        return erro(
            400,
            format!("o conteúdo não corresponde a um arquivo .{ext}"),
        );
    }
    let mut extraido = None;
    if regra.texto {
        let t = String::from_utf8_lossy(&bytes).into_owned();
        if t.contains('\0') {
            return erro(400, "o arquivo não parece ser texto");
        }
        if tam(&t) > LIM_TEXTO_DOC {
            return erro(
                400,
                format!("o texto do arquivo passa do limite de {LIM_TEXTO_DOC} caracteres"),
            );
        }
        extraido = Some(t);
    }
    Ok(Lido {
        arquivo: json!({ "nome": nome, "mime": regra.mime, "tamanho": bytes.len(), "base64": b64 }),
        texto: extraido,
    })
}

async fn achar<R: Repositorio>(repo: &R, empresa_id: &str, id: i64) -> Res<Json> {
    empresa(repo, empresa_id).await?;
    match repo.conhecimento_obter(empresa_id, id).await {
        Some(i) => Ok(i),
        None => erro(404, "item de conhecimento inexistente"),
    }
}

fn url_arquivo(empresa_id: &str, id: &Json) -> String {
    format!(
        "/empresas/{empresa_id}/conhecimento/{}/arquivo",
        js_string(Some(id))
    )
}

/// O que o sistema de conversa e a tela recebem (sem os bytes do arquivo).
pub fn publica(empresa_id: &str, item: &Json) -> Json {
    let mut o = Map::new();
    for k in ["id", "titulo", "tipo", "atualizadoEm"] {
        if let Some(v) = item.get(k) {
            o.insert(k.into(), v.clone());
        }
    }
    if let Some(t) = item.get("texto") {
        o.insert("texto".into(), t.clone());
    }
    if let Some(t) = item.get("tabela") {
        o.insert("tabela".into(), t.clone());
    }
    if let Some(a) = item.get("arquivo") {
        let id = item.get("id").cloned().unwrap_or(Json::Null);
        o.insert(
            "arquivo".into(),
            json!({ "nome": a["nome"], "mime": a["mime"], "tamanho": a["tamanho"], "url": url_arquivo(empresa_id, &id) }),
        );
    }
    Json::Object(o)
}

/// Versão para o histórico: conteúdo sem bytes de arquivo e sem campos que mudam sozinhos.
pub fn resumo(item: &Json) -> Json {
    let mut o = Map::new();
    o.insert(
        "titulo".into(),
        item.get("titulo").cloned().unwrap_or(Json::Null),
    );
    o.insert(
        "tipo".into(),
        item.get("tipo").cloned().unwrap_or(Json::Null),
    );
    if let Some(t) = item.get("texto") {
        o.insert("texto".into(), t.clone());
    }
    if let Some(t) = item.get("tabela") {
        o.insert("tabela".into(), t.clone());
    }
    if let Some(a) = item.get("arquivo") {
        o.insert(
            "arquivo".into(),
            json!({ "nome": a["nome"], "mime": a["mime"], "tamanho": a["tamanho"] }),
        );
    }
    Json::Object(o)
}

pub async fn listar_publico<R: Repositorio>(repo: &R, empresa_id: &str) -> Res<Vec<Json>> {
    empresa(repo, empresa_id).await?;
    Ok(repo
        .conhecimento_listar(empresa_id)
        .await
        .iter()
        .map(|i| publica(empresa_id, i))
        .collect())
}

pub async fn obter<R: Repositorio>(repo: &R, empresa_id: &str, id: i64) -> Res<Json> {
    Ok(publica(empresa_id, &achar(repo, empresa_id, id).await?))
}

pub async fn achar_item<R: Repositorio>(repo: &R, empresa_id: &str, id: i64) -> Res<Json> {
    achar(repo, empresa_id, id).await
}

fn limite_itens() -> crate::util::Erro {
    err(
        400,
        format!("limite de {LIM_ITENS} itens de conhecimento por empresa"),
    )
}

pub async fn criar<R: Repositorio>(
    repo: &R,
    plat: &dyn Plataforma,
    empresa_id: &str,
    dados: &Json,
) -> Res<Json> {
    empresa(repo, empresa_id).await?;
    if !dados.is_object() {
        return erro(400, "corpo inválido");
    }
    if repo.conhecimento_listar(empresa_id).await.len() >= LIM_ITENS {
        return Err(limite_itens());
    }
    let tipo = dados
        .get("tipo")
        .and_then(Json::as_str)
        .filter(|t| TIPOS.contains(t));
    let Some(tipo) = tipo else {
        return erro(400, format!("tipo deve ser um de: {}", TIPOS.join(", ")));
    };
    let agora = iso_ms(plat.agora_ms());
    let mut item = Map::new();
    item.insert(
        "titulo".into(),
        texto(dados.get("titulo"), "título", LIM_TITULO, true)?
            .trim()
            .into(),
    );
    item.insert("tipo".into(), tipo.into());
    item.insert("criadoEm".into(), agora.clone().into());
    item.insert("atualizadoEm".into(), agora.into());
    match tipo {
        "texto" => {
            item.insert(
                "texto".into(),
                texto(dados.get("texto"), "texto", LIM_TEXTO, true)?.into(),
            );
        }
        "tabela" => {
            item.insert("tabela".into(), validar_tabela(dados.get("tabela"))?);
        }
        _ => {
            let l = ler_arquivo(dados.get("arquivo"))?;
            item.insert("arquivo".into(), l.arquivo);
            if let Some(t) = l.texto {
                item.insert("texto".into(), t.into());
            }
        }
    }
    match repo
        .conhecimento_criar(empresa_id, Json::Object(item), LIM_ITENS)
        .await
    {
        CriarItem::Ok(i) => Ok(i),
        CriarItem::Limite => Err(limite_itens()),
    }
}

pub async fn editar<R: Repositorio>(
    repo: &R,
    plat: &dyn Plataforma,
    empresa_id: &str,
    id: i64,
    dados: &Json,
) -> Res<Json> {
    let item = achar(repo, empresa_id, id).await?;
    if !dados.is_object() {
        return erro(400, "corpo inválido");
    }
    let tipo_item = item.get("tipo").and_then(Json::as_str).unwrap_or("");
    if let Some(t) = dados.get("tipo")
        && t.as_str() != Some(tipo_item)
    {
        return erro(400, "o tipo do item não pode ser alterado");
    }
    let mut novo: Vec<(String, Json)> = Vec::new();
    if let Some(t) = dados.get("titulo") {
        novo.push((
            "titulo".into(),
            texto(Some(t), "título", LIM_TITULO, true)?.trim().into(),
        ));
    }
    if tipo_item == "texto"
        && let Some(t) = dados.get("texto")
    {
        novo.push((
            "texto".into(),
            texto(Some(t), "texto", LIM_TEXTO, true)?.into(),
        ));
    }
    if tipo_item == "tabela"
        && let Some(t) = dados.get("tabela")
    {
        novo.push(("tabela".into(), validar_tabela(Some(t))?));
    }
    if tipo_item == "documento"
        && let Some(a) = dados.get("arquivo")
    {
        let l = ler_arquivo(Some(a))?;
        novo.push(("arquivo".into(), l.arquivo));
        // sem texto extraído (pdf/docx/xlsx), o texto do arquivo anterior é removido
        novo.push(("texto".into(), l.texto.map_or(Json::Null, Json::from)));
    }
    if novo.is_empty() {
        return erro(400, "nenhuma alteração informada");
    }
    novo.push(("atualizadoEm".into(), iso_ms(plat.agora_ms()).into()));
    match repo.conhecimento_editar(empresa_id, id, novo).await {
        Some(i) => Ok(i),
        None => erro(404, "item de conhecimento inexistente"),
    }
}

pub async fn excluir<R: Repositorio>(repo: &R, empresa_id: &str, id: i64) -> Res<Json> {
    achar(repo, empresa_id, id).await?;
    match repo.conhecimento_excluir(empresa_id, id).await {
        Some(i) => Ok(i),
        None => erro(404, "item de conhecimento inexistente"),
    }
}

/// Arquivo para download: nome, mime e os bytes.
pub struct Baixado {
    pub nome: String,
    pub mime: String,
    pub bytes: Vec<u8>,
}

pub async fn arquivo_de<R: Repositorio>(repo: &R, empresa_id: &str, id: i64) -> Res<Baixado> {
    let item = achar(repo, empresa_id, id).await?;
    let Some(a) = item.get("arquivo") else {
        return erro(404, "este item não tem arquivo");
    };
    let bytes = base64_decodificar(a["base64"].as_str().unwrap_or(""))?;
    Ok(Baixado {
        nome: a["nome"].as_str().unwrap_or("").to_string(),
        mime: a["mime"].as_str().unwrap_or("").to_string(),
        bytes,
    })
}

/// Valor do cabeçalho `Content-Disposition` do download.
pub fn content_disposition(nome: &str) -> String {
    format!("attachment; filename*=UTF-8''{}", codificar_uri(nome))
}

// ---- Busca: o chat pergunta por um assunto e recebe só o que interessa (linhas de tabela, parágrafos) ----

/// Minúsculas, sem acento (NFD sem as marcas combinantes U+0300 a U+036F).
fn norm(s: &str) -> String {
    s.to_lowercase()
        .nfd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .collect()
}

const PALAVRAS_VAZIAS: [&str; 30] = [
    "de", "da", "do", "das", "dos", "no", "na", "nos", "nas", "um", "uma", "o", "a", "os", "as",
    "e", "em", "para", "por", "com", "que", "qual", "quais", "quanto", "quanta", "custa", "voces",
    "tem", "me", "se",
];

fn termos(q: &str) -> Vec<String> {
    norm(q)
        .split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit()))
        .filter(|t| {
            t.chars().count() >= 2 && !PALAVRAS_VAZIAS.contains(t) && *t != "ao" && *t != "aos"
        })
        .map(|t| {
            if t.chars().count() > 3 {
                t.strip_suffix('s').unwrap_or(t).to_string()
            } else {
                t.to_string()
            }
        })
        .collect()
}

fn acertos(texto: &str, ts: &[String]) -> usize {
    let n = norm(texto);
    ts.iter().filter(|t| n.contains(t.as_str())).count()
}

/// `Number(limite) || 5`, de 1 a 10.
fn limite_busca(limite: Option<&str>) -> usize {
    let n = limite.map_or(0.0, |s| {
        if s.trim().is_empty() {
            0.0
        } else {
            s.trim().parse::<f64>().unwrap_or(f64::NAN)
        }
    });
    let n = if n.is_nan() || n == 0.0 { 5.0 } else { n };
    n.clamp(1.0, 10.0).trunc() as usize
}

fn strs(v: &Json) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .map(|x| x.as_str().unwrap_or("").to_string())
                .collect()
        })
        .unwrap_or_default()
}

pub async fn buscar<R: Repositorio>(
    repo: &R,
    empresa_id: &str,
    consulta: Option<&str>,
    limite: Option<&str>,
) -> Res<Json> {
    empresa(repo, empresa_id).await?;
    let itens = repo.conhecimento_listar(empresa_id).await;
    let q = consulta.unwrap_or("").trim().to_string();
    if q.is_empty() {
        return erro(400, "informe o assunto da busca em q");
    }
    if tam(&q) > 200 {
        return erro(400, "a busca passa do limite de 200 caracteres");
    }
    let ts = termos(&q);
    // pergunta genérica demais: devolve o catálogo para a IA escolher
    if ts.is_empty() {
        let catalogo: Vec<Json> = itens
            .iter()
            .map(|i| json!({ "id": i["id"], "titulo": i["titulo"], "tipo": i["tipo"] }))
            .collect();
        return Ok(
            json!({ "consulta": q, "catalogo": true, "total": itens.len(), "resultados": catalogo }),
        );
    }
    let mut out: Vec<(usize, Json)> = Vec::new();
    for it in &itens {
        let titulo = it["titulo"].as_str().unwrap_or("");
        let arq_nome = it
            .get("arquivo")
            .and_then(|a| a["nome"].as_str())
            .unwrap_or("");
        let no_titulo = acertos(&format!("{titulo} {arq_nome}"), &ts);
        let tipo = it["tipo"].as_str().unwrap_or("");
        if tipo == "tabela" {
            let colunas = &it["tabela"]["colunas"];
            let todas: Vec<Vec<String>> = it["tabela"]["linhas"]
                .as_array()
                .map(|a| a.iter().map(strs).collect())
                .unwrap_or_default();
            let mut linhas: Vec<(usize, &Vec<String>)> = todas
                .iter()
                .map(|l| (acertos(&l.join(" "), &ts), l))
                .filter(|x| x.0 > 0)
                .collect();
            linhas.sort_by_key(|a| std::cmp::Reverse(a.0));
            if let Some(melhor) = linhas.first() {
                let mostradas: Vec<&Vec<String>> = linhas.iter().take(20).map(|x| x.1).collect();
                out.push((melhor.0 * 2 + no_titulo, json!({ "id": it["id"], "titulo": it["titulo"], "tipo": "tabela", "colunas": colunas, "linhas": mostradas, "parcial": linhas.len() < todas.len() })));
            } else if no_titulo > 0 {
                let mostradas: Vec<&Vec<String>> = todas.iter().take(50).collect();
                out.push((no_titulo, json!({ "id": it["id"], "titulo": it["titulo"], "tipo": "tabela", "colunas": colunas, "linhas": mostradas, "parcial": todas.len() > 50 })));
            }
        } else if let Some(t) = it.get("texto").and_then(Json::as_str) {
            let mut paragrafos: Vec<(usize, String)> = t
                .split('\n')
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .map(|p| (acertos(p, &ts), p.to_string()))
                .collect();
            paragrafos.retain(|x| x.0 > 0);
            paragrafos.sort_by_key(|a| std::cmp::Reverse(a.0));
            paragrafos.truncate(5);
            let mut base = Map::new();
            base.insert("id".into(), it["id"].clone());
            base.insert("titulo".into(), it["titulo"].clone());
            base.insert("tipo".into(), it["tipo"].clone());
            if let Some(a) = it.get("arquivo") {
                base.insert(
                    "arquivo".into(),
                    json!({ "nome": a["nome"], "url": url_arquivo(empresa_id, &it["id"]) }),
                );
            }
            if let Some(melhor) = paragrafos.first() {
                base.insert(
                    "trechos".into(),
                    paragrafos
                        .iter()
                        .map(|x| Json::from(x.1.clone()))
                        .collect::<Vec<_>>()
                        .into(),
                );
                out.push((melhor.0 * 2 + no_titulo, Json::Object(base)));
            } else if no_titulo > 0 {
                base.insert("trechos".into(), json!([slice16(t, 0, 600)]));
                out.push((no_titulo, Json::Object(base)));
            }
        } else if let (Some(a), true) = (it.get("arquivo"), no_titulo > 0) {
            out.push((no_titulo, json!({ "id": it["id"], "titulo": it["titulo"], "tipo": "documento", "arquivo": { "nome": a["nome"], "url": url_arquivo(empresa_id, &it["id"]) } })));
        }
    }
    out.sort_by_key(|a| std::cmp::Reverse(a.0));
    let total = out.len();
    let resultados: Vec<Json> = out
        .into_iter()
        .take(limite_busca(limite))
        .map(|x| x.1)
        .collect();
    Ok(json!({ "consulta": q, "total": total, "resultados": resultados }))
}

/// Comprimento em unidades UTF-16, para o limite do prompt.
pub fn tamanho16(s: &str) -> usize {
    len16(s)
}
