// @ts-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Raiz temporária isolada (respeita TMPDIR; nunca /tmp literal).
 * @param {string} label
 */
export function tempRoot(label) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `dss-test-${label}-`)));
}

/**
 * Devolve 0700 às pastas REAIS sob `dir` (testes travam algumas com 0500),
 * andando com lstat: NUNCA atravessa nem dá chmod através de symlink (os
 * testes de instalação criam links absolutos para projetos reais).
 * @param {string} dir
 */
function unlockTree(dir) {
  let st;
  try { st = fs.lstatSync(dir); } catch { return; }
  if (!st.isDirectory() || st.isSymbolicLink()) return;
  try { fs.chmodSync(dir, 0o700); } catch { /* ignora */ }
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) unlockTree(path.join(dir, name));
}

/** @param {string} dir */
export function rmrf(dir) {
  unlockTree(dir);
  // fs.rmSync recursivo faz unlink de symlinks, nunca segue.
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * /proc falso: `procs` mapeia pid → starttime (string); `self` é o pid deste
 * processo; `boot` o boot_id.
 * @param {{ self: number, boot: string|null, procs: Record<number, string>, noProc?: boolean, killResult?: (pid: number) => boolean|null }} spec
 * @returns {import('../src/owner.js').ProcReader}
 */
export function fakeProc(spec) {
  /** @param {number} pid @param {string} start */
  const line = (pid, start) => {
    const fields = ['S', ...Array.from({ length: 18 }, (_, i) => String(i + 4)), start, '0', '0'];
    return `${pid} (weird) name) (x) ${fields.join(' ')}`;
  };
  return {
    stat(pid) {
      if (spec.noProc) return null;
      const id = pid === 'self' ? spec.self : pid;
      const start = spec.procs[id];
      return start === undefined ? null : line(id, start);
    },
    bootId() {
      return spec.noProc ? null : spec.boot;
    },
    signalZero(pid) {
      if (spec.killResult) return spec.killResult(pid);
      return spec.procs[pid] !== undefined;
    },
  };
}

/** Clock manual. */
export function manualClock(start = 1_800_000_000_000) {
  let t = start;
  return {
    now: () => t,
    /** @param {number} ms */
    advance(ms) { t += ms; },
    /** @param {number} ms */
    set(ms) { t = ms; },
  };
}
