# Investigação 002

- Hash de senha: PBKDF2 (Web Crypto, nativo no Worker e no Node) escolhido; scrypt e Argon2 exigem biblioteca ou WASM e foram descartados no Worker. Teto de 100000 iterações no Workers.
- Sessão: JWT assinado não permite revogação imediata (descartado); token opaco com hash em tabela é revogável (escolhido).
- Login: e-mail em vez de nome de usuário (único, simples de validar), premissa do requirements.
- Rust: `pbkdf2` e `sha2` (RustCrypto) com os mesmos parâmetros; o teste diferencial reaproveita `tests/diferencial-rust.js`.
- Padrões: OWASP ASVS (armazenamento de senha, resposta de login genérica, limite de tentativas, sessão com expiração).
