// @ts-check
/**
 * Varredura de pastas de sessão. `decide` é PURO (relógio, identidade e /proc
 * injetados) e é o que os testes exercitam; `sweepOnce` é o lado com efeitos
 * e delega a remoção ao {@link ScratchStore} (rename para `.trash-*`,
 * reverificação do marcador, depois rm sem seguir symlinks). No fim, os
 * apelidos curtos (`.s/<hash>`) pendurados saem: só o link, nunca o que ele
 * aponta.
 *
 * Antes de apagar qualquer coisa (pasta órfã ou ociosa, lixeira, apelido
 * pendurado) a varredura confere, como a da skill, se algum processo vivo do
 * euid ainda a usa — cwd, fds abertos ou TMPDIR/TMP/TEMP/TMPPREFIX do
 * environ apontando para a pasta canônica OU para um apelido dela
 * (`src/inuse.js`) — e se outro processo vivo do DSH a partilha (registro
 * `.owners/<key>@<pid>.share`). Em uso ou partilhada: fica.
 * @module dsh-session-scratch/sweep
 */

import fs from 'node:fs';
import path from 'node:path';
import { ALIAS_TEMP_PATTERN, aliasCandidates, aliasTarget, unlinkStaleAlias } from './alias.js';
import { lazyInUse } from './inuse.js';
import { isValidKey } from './paths.js';
import { ownerState, parseMarker } from './owner.js';
import { parseSharerName } from './store.js';

/**
 * @typedef {import('./owner.js').Identity} Identity
 * @typedef {import('./owner.js').OwnerMarker} OwnerMarker
 * @typedef {import('./owner.js').ProcReader} ProcReader
 *
 * @typedef {object} SweepEntry
 * @property {number} dirMtimeMs mtime da pasta da sessão
 * @property {OwnerMarker|null} marker marcador de dono (null se ausente/corrompido)
 * @property {number|null} markerMtimeMs mtime do arquivo do marcador (última atividade registrada)
 *
 * @typedef {object} DecideContext
 * @property {number} now relógio injetado (ms)
 * @property {number} idleMs inatividade máxima de uma pasta própria
 * @property {number} graceMs carência de uma pasta órfã (dono morto ou sem marcador)
 * @property {Identity} self identidade deste processo
 * @property {ProcReader} proc leitor de /proc (falso nos testes)
 *
 * @typedef {{ action: 'keep'|'delete', reason: 'idle-own'|'live-own'|'live-other'|'unknown-owner'|'orphan'|'orphan-grace' }} Decision
 */

/**
 * Decide o destino de UMA pasta de sessão.
 * - dono = este processo: apaga se a última atividade passou de `idleMs`;
 * - dono = outro processo vivo (mesmo boot, mesmo starttime): mantém;
 * - dono indeterminado (sem /proc e sem kill(0)): mantém;
 * - dono morto ou sem marcador: apaga quando a atividade mais recente
 *   (marcador ou pasta) passou da carência `graceMs`.
 * @param {SweepEntry} entry
 * @param {DecideContext} ctx
 * @returns {Decision}
 */
export function decide(entry, ctx) {
  const lastActivity = Math.max(entry.dirMtimeMs, entry.markerMtimeMs ?? 0);
  const age = ctx.now - lastActivity;
  if (entry.marker !== null) {
    const state = ownerState(entry.marker, ctx.self, ctx.proc);
    if (state === 'self') return age > ctx.idleMs ? { action: 'delete', reason: 'idle-own' } : { action: 'keep', reason: 'live-own' };
    if (state === 'alive') return { action: 'keep', reason: 'live-other' };
    if (state === 'unknown') return { action: 'keep', reason: 'unknown-owner' };
  }
  return age > ctx.graceMs ? { action: 'delete', reason: 'orphan' } : { action: 'keep', reason: 'orphan-grace' };
}

/**
 * Nome de lixeira deste processo: `.trash-<pid>-<rand>`.
 * @param {string} name
 * @returns {number|null} o pid embutido, ou null se não for lixeira
 */
export function trashPid(name) {
  const m = /^\.trash-(\d+)-[A-Za-z0-9]+$/.exec(name);
  return m === null ? null : Number(m[1]);
}

/**
 * `true` quando `pid` existe (via /proc, ou kill(0) sem /proc). Na dúvida, vivo.
 * @param {ProcReader} proc
 * @param {number} pid
 */
export function pidAlive(proc, pid) {
  if (proc.bootId() !== null) return proc.stat(pid) !== null;
  return proc.signalZero(pid) !== false;
}

/**
 * Lê um marcador do disco.
 * @param {string} file
 * @returns {Promise<{ marker: OwnerMarker|null, mtimeMs: number|null }>}
 */
async function readMarkerFile(file) {
  try {
    const [raw, st] = await Promise.all([fs.promises.readFile(file, 'utf8'), fs.promises.lstat(file)]);
    if (!st.isFile()) return { marker: null, mtimeMs: null };
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* corrompido: tratado como ausente */ }
    return { marker: parseMarker(parsed), mtimeMs: st.mtimeMs };
  } catch {
    return { marker: null, mtimeMs: null };
  }
}

/**
 * @typedef {{ deleted: string[], kept: Record<string, string>, trashCleared: string[], markersCleared: string[], sharersCleared: string[], aliasesCleared: string[] }} SweepReport
 * @typedef {(paths: string[]) => Promise<boolean>} InUse
 */

/**
 * Caminhos pelos quais um processo pode estar usando a sessão `key`: a pasta
 * canônica e todos os nomes de apelido possíveis dela.
 * @param {import('./store.js').ScratchStore} store
 * @param {string} key
 */
export function sessionPaths(store, key) {
  return [path.join(store.base, key), ...aliasCandidates(store.base, key, store.aliasOptions)];
}

/**
 * Desliga um `.tmp-*` de publicação interrompida: decisão refeita de forma
 * SÍNCRONA logo antes do `unlink` (cadeia, `.s` real do euid, mesmo inode).
 * @param {import('./store.js').ScratchStore} store
 * @param {string} full
 * @param {fs.Stats} seen
 */
function unlinkTempSync(store, full, seen) {
  store.verifyLayout();
  const dir = fs.lstatSync(store.aliasDir, { throwIfNoEntry: false });
  if (dir === undefined || !dir.isDirectory() || dir.isSymbolicLink() || (store.uid >= 0 && dir.uid !== store.uid)) return false;
  const st = fs.lstatSync(full, { throwIfNoEntry: false });
  if (st === undefined || !st.isSymbolicLink() || st.ino !== seen.ino || st.dev !== seen.dev) return false;
  fs.unlinkSync(full);
  return true;
}

/**
 * Apelidos em `<base>/.s/`. Só symlinks do euid; nada é seguido:
 * - `.tmp-<pid>-*` (publicação interrompida entre o symlink temporário e o
 *   link; nunca exportado): sai se o pid é este, está morto ou passou da carência;
 * - `<hash>` → `../<key>` com a pasta `<key>` presente: fica (o ciclo da pasta
 *   cuida do apelido);
 * - `<hash>` → `../<key>` PENDURADO (pasta ausente): sai depois da carência,
 *   salvo se o dono do marcador da chave está vivo (o hook recria a pasta e o
 *   apelido volta a valer) ou se um processo vivo ainda referencia o apelido
 *   ou a pasta — nunca o apelido de uma sessão viva. As entradas da decisão
 *   (pasta ausente, dono não vivo, mesmo link) são lidas DE NOVO, de forma
 *   síncrona, imediatamente antes do `unlink` ({@link unlinkStaleAlias}): uma
 *   retomada no meio da varredura (que tem `await`s) não perde o apelido;
 * - qualquer outro alvo (absoluto, fora da base) ou outro tipo de entrada:
 *   não é deste esquema, fica.
 * @param {import('./store.js').ScratchStore} store
 * @param {number} now
 * @param {number} graceMs
 * @param {SweepReport} report
 * @param {(msg: string) => void} log
 * @param {InUse} inUse
 */
async function sweepAliases(store, now, graceMs, report, log, inUse) {
  /** @type {string[]} */
  let names;
  try {
    store.verifyLayout();
    const dir = await fs.promises.lstat(store.aliasDir);
    if (!dir.isDirectory() || dir.isSymbolicLink() || (store.uid >= 0 && dir.uid !== store.uid)) {
      log(`varredura de apelidos: ${store.aliasDir} não é um diretório real deste usuário; nada tocado`);
      return;
    }
    names = await fs.promises.readdir(store.aliasDir);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') log(`varredura de apelidos: ${String(error)}`);
    return;
  }
  for (const name of names) {
    const full = path.join(store.aliasDir, name);
    try {
      const st = await fs.promises.lstat(full);
      if (!st.isSymbolicLink() || (store.uid >= 0 && st.uid !== store.uid)) continue;
      const age = now - st.mtimeMs;
      const temp = ALIAS_TEMP_PATTERN.exec(name);
      if (temp !== null) {
        const pid = Number(temp[1]);
        if ((pid === process.pid || !pidAlive(store.proc, pid) || age > graceMs) && unlinkTempSync(store, full, st)) {
          report.aliasesCleared.push(name);
        }
        continue;
      }
      const target = await fs.promises.readlink(full);
      const key = target.startsWith('../') ? target.slice(3) : '';
      if (!isValidKey(key) || target !== aliasTarget(key)) continue;
      if (await fs.promises.lstat(path.join(store.base, key)).then(() => true, () => false)) continue;
      if (age <= graceMs) continue;
      /** Dono do marcador não vivo (morto, ausente, ou este processo sem usar a chave). */
      const ownerGone = () => {
        const state = store.ownerStateSync(key);
        return state === 'dead' || (state === 'self' && !store.isLive(key));
      };
      if (!ownerGone() || store.liveSharers(key).length > 0) continue;
      if (await inUse([full, ...sessionPaths(store, key)])) continue;
      // Daqui até o unlink tudo é SÍNCRONO: nenhuma retomada cabe entre a
      // última conferência e a syscall (e, se couber, o apelido é republicado).
      store.verifyLayout();
      const removed = unlinkStaleAlias(store.base, key, full, {
        ...store.aliasOpts(),
        seen: st,
        stillStale: () => ownerGone() && store.liveSharers(key).length === 0,
      });
      if (removed) report.aliasesCleared.push(name);
    } catch (error) {
      log(`varredura de apelidos: ${name}: ${String(error)}`);
    }
  }
}

/**
 * Uma passada completa sobre `store.base`. Nunca lança: todo erro vira log.
 * Só toca entradas cujo nome é chave válida (ou lixeira/marcador/apelido do
 * próprio esquema), que sejam diretórios reais (lstat, sem symlink) do euid.
 * @param {import('./store.js').ScratchStore} store
 * @param {{ idleMs: number, graceMs: number, now?: () => number, log?: (msg: string) => void, inUse?: InUse }} options
 *   `inUse` (injetável nos testes): default = fotografia preguiçosa do /proc ({@link lazyInUse})
 * @returns {Promise<SweepReport>}
 */
export async function sweepOnce(store, options) {
  const now = (options.now ?? Date.now)();
  const log = options.log ?? (() => {});
  /** @type {SweepReport} */
  const report = { deleted: [], kept: {}, trashCleared: [], markersCleared: [], sharersCleared: [], aliasesCleared: [] };
  const inUse = options.inUse ?? lazyInUse();
  /** @type {fs.Dirent[]} */
  let entries;
  try {
    // Recria base/.owners se sumiram (tmpfiles, rm manual) e revalida a
    // cadeia: symlink, dono errado ou base trocada abortam a passada inteira.
    store.ensureLayout();
    entries = await fs.promises.readdir(store.base, { withFileTypes: true });
  } catch (error) {
    log(`varredura: base não confiável ou ilegível (${store.base}): ${String(error)}`);
    return report;
  }
  const uid = store.uid;
  const ctx = { now, idleMs: options.idleMs, graceMs: options.graceMs, self: store.self, proc: store.proc };
  const present = new Set();

  for (const entry of entries) {
    const name = entry.name;
    const full = path.join(store.base, name);
    try {
      const pid = trashPid(name);
      if (pid !== null) {
        if (store.isPendingTrash(full)) continue;
        const st = await fs.promises.lstat(full);
        if (!st.isDirectory() || st.isSymbolicLink() || (uid >= 0 && st.uid !== uid)) continue;
        // Lixeira de OUTRO processo vivo: ele ainda pode estar apagando; só
        // depois da carência. Pid morto (ou este processo, sem rm pendente): já.
        if (pid !== process.pid && pidAlive(store.proc, pid) && now - st.mtimeMs <= options.graceMs) continue;
        // Um sobrevivente com o cwd lá dentro (a pasta foi renomeada sob ele): fica.
        if (await inUse([full])) { report.kept[name] = 'in-use'; continue; }
        await store.rmTree(full);
        report.trashCleared.push(name);
        continue;
      }
      if (!isValidKey(name)) continue;
      const st = await fs.promises.lstat(full);
      if (!st.isDirectory() || st.isSymbolicLink() || (uid >= 0 && st.uid !== uid)) continue;
      present.add(name);
      const { marker, mtimeMs } = await readMarkerFile(store.markerPath(name));
      const decision = decide({ dirMtimeMs: st.mtimeMs, marker, markerMtimeMs: mtimeMs }, ctx);
      if (decision.action === 'keep') {
        report.kept[name] = decision.reason;
        continue;
      }
      if (store.liveSharers(name).length > 0) {
        report.kept[name] = 'live-sharer';
        continue;
      }
      if (await inUse(sessionPaths(store, name))) {
        report.kept[name] = 'in-use';
        continue;
      }
      const removed = await store.remove(name, { expect: { marker, mtimeMs }, wait: true });
      if (removed) report.deleted.push(name);
      else report.kept[name] = 'changed-during-sweep';
    } catch (error) {
      log(`varredura: ${name}: ${String(error)}`);
    }
  }

  // Marcadores sem pasta: some quando o dono morreu (ou é este processo e
  // já não usa a chave) e a carência passou.
  try {
    const markers = await fs.promises.readdir(store.ownersDir, { withFileTypes: true });
    for (const m of markers) {
      if (!m.isFile()) continue;
      const sharer = parseSharerName(m.name);
      if (sharer !== null) {
        // Registro de partilha de processo morto (ou deste, sem usar a chave): sai.
        const { marker } = await readMarkerFile(path.join(store.ownersDir, m.name));
        const state = marker === null || marker.pid !== sharer.pid ? 'dead' : ownerState(marker, store.self, store.proc);
        if (state === 'dead' || (state === 'self' && !store.isLive(sharer.key))) {
          store.verifyLayout();
          await fs.promises.rm(path.join(store.ownersDir, m.name), { force: true });
          report.sharersCleared.push(m.name);
        }
        continue;
      }
      if (!m.name.endsWith('.json')) continue;
      const key = m.name.slice(0, -'.json'.length);
      if (!isValidKey(key) || present.has(key)) continue;
      const file = path.join(store.ownersDir, m.name);
      const { marker, mtimeMs } = await readMarkerFile(file);
      const age = now - (mtimeMs ?? 0);
      const state = marker === null ? 'dead' : ownerState(marker, store.self, store.proc);
      const stale = state === 'dead' || (state === 'self' && !store.isLive(key));
      if (stale && age > options.graceMs) {
        store.verifyLayout(); // .owners trocado por symlink entre a listagem e o rm: aborta
        await fs.promises.rm(file, { force: true });
        report.markersCleared.push(key);
      }
    }
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') log(`varredura de marcadores: ${String(error)}`);
  }

  await sweepAliases(store, now, options.graceMs, report, log, inUse);
  return report;
}
