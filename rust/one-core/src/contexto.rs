//! Contexto completo do agente de uma empresa, pronto para o sistema de conversa (espelha `src/contexto.js`):
//! o bloco do agente, os recursos ligados, a base de conhecimento e um prompt montado.
//! Sem travessões nos textos (regra do design system para textos de agente).

use crate::agentes::{empresa, ler_config};
use crate::conhecimento::{listar_publico, tamanho16};
use crate::util::Res;
use one_store::{Empresa, Json, Repositorio};
use serde_json::json;

/// Recursos que a empresa usa e os endereços que o sistema de conversa pode chamar.
pub fn recursos_de(e: &Empresa) -> Json {
    let base = format!("/empresas/{}", e.id);
    let mut ep: Vec<Json> = vec![
        json!({ "metodo": "GET", "caminho": format!("{base}/contexto"), "descricao": "contexto completo do agente em uma chamada" }),
        json!({ "metodo": "GET", "caminho": format!("{base}/agente"), "descricao": "configuração do agente" }),
    ];
    if e.modulos.reservas {
        ep.push(json!({ "metodo": "GET", "caminho": format!("{base}/disponibilidade?data=AAAA-MM-DD&horario=HH:MM&pessoas=N"), "descricao": "mesas livres por ambiente" }));
        ep.push(json!({ "metodo": "POST", "caminho": format!("{base}/reservas"), "descricao": "registrar reserva (cabeçalho Idempotency-Key)" }));
    }
    if e.modulos.conhecimento {
        ep.push(json!({ "metodo": "GET", "caminho": format!("{base}/conhecimento/buscar?q=ASSUNTO"), "descricao": "busca no conhecimento (preços, horários, regras): devolve só o que interessa" }));
        ep.push(json!({ "metodo": "GET", "caminho": format!("{base}/conhecimento"), "descricao": "todos os itens de conhecimento (textos, tabelas, documentos)" }));
        ep.push(json!({ "metodo": "GET", "caminho": format!("{base}/conhecimento/:itemId"), "descricao": "um item" }));
    }
    json!({ "empresa": e.nome, "reservas": e.modulos.reservas, "conhecimento": e.modulos.conhecimento, "endpoints": ep })
}

/// Acima deste tamanho (em unidades UTF-16, como o `length` do JavaScript) o prompt não carrega o conhecimento inteiro.
const LIMITE_PROMPT_CONHECIMENTO: usize = 6000;

fn celula(c: &Json) -> String {
    crate::util::js_string(Some(c))
        .replace('|', "/")
        .replace('\n', " ")
}

fn tabela_markdown(t: &Json) -> String {
    let colunas: Vec<&Json> = t["colunas"]
        .as_array()
        .map(|a| a.iter().collect())
        .unwrap_or_default();
    let mut linhas = vec![
        format!(
            "| {} |",
            colunas
                .iter()
                .map(|c| celula(c))
                .collect::<Vec<_>>()
                .join(" | ")
        ),
        format!(
            "| {} |",
            colunas
                .iter()
                .map(|_| "---")
                .collect::<Vec<_>>()
                .join(" | ")
        ),
    ];
    for l in t["linhas"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        linhas.push(format!(
            "| {} |",
            l.as_array()
                .map(|a| a.iter().map(celula).collect::<Vec<_>>().join(" | "))
                .unwrap_or_default()
        ));
    }
    linhas.join("\n")
}

fn secao(titulo: &str, texto: &str) -> String {
    if texto.trim().is_empty() {
        String::new()
    } else {
        format!("\n## {titulo}\n{}\n", texto.trim())
    }
}

pub fn montar_prompt(e: &Empresa, agente: &Json, itens: &[Json]) -> String {
    let campo = |k: &str| agente[k].as_str().unwrap_or("").to_string();
    let nome = campo("nome");
    let nome = if nome.trim().is_empty() {
        "o assistente".to_string()
    } else {
        nome.trim().to_string()
    };
    let mut p = format!("Você é {nome}, atendente virtual da empresa {}.\n", e.nome);
    if !campo("descricao").trim().is_empty() {
        p.push_str(&format!("\n{}\n", campo("descricao").trim()));
    }
    p.push_str(&secao("Personalidade e objetivo", &campo("personalidade")));
    p.push_str(&secao("Habilidades", &campo("habilidades")));
    p.push_str(&secao("Produtos e serviços", &campo("produtos")));
    p.push_str(&secao("Restrições", &campo("restricoes")));

    if e.modulos.conhecimento && !itens.is_empty() {
        let mut completo = String::new();
        for it in itens {
            let titulo = it["titulo"].as_str().unwrap_or("");
            match it["tipo"].as_str() {
                Some("tabela") => completo.push_str(&format!(
                    "\n### {titulo}\n{}\n",
                    tabela_markdown(&it["tabela"])
                )),
                Some("texto") => completo.push_str(&format!(
                    "\n### {titulo}\n{}\n",
                    it["texto"].as_str().unwrap_or("")
                )),
                _ => {
                    let corpo = match it.get("texto").and_then(Json::as_str) {
                        Some(t) => t.to_string(),
                        None => format!(
                            "Arquivo disponível para consulta em {}",
                            it["arquivo"]["url"].as_str().unwrap_or("")
                        ),
                    };
                    completo.push_str(&format!(
                        "\n### {titulo} (documento {})\n{corpo}\n",
                        it["arquivo"]["nome"].as_str().unwrap_or("")
                    ));
                }
            }
        }
        p.push_str("\n## Base de conhecimento\n");
        if tamanho16(&completo) <= LIMITE_PROMPT_CONHECIMENTO {
            p.push_str("Use estas informações para responder. Se algo não estiver aqui, use a função one_buscar_conhecimento; se mesmo assim não achar, diga que vai confirmar com a equipe e não invente.\n");
            p.push_str(&completo);
        } else {
            p.push_str("A empresa tem uma base de conhecimento (preços, horários, regras, documentos). Quando o cliente perguntar sobre preços, produtos, serviços, horários ou regras, chame a função one_buscar_conhecimento com o assunto e responda só com o que ela devolver. Se não achar, diga que vai confirmar com a equipe e não invente.\n");
            let titulos: Vec<&str> = itens
                .iter()
                .map(|i| i["titulo"].as_str().unwrap_or(""))
                .collect();
            p.push_str(&format!("Assuntos disponíveis: {}.\n", titulos.join("; ")));
        }
    }

    if e.modulos.reservas {
        p.push_str("\n## Reservas de mesa\nPara reservar: 1) pergunte data, horário, número de pessoas e o ambiente preferido; 2) consulte a disponibilidade antes de oferecer qualquer horário; 3) ofereça ao cliente apenas as mesas livres devolvidas; 4) quando o cliente escolher, registre a reserva; 5) envie também o nome e o contato do cliente quando você os tiver (nomeCliente e contato); 6) só confirme ao cliente depois que o sistema responder \"confirmada\". Se a resposta for \"indisponivel\", ofereça as alternativas devolvidas e não prometa mesa.\n");
    }
    format!("{}\n", p.trim())
}

pub async fn contexto<R: Repositorio>(repo: &R, empresa_id: &str) -> Res<Json> {
    let e = empresa(repo, empresa_id).await?;
    let agente = ler_config(repo, empresa_id).await?;
    let itens = if e.modulos.conhecimento {
        listar_publico(repo, empresa_id).await?
    } else {
        Vec::new()
    };
    let r = recursos_de(&e);
    let prompt = montar_prompt(&e, &agente, &itens);
    Ok(json!({
        "empresa": { "id": e.id, "nome": e.nome },
        "agente": agente,
        "recursos": { "reservas": r["reservas"], "conhecimento": r["conhecimento"] },
        "conhecimento": itens,
        "prompt": prompt,
    }))
}
