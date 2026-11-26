//! Camada de permissões: o único lugar onde se decide QUEM pode fazer O QUÊ (espelha `src/permissoes.js`).
//!
//! Para liberar ou bloquear uma ação para uma camada, edite a lista da ação em `PERMISSOES`.
//! O núcleo só pergunta `pode_fazer(papel, "acao")`. Mudou aqui? Mude também `src/permissoes.js`
//! e rode `node tests/diferencial-usuarios.js`.
//!
//! Camadas: `equipe`, `admin`, `superadmin` (usuários com login), `cliente` (chave de acesso do painel),
//! `integracao` (equivale a superadmin) e `chat` (chave `k1_…` de uma empresa: não está em nenhuma lista).

const TODOS_DO_PAINEL: &[&str] = &["equipe", "admin", "superadmin", "cliente", "integracao"];
const DE_ADMIN_PARA_CIMA: &[&str] = &["admin", "superadmin", "cliente", "integracao"];
const SO_SUPERADMIN: &[&str] = &["superadmin", "integracao"];

pub const PERMISSOES: &[(&str, &[&str])] = &[
    ("painel.usar", TODOS_DO_PAINEL),
    ("historico.ver", DE_ADMIN_PARA_CIMA),
    ("historico.desfazer", DE_ADMIN_PARA_CIMA),
    (
        "historico.excluidas",
        &["superadmin", "integracao", "cliente"],
    ),
    ("empresa.criar", &["superadmin", "integracao", "cliente"]),
    ("empresa.excluir", DE_ADMIN_PARA_CIMA),
    ("api.gerir", SO_SUPERADMIN),
    ("usuarios.gerir", SO_SUPERADMIN),
    ("empresas.todas", SO_SUPERADMIN),
    ("configuracao.sem-senha", SO_SUPERADMIN),
];

/// `true` se a camada pode fazer a ação. Ação desconhecida é erro de programação (panic).
pub fn pode_fazer(papel: &str, acao: &str) -> bool {
    let Some((_, lista)) = PERMISSOES.iter().find(|(a, _)| *a == acao) else {
        panic!("ação de permissão desconhecida: {acao}");
    };
    lista.contains(&papel)
}

#[cfg(test)]
mod testes {
    use super::*;

    const PAPEIS: [&str; 6] = [
        "equipe",
        "admin",
        "superadmin",
        "cliente",
        "integracao",
        "chat",
    ];
    // 1 = pode; colunas na ordem de PAPEIS (mesma matriz de tests/permissoes.test.js).
    const MATRIZ: [(&str, [u8; 6]); 10] = [
        ("painel.usar", [1, 1, 1, 1, 1, 0]),
        ("historico.ver", [0, 1, 1, 1, 1, 0]),
        ("historico.desfazer", [0, 1, 1, 1, 1, 0]),
        ("historico.excluidas", [0, 0, 1, 1, 1, 0]),
        ("empresa.criar", [0, 0, 1, 1, 1, 0]),
        ("empresa.excluir", [0, 1, 1, 1, 1, 0]),
        ("api.gerir", [0, 0, 1, 0, 1, 0]),
        ("usuarios.gerir", [0, 0, 1, 0, 1, 0]),
        ("empresas.todas", [0, 0, 1, 0, 1, 0]),
        ("configuracao.sem-senha", [0, 0, 1, 0, 1, 0]),
    ];

    #[test]
    fn matriz_de_camadas_por_acao() {
        assert_eq!(PERMISSOES.len(), MATRIZ.len());
        for (acao, colunas) in MATRIZ {
            for (i, papel) in PAPEIS.iter().enumerate() {
                assert_eq!(
                    pode_fazer(papel, acao),
                    colunas[i] == 1,
                    "{acao} para {papel}"
                );
            }
        }
    }
}
