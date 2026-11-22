CREATE TABLE chatflow_revisao (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revisao INTEGER NOT NULL CONSTRAINT chatflow_revisao_conflito CHECK (revisao > 0)
);
