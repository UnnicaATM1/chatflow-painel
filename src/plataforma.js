// Plataforma: tudo o que o núcleo precisa do ambiente (relógio, aleatório, hash, base64).
// O núcleo NUNCA importa node:*, Buffer nem process; ele recebe um objeto com esta interface:
//
//   agora()                      -> ms desde 1970 (relógio injetável, serve aos testes)
//   uuid()                       -> string única
//   aleatorio(bytes)             -> string base64url com `bytes` bytes aleatórios
//   sha256Hex(texto)             -> Promise<string hex de 64 caracteres>
//   iguaisTempoConstante(a, b)   -> boolean (compara strings sem sair cedo no primeiro byte diferente)
//   base64Decodificar(texto)     -> Uint8Array (lança Error se o texto não for base64)
//   base64Codificar(bytes)       -> string base64 (com padding)
//
// `plataformaWeb()` usa só Web API (crypto.subtle, atob/btoa, TextEncoder): roda em Node 20+, Worker e navegador.
// O Node tem a sua em src/node/plataforma.js (node:crypto, Buffer).

const METODOS = ['agora', 'uuid', 'aleatorio', 'sha256Hex', 'iguaisTempoConstante', 'base64Decodificar', 'base64Codificar'];

export function validarPlataforma(p) {
  for (const m of METODOS) if (!p || typeof p[m] !== 'function') throw new Error(`plataforma sem o método ${m}`);
  return p;
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const ALFABETO_RESERVA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const FORMATO_RESERVA = new RegExp(`^[${ALFABETO_RESERVA}]{8}$`);

export function codigoReservaValido(codigo) {
  return typeof codigo === 'string' && codigo.length === 8 && FORMATO_RESERVA.test(codigo);
}

export function gerarCodigoReserva(plat, emUso) {
  const limite = 256 - 256 % ALFABETO_RESERVA.length;
  let codigo = '';
  for (let i = 0; i < 128; i++) {
    const base64 = plat.aleatorio(8).replace(/-/g, '+').replace(/_/g, '/');
    for (const byte of plat.base64Decodificar(base64)) {
      if (byte >= limite) continue; // amostragem sem viés
      codigo += ALFABETO_RESERVA[byte % ALFABETO_RESERVA.length];
      if (codigo.length === 8) {
        if (!emUso(codigo)) return codigo;
        codigo = '';
      }
    }
  }
  throw new Error('não foi possível gerar um código de reserva único');
}

// Comparação em tempo constante sobre os caracteres (strings de mesmo tamanho; tamanhos diferentes dão false).
export function iguaisTempoConstante(a, b) {
  const x = String(a), y = String(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

export function base64Codificar(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); // em blocos: 4 MB estouraria a pilha
  return btoa(bin);
}

export function base64Decodificar(texto) {
  const limpo = String(texto).replace(/\s+/g, '').replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(limpo) || limpo.length % 4 === 1) throw new Error('base64 inválido');
  const bin = atob(limpo);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function plataformaWeb() {
  return validarPlataforma({
    agora: () => Date.now(),
    uuid: () => globalThis.crypto.randomUUID(),
    aleatorio(bytes) {
      const b = globalThis.crypto.getRandomValues(new Uint8Array(bytes));
      return base64Codificar(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },
    async sha256Hex(texto) {
      return hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(texto)))));
    },
    iguaisTempoConstante,
    base64Decodificar,
    base64Codificar,
  });
}
