// @ts-check
/**
 * Marcadores de dono: `{v, pid, start, boot, createdAt}` onde `start` é o
 * campo 22 (starttime, em ticks desde o boot) de `/proc/<pid>/stat` e `boot`
 * é `/proc/sys/kernel/random/boot_id`. O trio distingue um processo vivo de
 * um pid reaproveitado ou de um boot anterior. Fora do Linux (sem /proc)
 * cai para `process.kill(pid, 0)`.
 * @module dsh-session-scratch/owner
 */

import fs from 'node:fs';

/**
 * @typedef {object} Identity
 * @property {number} pid
 * @property {string|null} start starttime do /proc (string para não perder precisão)
 * @property {string|null} boot boot_id do kernel
 *
 * @typedef {Identity & { v: 1, createdAt: number }} OwnerMarker
 *
 * @typedef {object} ProcReader
 * @property {(pid: number|'self') => string|null} stat conteúdo de /proc/<pid>/stat, ou null se não existir
 * @property {() => string|null} bootId boot_id, ou null sem /proc
 * @property {(pid: number) => boolean|null} signalZero `kill(pid, 0)`: true vivo, false morto, null indeterminado
 */

/** Leitor real do /proc. @type {ProcReader} */
export const realProc = {
  stat(pid) {
    try {
      return fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
      return null;
    }
  },
  bootId() {
    try {
      return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
    } catch {
      return null;
    }
  },
  signalZero(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (code === 'ESRCH') return false;
      if (code === 'EPERM') return true;
      return null;
    }
  },
};

/**
 * Extrai o starttime (campo 22) de uma linha de /proc/<pid>/stat. O campo 2
 * (comm) vem entre parênteses e pode conter espaços e parênteses, então o
 * parse começa depois do ÚLTIMO `)`.
 * @param {string|null} statLine
 * @returns {string|null}
 */
export function parseStartTime(statLine) {
  if (typeof statLine !== 'string') return null;
  const close = statLine.lastIndexOf(')');
  if (close < 0) return null;
  const rest = statLine.slice(close + 1).trim().split(/\s+/);
  // rest[0] é o campo 3 (state); o campo 22 é rest[19].
  const start = rest[19];
  return start !== undefined && /^\d+$/.test(start) ? start : null;
}

/**
 * Identidade deste processo.
 * @param {ProcReader} [proc]
 * @param {number} [pid]
 * @returns {Identity}
 */
export function selfIdentity(proc = realProc, pid = process.pid) {
  return { pid, start: parseStartTime(proc.stat('self')), boot: proc.bootId() };
}

/**
 * Valida e normaliza um marcador lido do disco.
 * @param {unknown} value
 * @returns {OwnerMarker|null}
 */
export function parseMarker(value) {
  if (value === null || typeof value !== 'object') return null;
  const m = /** @type {Record<string, unknown>} */ (value);
  if (m.v !== 1 || !Number.isSafeInteger(m.pid) || /** @type {number} */ (m.pid) <= 0) return null;
  const start = typeof m.start === 'string' ? m.start : null;
  const boot = typeof m.boot === 'string' ? m.boot : null;
  const createdAt = typeof m.createdAt === 'number' && Number.isFinite(m.createdAt) ? m.createdAt : 0;
  return { v: 1, pid: /** @type {number} */ (m.pid), start, boot, createdAt };
}

/**
 * `true` quando o marcador é exatamente deste processo.
 * @param {Identity|null} marker
 * @param {Identity} self
 */
export function isSelf(marker, self) {
  return marker !== null && marker.pid === self.pid && marker.start === self.start && marker.boot === self.boot;
}

/**
 * Situação do dono de um marcador.
 * - `self`: este processo;
 * - `alive`: outro processo vivo com o mesmo boot e o mesmo starttime;
 * - `dead`: boot diferente, pid inexistente ou pid reaproveitado;
 * - `unknown`: sem /proc e sem como provar (tratado como vivo pelo sweeper).
 * @param {Identity} marker
 * @param {Identity} self
 * @param {ProcReader} [proc]
 * @returns {'self'|'alive'|'dead'|'unknown'}
 */
export function ownerState(marker, self, proc = realProc) {
  if (isSelf(marker, self)) return 'self';
  if (marker.boot !== null && self.boot !== null && marker.boot !== self.boot) return 'dead';
  if (marker.start !== null && self.boot !== null) {
    const now = parseStartTime(proc.stat(marker.pid));
    if (now === null) return 'dead';
    return now === marker.start ? 'alive' : 'dead';
  }
  const alive = proc.signalZero(marker.pid);
  if (alive === null) return 'unknown';
  return alive ? 'alive' : 'dead';
}

/**
 * Marcador novo para este processo.
 * @param {Identity} self
 * @param {number} now
 * @returns {OwnerMarker}
 */
export function newMarker(self, now) {
  return { v: 1, pid: self.pid, start: self.start, boot: self.boot, createdAt: now };
}
