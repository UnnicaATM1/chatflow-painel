# Onboarding 002 (testar pela primeira vez)

1. Entre no painel com a chave de integração (acesso de emergência) e abra a aba Usuários.
2. Crie dois usuários da mesma empresa (equipe) e um admin, cada um com senha provisória de 10 ou mais caracteres.
3. Saia, entre com cada um pelo e-mail e senha, e troque a senha no primeiro acesso.
4. Como equipe: confira que não aparecem API nem Histórico, e que Configuração pede a senha de novo.
5. Faça uma alteração com cada usuário e confira no Histórico (admin ou superadmin) o nome real de cada um.
6. Desative um usuário e confirme que a sessão dele cai na próxima ação.
7. Rode `CHATFLOW_TESTE_OPERACAO=1 npm test` e a régua contra o binário Rust.
