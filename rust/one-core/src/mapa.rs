//! Mapa de mesas (espelha `src/mapa.js`).

use crate::agentes::empresa;
use crate::reservas::DURACAO_MIN;
use crate::tempo::minutos_absolutos;
use crate::util::Res;
use one_store::{Json, Repositorio};
use serde_json::{Map, json};

pub async fn mapa<R: Repositorio>(
    repo: &R,
    empresa_id: &str,
    data: &str,
    horario: &str,
) -> Res<Json> {
    let l = empresa(repo, empresa_id).await?;
    let i = minutos_absolutos(data, horario)?;
    let confirmadas = repo.reserva_confirmadas(empresa_id, None).await;
    let ambientes: Vec<Json> = l
        .ambientes
        .iter()
        .map(|a| {
            let mesas: Vec<Json> = a
                .mesas
                .iter()
                .map(|m| {
                    let r = confirmadas.iter().find(|x| x.mesa_id == m.id && i < x.fim && i + DURACAO_MIN > x.inicio);
                    let reserva = r.map_or(Json::Null, |r| {
                        let mut o = Map::new();
                        o.insert("horario".into(), r.horario.clone().into());
                        o.insert("pessoas".into(), r.pessoas.into());
                        o.insert("status".into(), r.status.clone().into());
                        if let Some(n) = r.nome_cliente.as_ref().filter(|s| !s.is_empty()) {
                            o.insert("nomeCliente".into(), n.clone().into());
                        }
                        if let Some(c) = r.contato.as_ref().filter(|s| !s.is_empty()) {
                            o.insert("contato".into(), c.clone().into());
                        }
                        Json::Object(o)
                    });
                    json!({ "id": m.id, "capacidade": m.capacidade, "situacao": if r.is_some() { "reservada" } else { "livre" }, "reserva": reserva })
                })
                .collect();
            json!({ "ambiente": a.nome, "mesas": mesas })
        })
        .collect();
    Ok(Json::Array(ambientes))
}
