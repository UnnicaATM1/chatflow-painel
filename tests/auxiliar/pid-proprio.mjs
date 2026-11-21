// Pré-carga só para testes: grava, antes de o servidor abrir o banco, um .pid velho contendo o PID do PRÓPRIO processo.
// Reproduz o contêiner reiniciado depois de uma queda: o Node volta com o mesmo PID de antes (PID 1 sem init).
import { writeFileSync } from 'node:fs';
const valor = process.env.TESTE_PID_VELHO === 'proprio' ? process.pid : process.env.TESTE_PID_VELHO;
if (valor && process.env.CHATFLOW_BANCO_ARQUIVO) writeFileSync(`${process.env.CHATFLOW_BANCO_ARQUIVO}.pid`, `${valor}\n`);
