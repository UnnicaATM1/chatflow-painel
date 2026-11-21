//! Tipos de dados do ONE (espelham os objetos de `src/repositorio.js`).

use serde_json::Value as Json;

#[derive(Debug, Clone, PartialEq)]
pub struct Mesa {
    pub id: String,
    pub capacidade: i64,
    pub reservavel: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Ambiente {
    pub nome: String,
    pub mesas: Vec<Mesa>,
}

/// Chave de API de uma empresa: só o hash SHA-256 é guardado.
#[derive(Debug, Clone, PartialEq)]
pub struct Chave {
    pub hash: String,
    pub prefixo: String,
    pub criada_em: String,
}

/// Recursos ligados da empresa (padrão: tudo ligado).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Modulos {
    pub reservas: bool,
    pub conhecimento: bool,
}

impl Default for Modulos {
    fn default() -> Self {
        Self {
            reservas: true,
            conhecimento: true,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Empresa {
    pub id: String,
    pub nome: String,
    /// Objeto com `nome`, `descricao`, `personalidade`, `habilidades`, `produtos`, `restricoes` e `editavelPor`.
    pub agente: Json,
    pub ambientes: Vec<Ambiente>,
    pub modulos: Modulos,
    pub chave: Option<Chave>,
}

impl Empresa {
    pub fn nova(
        id: &str,
        nome: &str,
        agente: Json,
        ambientes: Vec<Ambiente>,
        modulos: Modulos,
    ) -> Self {
        Self {
            id: id.to_string(),
            nome: nome.to_string(),
            agente,
            ambientes,
            modulos,
            chave: None,
        }
    }

    /// Lê uma empresa de um objeto JSON (semente de testes e dados de demonstração): `{ id, nome, ambientes, agente, modulos? }`.
    pub fn de_json(v: &Json) -> Result<Self, String> {
        let texto = |k: &str| {
            v.get(k)
                .and_then(Json::as_str)
                .map(str::to_string)
                .ok_or_else(|| format!("empresa sem {k}"))
        };
        let mut ambientes = Vec::new();
        for a in v
            .get("ambientes")
            .and_then(Json::as_array)
            .map_or(&[][..], Vec::as_slice)
        {
            let mut mesas = Vec::new();
            for m in a
                .get("mesas")
                .and_then(Json::as_array)
                .map_or(&[][..], Vec::as_slice)
            {
                mesas.push(Mesa {
                    id: m
                        .get("id")
                        .and_then(Json::as_str)
                        .ok_or("mesa sem id")?
                        .to_string(),
                    capacidade: m
                        .get("capacidade")
                        .and_then(Json::as_i64)
                        .ok_or("mesa sem capacidade")?,
                    reservavel: m.get("reservavel").and_then(Json::as_bool).unwrap_or(false),
                });
            }
            ambientes.push(Ambiente {
                nome: a
                    .get("nome")
                    .and_then(Json::as_str)
                    .ok_or("ambiente sem nome")?
                    .to_string(),
                mesas,
            });
        }
        let mut modulos = Modulos::default();
        if let Some(m) = v.get("modulos") {
            if let Some(b) = m.get("reservas").and_then(Json::as_bool) {
                modulos.reservas = b;
            }
            if let Some(b) = m.get("conhecimento").and_then(Json::as_bool) {
                modulos.conhecimento = b;
            }
        }
        let agente = v
            .get("agente")
            .cloned()
            .unwrap_or_else(|| Json::Object(serde_json::Map::new()));
        Ok(Self::nova(
            &texto("id")?,
            &texto("nome")?,
            agente,
            ambientes,
            modulos,
        ))
    }
}

/// Reserva. `inicio` e `fim` são minutos absolutos (ver `one-core::tempo`).
#[derive(Debug, Clone, PartialEq)]
pub struct Reserva {
    /// Código curto da reserva (8 caracteres): é o `reservaId` que sai pela API.
    pub id: String,
    /// UUID v4 interno (chave primária). Nunca sai pela API.
    pub uuid: String,
    pub empresa_id: String,
    pub mesa_id: Option<String>,
    pub ambiente: String,
    pub data: String,
    pub horario: String,
    pub pessoas: i64,
    pub inicio: i64,
    pub fim: i64,
    pub status: String,
    pub nome_cliente: Option<String>,
    pub contato: Option<String>,
}
