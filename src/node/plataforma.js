// Plataforma do Node: implementa a interface de src/plataforma.js com node:crypto e Buffer.
import crypto from 'node:crypto';
import { validarPlataforma } from '../plataforma.js';

export function plataformaNode() {
  return validarPlataforma({
    agora: () => Date.now(),
    uuid: () => crypto.randomUUID(),
    aleatorio: (bytes) => crypto.randomBytes(bytes).toString('base64url'),
    async sha256Hex(texto) { return crypto.createHash('sha256').update(String(texto)).digest('hex'); },
    iguaisTempoConstante(a, b) {
      const x = Buffer.from(String(a)), y = Buffer.from(String(b));
      return x.length === y.length && crypto.timingSafeEqual(x, y);
    },
    base64Decodificar(texto) {
      const limpo = String(texto).replace(/\s+/g, '').replace(/=+$/, '');
      if (!/^[A-Za-z0-9+/]*$/.test(limpo) || limpo.length % 4 === 1) throw new Error('base64 inválido');
      return new Uint8Array(Buffer.from(limpo, 'base64'));
    },
    base64Codificar: (bytes) => Buffer.from(bytes).toString('base64'),
  });
}
