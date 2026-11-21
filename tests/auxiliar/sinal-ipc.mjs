// Pré-carga só para testes de operação (node --import): deixa o processo pai disparar os manipuladores de sinal
// registrados com process.on. No Windows, child.kill('SIGTERM') encerra o processo à força, sem rodar nenhum manipulador,
// então a única forma de exercitar o desligamento limpo ali é emitir o evento dentro do filho.
process.on('message', (m) => {
  if (m === 'SIGTERM' || m === 'SIGINT' || m === 'SIGBREAK') process.emit(m, m);
});
