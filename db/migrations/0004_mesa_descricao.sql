-- Descrição do local de cada mesa (uma linha, até 150 caracteres; vazio = sem descrição).
ALTER TABLE mesas ADD COLUMN descricao TEXT NOT NULL DEFAULT '';
