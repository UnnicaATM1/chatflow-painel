//! Reservas de mesa (espelha `src/reservas.js`): disponibilidade, criação idempotente, edição, cancelamento, reativação.

use crate::agentes::empresa;
use crate::tempo::minutos_absolutos;
use crate::util::{Res, data_ok, err, erro, horario_ok, inteiro, tam};
use one_store::{CriarReserva, Empresa, Json, Mesa, Muda, Repositorio, Reserva};
use serde_json::{Map, json};

pub const DURACAO_MIN: i64 = 90;

#[derive(Debug, Clone)]
pub struct Livre {
    pub mesa: Mesa,
    pub ambiente: String,
}

/// Pura: mesas livres de `l` no horário, dadas as reservas `confirmadas` da empresa.
pub fn livres(
    l: &Empresa,
    confirmadas: &[Reserva],
    data: &str,
    horario: &str,
    pessoas: i64,
    ambiente: Option<&str>,
) -> Res<Vec<Livre>> {
    let i = minutos_absolutos(data, horario)?;
    let mut out = Vec::new();
    for amb in &l.ambientes {
        if ambiente.is_some_and(|a| a != amb.nome) {
            continue;
        }
        for m in &amb.mesas {
            if !m.reservavel || m.capacidade < pessoas {
                continue;
            }
            if !confirmadas.iter().any(|r| {
                r.mesa_id.as_deref() == Some(m.id.as_str())
                    && i < r.fim
                    && i + DURACAO_MIN > r.inicio
            }) {
                out.push(Livre {
                    mesa: m.clone(),
                    ambiente: amb.nome.clone(),
                });
            }
        }
    }
    Ok(out)
}

/// `{ ambientes: [{ ambiente, mesas: [{ id, capacidade }] }] }`: mesas livres agrupadas pelo layout da empresa.
pub async fn disponibilidade<R: Repositorio>(
    repo: &R,
    empresa_id: &str,
    data: &str,
    horario: &str,
    pessoas: Option<i64>,
    ignorar_id: Option<&str>,
) -> Res<Json> {
    let l = empresa(repo, empresa_id).await?;
    let Some(pessoas) = pessoas.filter(|p| *p >= 1) else {
        return erro(400, "pessoas inválido");
    };
    let confirmadas = repo.reserva_confirmadas(empresa_id, ignorar_id).await;
    let livres = livres(&l, &confirmadas, data, horario, pessoas, None)?;
    let ambientes: Vec<Json> = l
        .ambientes
        .iter()
        .map(|a| {
            let mut mesas: Vec<&Livre> = livres.iter().filter(|x| x.ambiente == a.nome).collect();
            mesas.sort_by_key(|x| x.mesa.capacidade);
            let mesas: Vec<Json> = mesas
                .iter()
                .map(|x| {
                    let mut v = json!({ "id": x.mesa.id, "capacidade": x.mesa.capacidade });
                    if !x.mesa.descricao.is_empty() {
                        v["descricao"] = x.mesa.descricao.clone().into();
                    }
                    v
                })
                .collect();
            json!({ "ambiente": a.nome, "mesas": mesas })
        })
        .collect();
    Ok(json!({ "ambientes": ambientes }))
}

/// Dados do cliente que o chat conhece (opcionais): nome até 80 e contato até 40 caracteres.
/// Devolve `(nomeCliente, contato)`; `None` quando o campo não veio (ou veio nulo).
pub fn validar_cliente(
    nome: Option<&Json>,
    contato: Option<&Json>,
) -> Res<(Option<String>, Option<String>)> {
    let mut saida = [None, None];
    for (i, (campo, max, v)) in [("nomeCliente", 80, nome), ("contato", 40, contato)]
        .into_iter()
        .enumerate()
    {
        match v {
            None | Some(Json::Null) => {}
            Some(Json::String(s)) => {
                let t = s.trim();
                if tam(t) > max {
                    return erro(400, format!("{campo} passa do limite de {max} caracteres"));
                }
                saida[i] = Some(t.to_string());
            }
            Some(_) => return erro(400, format!("{campo} deve ser texto")),
        }
    }
    let [n, c] = saida;
    Ok((n, c))
}

/// Entrada de `reservar`. Os campos `Json` mantêm o tipo que veio no corpo (o JavaScript os valida em tempo de execução).
#[derive(Debug, Default, Clone)]
pub struct PedidoReserva {
    pub empresa_id: String,
    pub data: String,
    pub horario: String,
    pub pessoas: Option<Json>,
    pub ambiente: Option<Json>,
    pub mesa_id: Option<Json>,
    pub chave: Option<String>,
    pub nome_cliente: Option<Json>,
    pub contato: Option<Json>,
}

/// Valor "truthy" de texto usado como filtro (`if (ambiente)`); tipos que não são texto nunca casam com nada.
fn filtro(v: Option<&Json>) -> Option<String> {
    match v {
        Some(Json::String(s)) if !s.is_empty() => Some(s.clone()),
        Some(Json::Null | Json::String(_)) | None => None,
        Some(Json::Bool(false)) => None,
        Some(Json::Number(n)) if n.as_f64() == Some(0.0) => None,
        Some(_) => Some("\u{0}nunca".into()),
    }
}

pub fn publica(r: &Reserva) -> Json {
    let mut o = Map::new();
    o.insert("id".into(), r.id.clone().into());
    o.insert("mesaId".into(), r.mesa_id.clone().into());
    o.insert("ambiente".into(), r.ambiente.clone().into());
    o.insert("data".into(), r.data.clone().into());
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
}

/// Resposta da reserva e, quando foi criada agora, a reserva (para o histórico). `criada` é `None` se a chave
/// de idempotência repetiu uma resposta anterior ou se não havia mesa.
pub struct Reservado {
    pub resposta: Json,
    pub criada: Option<Reserva>,
}

pub async fn reservar_detalhado<R: Repositorio>(repo: &R, p: &PedidoReserva) -> Res<Reservado> {
    let l = empresa(repo, &p.empresa_id).await?;
    let Some(pessoas) = inteiro(p.pessoas.as_ref()).filter(|n| *n >= 1) else {
        return erro(400, "pessoas inválido");
    };
    let (nome_cliente, contato) = validar_cliente(p.nome_cliente.as_ref(), p.contato.as_ref())?;

    let chave = p.chave.as_deref().filter(|c| !c.is_empty());
    if let Some(c) = chave
        && let Some(antiga) = repo.idempotencia_obter(&p.empresa_id, c).await
    {
        return Ok(Reservado {
            resposta: antiga,
            criada: None,
        });
    }

    let ambiente = filtro(p.ambiente.as_ref());
    let mesa_id = filtro(p.mesa_id.as_ref());
    let confirmadas = repo.reserva_confirmadas(&p.empresa_id, None).await;
    let mut ok = livres(
        &l,
        &confirmadas,
        &p.data,
        &p.horario,
        pessoas,
        ambiente.as_deref(),
    )?;
    if let Some(m) = &mesa_id {
        ok.retain(|x| &x.mesa.id == m);
    }
    if !ok.is_empty() {
        ok.sort_by_key(|x| x.mesa.capacidade);
        let ini = minutos_absolutos(&p.data, &p.horario)?;
        let nova = Reserva {
            id: String::new(),
            uuid: String::new(),
            empresa_id: p.empresa_id.clone(),
            mesa_id: None,
            ambiente: String::new(),
            data: p.data.clone(),
            horario: p.horario.clone(),
            pessoas,
            inicio: ini,
            fim: ini + DURACAO_MIN,
            status: "confirmada".into(),
            nome_cliente,
            contato,
        };
        let candidatas = ok
            .iter()
            .map(|x| (x.mesa.id.clone(), x.ambiente.clone()))
            .collect();
        match repo
            .reserva_criar(&p.empresa_id, chave, candidatas, nova)
            .await
        {
            CriarReserva::Repetida(resposta) => {
                return Ok(Reservado {
                    resposta,
                    criada: None,
                });
            }
            CriarReserva::Criada { resposta, reserva } => {
                return Ok(Reservado {
                    resposta,
                    criada: Some(reserva),
                });
            }
            // a mesa foi tomada entre a leitura e a gravação: cai na resposta "indisponivel" com a situação atual
            CriarReserva::Conflito => {}
        }
    }
    let mut alternativas: Vec<String> = Vec::new();
    if ambiente.is_some() {
        let agora = repo.reserva_confirmadas(&p.empresa_id, None).await;
        for x in livres(&l, &agora, &p.data, &p.horario, pessoas, None)? {
            if !alternativas.contains(&x.ambiente) {
                alternativas.push(x.ambiente);
            }
        }
    }
    let disp = disponibilidade(
        repo,
        &p.empresa_id,
        &p.data,
        &p.horario,
        Some(pessoas),
        None,
    )
    .await?;
    let resposta = json!({
        "status": "indisponivel",
        "alternativas": alternativas.iter().map(|a| json!({ "tipo": "outro-ambiente", "ambiente": a })).collect::<Vec<_>>(),
        "disponibilidade": disp["ambientes"],
    });
    if let Some(c) = chave {
        repo.idempotencia_gravar(&p.empresa_id, c, resposta.clone())
            .await;
    }
    Ok(Reservado {
        resposta,
        criada: None,
    })
}

pub async fn reservar<R: Repositorio>(repo: &R, p: &PedidoReserva) -> Res<Json> {
    Ok(reservar_detalhado(repo, p).await?.resposta)
}

async fn achar<R: Repositorio>(repo: &R, empresa_id: &str, id: &str) -> Res<Reserva> {
    empresa(repo, empresa_id).await?;
    match repo.reserva_obter(empresa_id, id).await {
        Some(r) => Ok(r),
        None => erro(404, "reserva inexistente"),
    }
}

async fn indisponivel<R: Repositorio>(
    repo: &R,
    empresa_id: &str,
    data: &str,
    horario: &str,
    pessoas: i64,
    ignorar_id: &str,
) -> Res<Json> {
    let d = disponibilidade(
        repo,
        empresa_id,
        data,
        horario,
        Some(pessoas),
        Some(ignorar_id),
    )
    .await?;
    Ok(json!({ "status": "indisponivel", "disponibilidade": d["ambientes"] }))
}

/// Campos que o corpo de um PATCH pode trazer (cada um pode estar ausente).
#[derive(Debug, Default, Clone)]
pub struct Mudancas {
    pub pessoas: Option<Json>,
    pub data: Option<Json>,
    pub horario: Option<Json>,
    pub mesa_id: Option<Json>,
    pub nome_cliente: Option<Json>,
    pub contato: Option<Json>,
}

/// `mudanca || atual` com a coerção de texto do JavaScript.
fn ou(v: Option<&Json>, atual: &str) -> String {
    crate::util::texto_ou_nada(v).unwrap_or_else(|| atual.to_string())
}

/// Edita pessoas, data, horário e/ou mesa. Sem `mesa_id`, mantém a mesa atual se ainda servir.
pub async fn editar_reserva<R: Repositorio>(
    repo: &R,
    empresa_id: &str,
    id: &str,
    m: &Mudancas,
) -> Res<Json> {
    let l = empresa(repo, empresa_id).await?;
    let r = achar(repo, empresa_id, id).await?;
    if r.status != "confirmada" {
        return erro(409, "reserva cancelada; reative antes de editar");
    }
    let pessoas = match &m.pessoas {
        None => Some(r.pessoas),
        p => inteiro(p.as_ref()),
    };
    let data = ou(m.data.as_ref(), &r.data);
    let horario = ou(m.horario.as_ref(), &r.horario);
    let mesa_id = ou(m.mesa_id.as_ref(), r.mesa_id.as_deref().unwrap_or(""));
    let Some(pessoas) = pessoas.filter(|p| *p >= 1) else {
        return erro(400, "pessoas inválido");
    };
    if !data_ok(&data) || !horario_ok(&horario) {
        return erro(400, "data ou horário inválido");
    }
    let confirmadas = repo
        .reserva_confirmadas(empresa_id, Some(r.id.as_str()))
        .await;
    let Some(alvo) = livres(&l, &confirmadas, &data, &horario, pessoas, None)?
        .into_iter()
        .find(|x| x.mesa.id == mesa_id)
    else {
        return indisponivel(repo, empresa_id, &data, &horario, pessoas, &r.id).await;
    };
    let ini = minutos_absolutos(&data, &horario)?;
    let (nome_cliente, contato) = validar_cliente(m.nome_cliente.as_ref(), m.contato.as_ref())?;
    let dados = Reserva {
        pessoas,
        data: data.clone(),
        horario: horario.clone(),
        mesa_id: Some(mesa_id),
        ambiente: alvo.ambiente,
        inicio: ini,
        fim: ini + DURACAO_MIN,
        ..r.clone()
    };
    match repo
        .reserva_editar(empresa_id, &r.id, dados, nome_cliente, contato)
        .await
    {
        Muda::Ok(nova) => Ok(json!({ "status": "atualizada", "reserva": publica(&nova) })),
        Muda::Conflito => indisponivel(repo, empresa_id, &data, &horario, pessoas, &r.id).await,
    }
}

pub async fn cancelar_reserva<R: Repositorio>(repo: &R, empresa_id: &str, id: &str) -> Res<Json> {
    achar(repo, empresa_id, id).await?;
    match repo.reserva_cancelar(empresa_id, id).await {
        Some(r) => Ok(json!({ "status": "cancelada", "reserva": publica(&r) })),
        None => Err(err(404, "reserva inexistente")),
    }
}

pub async fn reativar_reserva<R: Repositorio>(repo: &R, empresa_id: &str, id: &str) -> Res<Json> {
    let l = empresa(repo, empresa_id).await?;
    let r = achar(repo, empresa_id, id).await?;
    if r.status == "confirmada" {
        return Ok(json!({ "status": "confirmada", "reserva": publica(&r) }));
    }
    let confirmadas = repo
        .reserva_confirmadas(empresa_id, Some(r.id.as_str()))
        .await;
    let livre = livres(&l, &confirmadas, &r.data, &r.horario, r.pessoas, None)?
        .iter()
        .any(|x| Some(x.mesa.id.as_str()) == r.mesa_id.as_deref());
    if livre && let Muda::Ok(nova) = repo.reserva_reativar(empresa_id, id).await {
        return Ok(json!({ "status": "confirmada", "reserva": publica(&nova) }));
    }
    indisponivel(repo, empresa_id, &r.data, &r.horario, r.pessoas, &r.id).await
}
