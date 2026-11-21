-- reservas.mesa_id passa a aceitar NULL: remover uma mesa desliga as reservas canceladas ou passadas dela
-- (o histórico guarda o mesa_id antigo). Preserva todas as linhas; o código público continua em reservas_codigos.
CREATE TABLE reservas_nova (
  id TEXT NOT NULL PRIMARY KEY,
  empresa_id TEXT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  codigo TEXT NOT NULL CHECK (length(codigo) = 8 AND codigo NOT GLOB '*[^23456789ABCDEFGHJKMNPQRSTUVWXYZ]*'),
  mesa_id TEXT,
  ambiente TEXT NOT NULL,
  data TEXT NOT NULL,
  horario TEXT NOT NULL,
  pessoas INTEGER NOT NULL,
  inicio INTEGER NOT NULL,
  fim INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('confirmada', 'cancelada')),
  nome_cliente TEXT,
  contato TEXT,
  UNIQUE (empresa_id, codigo)
);
INSERT INTO reservas_nova (id, empresa_id, codigo, mesa_id, ambiente, data, horario, pessoas, inicio, fim, status, nome_cliente, contato)
  SELECT id, empresa_id, codigo, mesa_id, ambiente, data, horario, pessoas, inicio, fim, status, nome_cliente, contato FROM reservas;
DROP TABLE reservas;
ALTER TABLE reservas_nova RENAME TO reservas;

CREATE INDEX reservas_por_empresa ON reservas (empresa_id);
CREATE INDEX reservas_ocupacao ON reservas (empresa_id, mesa_id, inicio, fim)
  WHERE status = 'confirmada';

CREATE TRIGGER reservas_sem_sobreposicao_insert BEFORE INSERT ON reservas
WHEN NEW.status = 'confirmada' AND NEW.mesa_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM reservas
  WHERE empresa_id = NEW.empresa_id AND mesa_id = NEW.mesa_id AND status = 'confirmada'
    AND NEW.inicio < fim AND NEW.fim > inicio
)
BEGIN
  SELECT RAISE(ABORT, 'sobreposicao de reservas');
END;

CREATE TRIGGER reservas_sem_sobreposicao_update
BEFORE UPDATE OF status, mesa_id, inicio, fim, empresa_id ON reservas
WHEN NEW.status = 'confirmada' AND NEW.mesa_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM reservas
  WHERE empresa_id = NEW.empresa_id AND mesa_id = NEW.mesa_id AND status = 'confirmada'
    AND id <> OLD.id AND NEW.inicio < fim AND NEW.fim > inicio
)
BEGIN
  SELECT RAISE(ABORT, 'sobreposicao de reservas');
END;

CREATE TRIGGER reservas_registrar_codigo AFTER INSERT ON reservas
BEGIN
  SELECT RAISE(ABORT, 'codigo de reserva ja emitido')
    WHERE EXISTS (SELECT 1 FROM reservas_codigos WHERE empresa_id = NEW.empresa_id AND codigo = NEW.codigo);
  INSERT INTO reservas_codigos (empresa_id, codigo) VALUES (NEW.empresa_id, NEW.codigo);
END;

CREATE TRIGGER reservas_codigo_em_mudanca_de_empresa AFTER UPDATE OF empresa_id, codigo ON reservas
WHEN NEW.empresa_id <> OLD.empresa_id OR NEW.codigo <> OLD.codigo
BEGIN
  SELECT RAISE(ABORT, 'codigo de reserva ja emitido')
    WHERE EXISTS (SELECT 1 FROM reservas_codigos WHERE empresa_id = NEW.empresa_id AND codigo = NEW.codigo);
  INSERT INTO reservas_codigos (empresa_id, codigo) VALUES (NEW.empresa_id, NEW.codigo);
END;
