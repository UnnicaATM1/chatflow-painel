// Usuários: senha (PBKDF2-SHA256 por Web Crypto), validações e papéis. Só JS padrão e Web API:
// roda no Node, no Worker e no navegador. Nenhuma senha, hash ou token é registrado em log.

export const PAPEIS_USUARIO = ['equipe', 'admin', 'superadmin'];
export const ITERACOES_PBKDF2 = 100000; // teto do Workers
export const SENHA_MINIMA = 10;
export const SENHA_MAXIMA = 200;

const codificador = new TextEncoder();
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
function deHex(texto) {
  if (typeof texto !== 'string' || texto.length % 2 || !/^[0-9a-f]*$/.test(texto)) throw new Error('hex inválido');
  const saida = new Uint8Array(texto.length / 2);
  for (let i = 0; i < saida.length; i++) saida[i] = parseInt(texto.slice(i * 2, i * 2 + 2), 16);
  return saida;
}

// Deriva a chave de `senha` com o sal (hex). Devolve hex de 32 bytes.
export async function derivarSenha(senha, saltHex, iteracoes = ITERACOES_PBKDF2) {
  const base = await crypto.subtle.importKey('raw', codificador.encode(String(senha)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: deHex(saltHex), iterations: iteracoes }, base, 256);
  return hex(new Uint8Array(bits));
}

// { senhaHash, salt, iteracoes } prontos para guardar. `sal` opcional (hex) serve aos testes.
export async function criarCredencial(senha, sal) {
  const salt = sal || hex(crypto.getRandomValues(new Uint8Array(16)));
  return { senhaHash: await derivarSenha(senha, salt), salt, iteracoes: ITERACOES_PBKDF2 };
}

// Compara em tempo constante. `igual(a, b)` vem da plataforma.
export async function conferirSenha(senha, usuario, igual) {
  if (typeof senha !== 'string' || !usuario) return false;
  const h = await derivarSenha(senha, usuario.salt, usuario.iteracoes);
  return igual(h, usuario.senhaHash);
}

export function normalizarEmail(e) { return String(e ?? '').trim().toLowerCase(); }
export const emailValido = (e) => e.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// Devolve a mensagem de erro ou null.
export function validarSenhaNova(s) {
  if (typeof s !== 'string' || s.length < SENHA_MINIMA) return `a senha precisa ter pelo menos ${SENHA_MINIMA} caracteres`;
  if (s.length > SENHA_MAXIMA) return `a senha pode ter no máximo ${SENHA_MAXIMA} caracteres`;
  return null;
}

// Valida o corpo de criação; devolve { erro } ou { nome, email, papel, empresas }.
export function validarNovoUsuario(b) {
  if (!b || typeof b !== 'object') return { erro: 'corpo inválido' };
  const nome = typeof b.nome === 'string' ? b.nome.trim() : '';
  if (!nome || nome.length > 80) return { erro: 'nome de 1 a 80 caracteres' };
  const email = normalizarEmail(b.email);
  if (!emailValido(email)) return { erro: 'e-mail inválido' };
  if (!PAPEIS_USUARIO.includes(b.papel)) return { erro: 'papel deve ser equipe, admin ou superadmin' };
  const erroSenha = validarSenhaNova(b.senha);
  if (erroSenha) return { erro: erroSenha };
  const empresas = b.empresas === undefined ? [] : b.empresas;
  if (!Array.isArray(empresas) || empresas.some((x) => typeof x !== 'string')) return { erro: 'empresas deve ser uma lista de ids' };
  return { nome, email, papel: b.papel, empresas: [...new Set(empresas)] };
}

// Papéis de sessão: equipe < admin < superadmin. Os tokens do env mapeiam: cliente = equipe de emergência, integracao = superadmin.
export const ehSuperadmin = (papel) => papel === 'superadmin' || papel === 'integracao';
export const ehAdmin = (papel) => papel === 'admin' || ehSuperadmin(papel);
