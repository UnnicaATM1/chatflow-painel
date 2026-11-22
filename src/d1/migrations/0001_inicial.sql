CREATE TABLE IF NOT EXISTS empresas (
  id TEXT NOT NULL PRIMARY KEY,
  nome TEXT NOT NULL COLLATE NOCASE UNIQUE,
  -- O repositório preenche a forma em minúsculas Unicode. NOCASE cobre inserções SQL em ASCII.
  nome_normalizado TEXT UNIQUE,
  agente TEXT NOT NULL,
  modulos TEXT NOT NULL,
  chave TEXT,
  chave_hash TEXT GENERATED ALWAYS AS (json_extract(chave, '$.hash')) VIRTUAL,
  prox_conhecimento INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS empresas_por_chave_hash ON empresas (chave_hash);

CREATE TABLE IF NOT EXISTS ambientes (
  id INTEGER PRIMARY KEY,
  empresa_id TEXT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  nome_normalizado TEXT NOT NULL,
  UNIQUE (empresa_id, nome_normalizado),
  UNIQUE (empresa_id, id)
);

CREATE TABLE IF NOT EXISTS mesas (
  ordem INTEGER PRIMARY KEY,
  empresa_id TEXT NOT NULL,
  ambiente_id INTEGER NOT NULL,
  mesa_id TEXT NOT NULL,
  capacidade INTEGER NOT NULL,
  reservavel INTEGER NOT NULL,
  UNIQUE (empresa_id, mesa_id),
  FOREIGN KEY (empresa_id, ambiente_id) REFERENCES ambientes(empresa_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS mesas_por_ambiente ON mesas (empresa_id, ambiente_id, ordem);

CREATE TABLE IF NOT EXISTS reservas (
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
CREATE INDEX IF NOT EXISTS reservas_por_empresa ON reservas (empresa_id);
CREATE INDEX IF NOT EXISTS reservas_ocupacao ON reservas (empresa_id, mesa_id, inicio, fim)
  WHERE status = 'confirmada';

CREATE TRIGGER IF NOT EXISTS reservas_sem_sobreposicao_insert BEFORE INSERT ON reservas
WHEN NEW.status = 'confirmada' AND NEW.mesa_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM reservas
  WHERE empresa_id = NEW.empresa_id AND mesa_id = NEW.mesa_id AND status = 'confirmada'
    AND NEW.inicio < fim AND NEW.fim > inicio
)
BEGIN
  SELECT RAISE(ABORT, 'sobreposicao de reservas');
END;

CREATE TRIGGER IF NOT EXISTS reservas_sem_sobreposicao_update
BEFORE UPDATE OF status, mesa_id, inicio, fim, empresa_id ON reservas
WHEN NEW.status = 'confirmada' AND NEW.mesa_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM reservas
  WHERE empresa_id = NEW.empresa_id AND mesa_id = NEW.mesa_id AND status = 'confirmada'
    AND id <> OLD.id AND NEW.inicio < fim AND NEW.fim > inicio
)
BEGIN
  SELECT RAISE(ABORT, 'sobreposicao de reservas');
END;

-- Registro dos códigos já emitidos. Sobrevive à exclusão de reservas e empresas.
CREATE TABLE IF NOT EXISTS reservas_codigos (
  empresa_id TEXT NOT NULL,
  codigo TEXT NOT NULL,
  PRIMARY KEY (empresa_id, codigo)
);

CREATE TRIGGER IF NOT EXISTS reservas_registrar_codigo AFTER INSERT ON reservas
BEGIN
  SELECT RAISE(ABORT, 'codigo de reserva ja emitido')
    WHERE EXISTS (SELECT 1 FROM reservas_codigos WHERE empresa_id = NEW.empresa_id AND codigo = NEW.codigo);
  INSERT INTO reservas_codigos (empresa_id, codigo) VALUES (NEW.empresa_id, NEW.codigo);
END;

CREATE TRIGGER IF NOT EXISTS reservas_codigo_em_mudanca_de_empresa AFTER UPDATE OF empresa_id, codigo ON reservas
WHEN NEW.empresa_id <> OLD.empresa_id OR NEW.codigo <> OLD.codigo
BEGIN
  SELECT RAISE(ABORT, 'codigo de reserva ja emitido')
    WHERE EXISTS (SELECT 1 FROM reservas_codigos WHERE empresa_id = NEW.empresa_id AND codigo = NEW.codigo);
  INSERT INTO reservas_codigos (empresa_id, codigo) VALUES (NEW.empresa_id, NEW.codigo);
END;

CREATE TABLE IF NOT EXISTS idempotencia (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id TEXT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  chave TEXT NOT NULL,
  resposta TEXT NOT NULL,
  criada_em INTEGER NOT NULL,
  UNIQUE (empresa_id, chave)
);
CREATE INDEX IF NOT EXISTS idempotencia_por_empresa ON idempotencia (empresa_id, criada_em, id);

CREATE TABLE IF NOT EXISTS conhecimento (
  empresa_id TEXT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  id INTEGER NOT NULL,
  item TEXT NOT NULL CHECK (json_type(item, '$.arquivo.base64') IS NULL),
  PRIMARY KEY (empresa_id, id)
);

CREATE TABLE IF NOT EXISTS historico (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id TEXT NOT NULL,
  entidade TEXT NOT NULL,
  entidade_id TEXT,
  acao TEXT NOT NULL,
  ref_seq INTEGER,
  evento TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS historico_por_empresa ON historico (empresa_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS historico_desfeito_uma_vez ON historico (empresa_id, ref_seq)
  WHERE acao = 'desfeita';

CREATE TRIGGER IF NOT EXISTS historico_sem_update BEFORE UPDATE ON historico
BEGIN
  SELECT RAISE(ABORT, 'historico aceita apenas novos eventos');
END;

CREATE TRIGGER IF NOT EXISTS historico_sem_delete BEFORE DELETE ON historico
BEGIN
  SELECT RAISE(ABORT, 'historico aceita apenas novos eventos');
END;

-- Protege também contra INSERT OR REPLACE com recursive_triggers desativado.
CREATE TRIGGER IF NOT EXISTS historico_sem_replace BEFORE INSERT ON historico
WHEN EXISTS (
  SELECT 1 FROM historico
  WHERE seq = NEW.seq OR (
    NEW.acao = 'desfeita' AND acao = 'desfeita'
    AND empresa_id = NEW.empresa_id AND ref_seq = NEW.ref_seq
  )
)
BEGIN
  SELECT RAISE(ABORT, 'historico aceita apenas novos eventos');
END;

CREATE TABLE IF NOT EXISTS tentativas_admin (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  n INTEGER NOT NULL,
  ate INTEGER NOT NULL
);
