# SDD reservas  (score estimado 85)
Entrada: {loja_id, data, horario, pessoas, ambiente?, chave}. Regras: mesa do ambiente (ou qualquer) com capacidade >= pessoas, reservável, sem sobreposição (90 min). Resultado: {status: confirmada, mesa} | {status: indisponivel, alternativas[]}. Mesma chave devolve a mesma reserva. Validação: pessoas>=1, loja existente.
