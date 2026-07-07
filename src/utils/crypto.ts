// Hash de senha usando Web Crypto API (PBKDF2) — compatível com Cloudflare Workers
// Formato de armazenamento: pbkdf2$<iterações>$<salt-base64>$<hash-base64>

const ITERATIONS = 100_000
const KEY_LENGTH = 32 // bytes

function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function base64ToBuf(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  )
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    keyMaterial,
    KEY_LENGTH * 8
  )
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const derived = await deriveKey(password, salt, ITERATIONS)
  return `pbkdf2$${ITERATIONS}$${bufToBase64(salt.buffer as ArrayBuffer)}$${bufToBase64(derived)}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false
  const iterations = parseInt(parts[1], 10)
  const salt = base64ToBuf(parts[2])
  const expectedHash = parts[3]
  const derived = await deriveKey(password, salt, iterations)
  const actualHash = bufToBase64(derived)
  // comparação em tempo constante simplificada
  if (actualHash.length !== expectedHash.length) return false
  let diff = 0
  for (let i = 0; i < actualHash.length; i++) {
    diff |= actualHash.charCodeAt(i) ^ expectedHash.charCodeAt(i)
  }
  return diff === 0
}

export function generateRandomKey(prefix = ''): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
  return prefix ? `${prefix}-${hex}` : hex
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
}
