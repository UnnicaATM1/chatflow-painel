//! Agente de cada empresa (espelha `src/agentes.js`): seis campos de texto livre com limite de caracteres.

use crate::util::{Res, erro, tam};
use one_store::{Empresa, Json, Repositorio};
use serde_json::Map;

/// Campos do agente, na ordem em que a API os devolve, e o limite de caracteres de cada um.
pub const LIMITES: [(&str, usize); 6] = [
    ("nome", 100),
    ("descricao", 1000),
    ("personalidade", 2000),
    ("habilidades", 22_000),
    ("produtos", 22_000),
    ("restricoes", 2000),
];

/// Registro da empresa (somente leitura) ou 404.
pub async fn empresa<R: Repositorio>(repo: &R, id: &str) -> Res<Empresa> {
    match repo.empresa_obter(id).await {
        Some(e) => Ok(e),
        None => erro(404, "empresa inexistente"),
    }
}

/// O bloco inteiro do agente, sempre com os seis campos.
pub async fn ler_config<R: Repositorio>(repo: &R, empresa_id: &str) -> Res<Json> {
    let e = empresa(repo, empresa_id).await?;
    let mut out = Map::new();
    for (c, _) in LIMITES {
        out.insert(
            c.into(),
            Json::from(e.agente.get(c).and_then(Json::as_str).unwrap_or("")),
        );
    }
    Ok(Json::Object(out))
}

fn checar(agente: &Json, campo: &str, valor: Option<&Json>, papel: &str) -> Res<()> {
    let Some((_, limite)) = LIMITES.iter().find(|(c, _)| *c == campo) else {
        return erro(400, format!("campo inválido: {campo}"));
    };
    // agente.editavelPor: { campo: ['cliente', 'integracao'] }; padrão: só integração.
    let permitido = match agente
        .get("editavelPor")
        .and_then(|m| m.get(campo))
        .and_then(Json::as_array)
    {
        Some(lista) => lista.iter().any(|p| p.as_str() == Some(papel)),
        None => papel == "integracao",
    };
    if !permitido {
        return erro(403, format!("sem permissão para editar {campo}"));
    }
    let Some(texto) = valor.and_then(Json::as_str) else {
        return erro(400, format!("{campo} deve ser texto"));
    };
    if tam(texto) > *limite {
        return erro(
            400,
            format!("{campo} passa do limite de {limite} caracteres"),
        );
    }
    Ok(())
}

/// Salva vários campos de uma vez, tudo ou nada: se um falhar, nenhum é gravado.
/// `mudancas`: pares (nome do campo, valor); o valor ausente vira "não é texto".
pub async fn atualizar_varios<R: Repositorio>(
    repo: &R,
    empresa_id: &str,
    mudancas: &[(String, Option<Json>)],
    papel: &str,
) -> Res<()> {
    let e = empresa(repo, empresa_id).await?;
    if mudancas.is_empty() {
        return erro(400, "nenhum campo informado");
    }
    for (campo, valor) in mudancas {
        checar(&e.agente, campo, valor.as_ref(), papel)?;
    }
    let grav = mudancas
        .iter()
        .filter_map(|(c, v)| {
            v.as_ref()
                .and_then(Json::as_str)
                .map(|s| (c.clone(), s.to_string()))
        })
        .collect();
    repo.agente_atualizar(empresa_id, grav).await;
    Ok(())
}
