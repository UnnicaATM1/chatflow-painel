# Button

Botão de ação. O primário ciano é a ação que move o fluxo (Iniciar, Concluir, Encerrar, + Nova tarefa); o secundário com contorno é tudo que edita ou descarta.

- Um primário por cartão ou linha, sempre o primeiro da esquerda para a direita.
- `neutral` (cinza) é o Iniciar das listas de tarefa, onde o ciano fica reservado para Concluir.
- `dark` é o botão navy usado como filtro ou segmento ativo isolado.
- O app usa texto branco no ciano, que reprova contraste. Passe `accessible` para trocar por `navy-950` até a decisão final.
- Rótulos em verbo no infinitivo, sem ponto: Iniciar, Concluir, Arquivar.
