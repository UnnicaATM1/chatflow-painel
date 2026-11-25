//! Histórico de modificações (espelha `src/historico.js`): só acrescenta. Quem, quando, o quê e antes/depois.

use crate::util::{decodificar_uri, slice16};
use one_store::{Json, Repositorio};
use serde_json::Map;

/// Quem fez: papel do token (confiável) e o operador informado no cabeçalho `X-Operador` (rótulo, não prova de identidade).
#[derive(Debug, Clone)]
pub struct Ator {
    pub papel: String,
    pub operador: Option<String>,
    /// Usuário logado: nome e id vêm da sessão (o cabeçalho `X-Operador` é ignorado).
    pub usuario: Option<(String, String)>,
}

impl Ator {
    pub fn novo(papel: &str, cabecalho_operador: Option<&str>) -> Self {
        let bruto = decodificar_uri(cabecalho_operador.unwrap_or("")).unwrap_or_default();
        let op = slice16(bruto.trim(), 0, 60);
        Self {
            papel: papel.to_string(),
            operador: if op.is_empty() { None } else { Some(op) },
            usuario: None,
        }
    }

    /// Ator de um usuário com login: `(id, nome)`.
    pub fn de_usuario(papel: &str, id: &str, nome: &str) -> Self {
        Self {
            papel: papel.to_string(),
            operador: Some(nome.to_string()),
            usuario: Some((id.to_string(), nome.to_string())),
        }
    }

    /// Os pares `papel` e `operador`, para espalhar num evento (como `...ator` do JavaScript).
    pub fn pares(&self) -> Vec<(&'static str, Json)> {
        let mut v = vec![
            ("papel", Json::from(self.papel.clone())),
            (
                "operador",
                self.operador.clone().map_or(Json::Null, Json::from),
            ),
        ];
        if let Some((id, nome)) = &self.usuario {
            v.push(("usuarioId", Json::from(id.clone())));
            v.push(("usuarioNome", Json::from(nome.clone())));
        }
        v
    }
}

/// Monta um evento mantendo a ordem de inserção e a posição da primeira ocorrência de cada chave
/// (igual a `{ a, ...b, a: 2 }` do JavaScript).
pub fn evento(pares: Vec<(&str, Json)>) -> Json {
    let mut m = Map::new();
    for (k, v) in pares {
        m.insert(k.to_string(), v);
    }
    Json::Object(m)
}

/// Só os campos que mudaram, com o valor antes e depois: `(antes, depois)`.
pub fn diff(
    antes: Option<&Map<String, Json>>,
    depois: Option<&Map<String, Json>>,
) -> (Map<String, Json>, Map<String, Json>) {
    let (mut a, mut d) = (Map::new(), Map::new());
    let mut chaves: Vec<&String> = Vec::new();
    for m in [antes, depois].into_iter().flatten() {
        for k in m.keys() {
            if !chaves.contains(&k) {
                chaves.push(k);
            }
        }
    }
    for k in chaves {
        let (x, y) = (antes.and_then(|m| m.get(k)), depois.and_then(|m| m.get(k)));
        if x.map(Json::to_string) != y.map(Json::to_string) {
            if let Some(x) = x {
                a.insert(k.clone(), x.clone());
            }
            if let Some(y) = y {
                d.insert(k.clone(), y.clone());
            }
        }
    }
    (a, d)
}

pub async fn registrar<R: Repositorio>(repo: &R, ev: Json) -> Json {
    repo.historico_acrescentar(ev).await
}

#[cfg(test)]
mod testes {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use serde_json::json;

    #[test]
    fn operador_decodifica_apara_e_corta() {
        assert_eq!(
            Ator::novo("cliente", Some("Mari%C3%A1"))
                .operador
                .as_deref(),
            Some("Mariá")
        );
        assert_eq!(Ator::novo("cliente", Some("%ZZ")).operador, None);
        assert_eq!(Ator::novo("cliente", Some("   ")).operador, None);
        assert_eq!(
            Ator::novo("cliente", Some(&"a".repeat(80)))
                .operador
                .unwrap()
                .len(),
            60
        );
    }

    #[test]
    fn evento_repete_chave_sem_mudar_a_posicao() {
        let e = evento(vec![
            ("a", json!(1)),
            ("acao", json!("x")),
            ("b", json!(2)),
            ("acao", json!("y")),
        ]);
        assert_eq!(e.to_string(), r#"{"a":1,"acao":"y","b":2}"#);
    }

    #[test]
    fn diff_so_do_que_mudou() {
        let a = json!({ "x": 1, "y": 2 });
        let d = json!({ "x": 1, "y": 3, "z": 4 });
        let (da, dd) = diff(a.as_object(), d.as_object());
        assert_eq!(
            (Json::Object(da).to_string(), Json::Object(dd).to_string()),
            (r#"{"y":2}"#.to_string(), r#"{"y":3,"z":4}"#.to_string())
        );
    }
}
