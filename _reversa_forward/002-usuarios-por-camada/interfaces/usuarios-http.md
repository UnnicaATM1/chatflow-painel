# Contrato F: HTTP de usuários (JS e Rust, mesma ordem de chaves)

- `POST /login {email, senha}`: 200 `{token, usuario:{id,nome,email,papel,empresas}}`; 401 `{erro:"e-mail ou senha inválidos"}` sempre igual; 429 após falhas (por IP e por e-mail).
- `POST /logout`: 200 `{ok:true}`. `GET /eu`: 200 `{id,nome,email,papel,empresas,reautenticadoEm}`.
- `POST /eu/senha {atual, nova}`: 200 `{ok:true}` e derruba as outras sessões; 403 senha atual errada; 400 nova com menos de 10 caracteres.
- `POST /eu/reautenticar {senha}`: 200 `{ok:true}` ou 403.
- Só superadmin: `GET /usuarios`; `POST /usuarios {nome,email,papel,senha,empresas}` (201; 409 e-mail repetido); `PATCH /usuarios/:id {nome?,papel?,ativo?,empresas?}` (409 se tirar o último superadmin ativo); `POST /usuarios/:id/senha {senha}` (redefinição).
- Autorização: 403 `{erro:"sem permissão"}` por camada; 403 `{erro:"empresa não liberada"}` fora das empresas do usuário. Token de sessão no cabeçalho `Authorization: Bearer`. Sem `Idempotency-Key`; timeouts como no restante da API.
