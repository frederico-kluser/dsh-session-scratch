// @ts-check
/**
 * Ids e caminhos: sanitização do id da sessão, chave da sessão raiz para
 * cadeias de subagentes e a verificação de confiança da base.
 * @module dsh-session-scratch/paths
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Um id válido DEPOIS de sanitizado (mesmo contrato da skill). */
export const ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Tamanho máximo de uma chave (nome de pasta). */
export const MAX_KEY_LENGTH = 200;

/** Raiz comum a todos os harnesses; nada fora dela é apagado. */
export const SCRATCH_ROOT_NAME = 'agent-scratch';

/**
 * `true` quando `key` pode ser nome de pasta de sessão: casa {@link ID_PATTERN},
 * não é `.`/`..`, não começa com `.` (reservado a `.owners`/`.trash-*`) e
 * respeita o tamanho máximo.
 * @param {unknown} key
 * @returns {key is string}
 */
export function isValidKey(key) {
  return typeof key === 'string'
    && key.length > 0
    && key.length <= MAX_KEY_LENGTH
    && ID_PATTERN.test(key)
    && key !== '.'
    && key !== '..'
    && !key.startsWith('.');
}

/**
 * Sanitiza um id de sessão para nome de pasta. Injetiva: `[A-Za-z0-9.-]`
 * passa, `_` vira `__`, qualquer outro byte UTF-8 vira `_xx` (hex); um `.`
 * inicial vira `_2e`. Ids longos são truncados com sufixo de hash. Lança se o
 * resultado não for uma chave válida.
 * @param {unknown} id
 * @returns {string}
 */
export function sanitizeId(id) {
  if (typeof id !== 'string' || id.length === 0) throw new TypeError(`id de sessão inválido: ${JSON.stringify(id)}`);
  let out = '';
  for (const byte of Buffer.from(id, 'utf8')) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9.-]/.test(ch)) out += ch;
    else if (ch === '_') out += '__';
    else out += `_${byte.toString(16).padStart(2, '0')}`;
  }
  if (out.startsWith('.')) out = `_2e${out.slice(1)}`;
  if (out.length > MAX_KEY_LENGTH) {
    const digest = createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 16);
    out = `${out.slice(0, MAX_KEY_LENGTH - 17)}-${digest}`;
  }
  if (!isValidKey(out)) throw new TypeError(`id de sessão inválido depois de sanitizado: ${JSON.stringify(id)}`);
  return out;
}

/**
 * @typedef {object} HeaderLike
 * @property {string} id
 * @property {string} [parentSession]
 * @property {string} [origin]
 */

/**
 * Chave (sanitizada) da pasta usada por uma sessão. Com `share` ligado, um
 * subagente (`origin === 'subagent'`) sobe a cadeia `parentSession` até a
 * sessão raiz; forks da Web UI (parentSession sem origin) têm pasta própria.
 * @param {HeaderLike} header cabeçalho da sessão do agente
 * @param {object} [options]
 * @param {boolean} [options.share] compartilhar com subagentes (default true)
 * @param {(id: string) => HeaderLike | undefined} [options.lookup] cabeçalho de uma sessão viva pelo id
 * @param {Map<string, string>} [options.cache] id de sessão → chave raiz já conhecida
 * @returns {string}
 */
export function rootSessionKey(header, options = {}) {
  const share = options.share ?? true;
  let current = header;
  for (let depth = 0; share && depth < 64; depth += 1) {
    const parent = current.parentSession;
    if (current.origin !== 'subagent' || typeof parent !== 'string' || parent.length === 0) break;
    const cached = options.cache?.get(parent);
    if (cached !== undefined) return cached;
    const next = options.lookup?.(parent);
    if (next === undefined) return sanitizeId(parent);
    current = next;
  }
  return sanitizeId(current.id);
}

/**
 * O TMPDIR do processo do DSH como ele é (os.tmpdir(), absoluto). É o valor
 * que o bash herda; o hook BASH_ENV o usa para distinguir "default herdado"
 * de "override explícito".
 * @param {string} [tmp] os.tmpdir() (injetável nos testes)
 * @returns {string}
 */
export function processTmpdir(tmp = os.tmpdir()) {
  return path.resolve(tmp);
}

/**
 * Raiz do host para temporários, SEM aninhar: o TMPDIR do processo do DSH,
 * mas se ele já for uma pasta de scratch herdada de uma sessão-mãe
 * (`…/agent-scratch/<harness>[/<id>/…]`, ex.: `dsh` lançado de dentro do bash
 * de um agente) sobe até o host-tmp. Mesma regra do `host_tmp()` da skill:
 * corta no primeiro segmento `agent-scratch` que tem filho.
 * @param {string} [tmp] os.tmpdir() (injetável nos testes)
 * @returns {string}
 */
export function hostTmpdir(tmp = os.tmpdir()) {
  const resolved = path.resolve(tmp);
  const parts = resolved.split('/');
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i] === SCRATCH_ROOT_NAME && i + 1 < parts.length) return parts.slice(0, i).join('/') || '/';
  }
  return resolved;
}

/**
 * `true` quando `target` está ESTRITAMENTE dentro de `root`.
 * @param {string} root
 * @param {string} target
 */
export function isStrictlyInside(root, target) {
  const rel = path.relative(root, target);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Lança se `st` não for um diretório REAL (lstat: symlink conta como não) do
 * `uid` (uid < 0 = não confere).
 * @param {string} dir
 * @param {fs.Stats|undefined} st resultado de lstat (undefined = ausente)
 * @param {number} uid
 * @returns {fs.Stats}
 */
export function assertTrustedStat(dir, st, uid) {
  if (st === undefined) {
    const error = /** @type {NodeJS.ErrnoException} */ (new Error(`dsh-session-scratch: ${dir} não existe`));
    error.code = 'ENOENT';
    throw error;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`dsh-session-scratch: ${dir} não é um diretório real (symlink ou arquivo)`);
  if (uid >= 0 && st.uid !== uid) throw new Error(`dsh-session-scratch: ${dir} pertence ao uid ${st.uid}, não a ${uid}`);
  return st;
}

/**
 * Garante uma pasta confiável: cria com 0700 se faltar, recusa symlink,
 * recusa dono diferente do euid e corrige permissões de grupo/outros.
 * @param {string} dir
 * @param {{ uid?: number }} [options]
 * @returns {{ st: fs.Stats, created: boolean }}
 */
export function ensureTrustedDir(dir, options = {}) {
  const uid = options.uid ?? process.getuid?.() ?? -1;
  let created = false;
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
  }
  const st = assertTrustedStat(dir, fs.lstatSync(dir, { throwIfNoEntry: false }), uid);
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  return { st, created };
}

/**
 * Cria e valida `<host-tmp>/agent-scratch/…/<baseDir>` componente a
 * componente (cada um 0700, do usuário, sem symlink).
 * @param {string} tmpRoot os.tmpdir() do host
 * @param {string} baseDir relativo, já validado (começa com agent-scratch/)
 * @returns {{ scratchRoot: string, base: string }}
 */
export function ensureBase(tmpRoot, baseDir) {
  const segments = baseDir.split('/');
  let current = tmpRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    ensureTrustedDir(current);
  }
  return { scratchRoot: path.join(tmpRoot, SCRATCH_ROOT_NAME), base: current };
}
