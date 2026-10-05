// @ts-check
/**
 * Remoção SEGURA de uma árvore de lixeira (`.trash-*`), sem `fs.rm` recursivo:
 *
 * - nunca segue symlink (links e arquivos são desligados com unlink; só
 *   diretórios reais, vistos por lstat, são percorridos);
 * - nunca cruza ponto de montagem: recusa a árvore inteira quando o
 *   `/proc/self/mountinfo` mostra uma montagem nela ou abaixo dela, não desce
 *   em diretório de outro `st_dev` e, no Linux, compara o `mnt_id` de cada
 *   diretório com o da raiz (bind mount do mesmo sistema de arquivos);
 * - destrava (u+rwx) só diretórios REAIS do próprio usuário (cache 0555 do Go,
 *   tarball read-only…), pelo fd `O_PATH|O_NOFOLLOW` — nunca por um caminho
 *   que possa ter virado symlink;
 * - só age estritamente dentro de `<host-tmp>/agent-scratch/`.
 *
 * A lógica é UM gerador de operações; dois motores a executam: síncrono com
 * prazo por operação (saída do processo) e assíncrono (varredura, sem travar
 * o event loop do `dsh web`).
 * @module dsh-session-scratch/remove
 */

import fs from 'node:fs';
import path from 'node:path';
import { isStrictlyInside } from './paths.js';

/** Profundidade máxima percorrida (o resto fica, nunca recursão sem fim). */
export const MAX_DEPTH = 300;

const IS_LINUX = process.platform === 'linux';
/** `O_PATH` do Linux (x86_64/arm64): abre sem permissão de leitura e sem seguir o último link. */
const O_PATH = 0o10000000;
const DIR_FLAGS = (IS_LINUX ? O_PATH : fs.constants.O_RDONLY) | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;

/**
 * @typedef {{ removed: boolean, timedOut?: boolean, reason?: string }} RemoveResult
 * @typedef {'gone'|'changed'|{ mnt: number|null }} EnterResult
 * @typedef {['lstat', string] | ['readdir', string] | ['unlink', string] | ['rmdir', string] | ['enter', string, fs.Stats]} Op
 */

/**
 * Pontos de montagem (5º campo) de um texto no formato de /proc/self/mountinfo,
 * com os escapes octais (`\040` etc.) desfeitos.
 * @param {string} text
 * @returns {string[]}
 */
export function parseMountPoints(text) {
  /** @type {string[]} */
  const out = [];
  for (const line of text.split('\n')) {
    const field = line.split(' ')[4];
    if (field !== undefined && field.startsWith('/')) {
      out.push(field.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(Number.parseInt(oct, 8))));
    }
  }
  return out;
}

/** @returns {string|null} */
function readMountinfo() {
  try {
    return fs.readFileSync('/proc/self/mountinfo', 'utf8');
  } catch {
    return null;
  }
}

/**
 * Pontos de montagem em `target` ou abaixo dele. `[]` sem /proc (fora do
 * Linux): aí o `st_dev` da caminhada ainda protege.
 * @param {string} target
 * @param {() => string|null} [read] leitor do mountinfo (injetável nos testes)
 * @returns {string[]}
 */
export function mountsAtOrBelow(target, read = readMountinfo) {
  const text = read();
  if (text === null) return [];
  let real;
  try {
    real = fs.realpathSync(target);
  } catch {
    real = path.resolve(target);
  }
  const prefix = real.endsWith('/') ? real : `${real}/`;
  return parseMountPoints(text).filter((m) => m === real || m.startsWith(prefix));
}

/**
 * @param {unknown} error
 * @returns {string|undefined}
 */
function codeOf(error) {
  return /** @type {NodeJS.ErrnoException} */ (error)?.code;
}

/**
 * @param {string} text conteúdo de /proc/self/fdinfo/<fd>
 * @returns {number|null}
 */
function parseMntId(text) {
  const m = /^mnt_id:\s*(\d+)/m.exec(text);
  return m === null ? null : Number(m[1]);
}

/**
 * O gerador: emite operações e recebe o resultado de cada uma (um valor ou um
 * `Error`). Pós-ordem iterativa com pilha explícita.
 * @param {string} target
 * @returns {Generator<Op, RemoveResult, any>}
 */
function* removeOps(target) {
  const root = yield ['lstat', target];
  if (root === null) return { removed: true, reason: 'gone' };
  if (root instanceof Error) return { removed: false, reason: String(root) };
  if (!root.isDirectory()) return { removed: false, reason: 'não é um diretório real' };
  /** @type {EnterResult} */
  const entered = yield ['enter', target, root];
  if (entered === 'gone') return { removed: true, reason: 'gone' };
  if (entered === 'changed') return { removed: false, reason: 'trocado durante a remoção' };
  const dev = root.dev;
  const mnt = entered.mnt;
  /** @type {{ p: string, entries: fs.Dirent[]|null, i: number, ok: boolean }[]} */
  const stack = [{ p: target, entries: null, i: 0, ok: true }];
  while (stack.length > 0) {
    const top = /** @type {(typeof stack)[number]} */ (stack[stack.length - 1]);
    if (top.entries === null) {
      const entries = yield ['readdir', top.p];
      if (entries instanceof Error) {
        top.entries = [];
        top.ok = false;
      } else {
        top.entries = entries;
      }
      continue;
    }
    if (top.i < top.entries.length) {
      const entry = /** @type {fs.Dirent} */ (top.entries[top.i]);
      top.i += 1;
      const child = path.join(top.p, entry.name);
      if (!entry.isDirectory()) {
        // Arquivo, symlink, socket…: unlink nunca segue o link. Um arquivo
        // que é ponto de montagem dá EBUSY e fica.
        const r = yield ['unlink', child];
        if (r instanceof Error) top.ok = false;
        continue;
      }
      const st = yield ['lstat', child];
      if (st === null) continue;
      if (st instanceof Error || !st.isDirectory() || st.dev !== dev || stack.length >= MAX_DEPTH) {
        top.ok = false; // outro sistema de arquivos (montagem), trocado ou fundo demais: fica
        continue;
      }
      /** @type {EnterResult} */
      const e = yield ['enter', child, st];
      if (e === 'gone') continue;
      if (e === 'changed' || (mnt !== null && e.mnt !== null && e.mnt !== mnt)) {
        top.ok = false; // bind mount do mesmo sistema de arquivos: nunca descer
        continue;
      }
      stack.push({ p: child, entries: null, i: 0, ok: true });
      continue;
    }
    stack.pop();
    let ok = top.ok;
    if (ok) {
      const r = yield ['rmdir', top.p];
      if (r instanceof Error) ok = false;
    }
    if (!ok) {
      const parent = stack[stack.length - 1];
      if (parent === undefined) return { removed: false, reason: 'sobrou conteúdo que não pôde ser apagado' };
      parent.ok = false;
    }
  }
  return { removed: true };
}

/**
 * @param {fs.Stats} st
 * @param {number} uid
 */
function needsUnlock(st, uid) {
  return (uid < 0 || st.uid === uid) && (st.mode & 0o700) !== 0o700;
}

/**
 * @param {fs.Stats} a
 * @param {fs.Stats} b
 */
function sameInode(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Executa uma operação de forma síncrona. Nunca lança: erro vira valor.
 * @param {Op} op
 * @param {number} uid
 * @returns {unknown}
 */
function runSync(op, uid) {
  try {
    switch (op[0]) {
      case 'lstat': return fs.lstatSync(op[1], { throwIfNoEntry: false }) ?? null;
      case 'readdir': return fs.readdirSync(op[1], { withFileTypes: true });
      case 'unlink': fs.unlinkSync(op[1]); return true;
      case 'rmdir': fs.rmdirSync(op[1]); return true;
      case 'enter': return enterSync(op[1], op[2], uid);
      default: return new Error('operação desconhecida');
    }
  } catch (error) {
    if (codeOf(error) === 'ENOENT' && (op[0] === 'unlink' || op[0] === 'rmdir')) return true;
    return error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Abre o diretório sem seguir link, confere que é o mesmo inode do lstat,
 * destrava (u+rwx) se for do usuário e lê o mnt_id.
 * @param {string} p
 * @param {fs.Stats} st
 * @param {number} uid
 * @returns {EnterResult}
 */
function enterSync(p, st, uid) {
  let fd;
  try {
    fd = fs.openSync(p, DIR_FLAGS);
  } catch (error) {
    const code = codeOf(error);
    if (code === 'ENOENT') return 'gone';
    if (code === 'ENOTDIR' || code === 'ELOOP') return 'changed';
    // Sem O_PATH (fora do Linux) um 0000 não abre: destrava pelo caminho
    // logo depois de um lstat que confirmou o mesmo diretório real.
    const again = fs.lstatSync(p, { throwIfNoEntry: false });
    if (again === undefined) return 'gone';
    if (!again.isDirectory() || !sameInode(again, st)) return 'changed';
    if (needsUnlock(again, uid)) {
      try { fs.chmodSync(p, (again.mode & 0o7777) | 0o700); } catch { /* o readdir dirá */ }
    }
    return { mnt: null };
  }
  try {
    const fst = fs.fstatSync(fd);
    if (!fst.isDirectory() || !sameInode(fst, st)) return 'changed';
    if (needsUnlock(fst, uid)) {
      try {
        if (IS_LINUX) fs.chmodSync(`/proc/self/fd/${fd}`, (fst.mode & 0o7777) | 0o700);
        else fs.fchmodSync(fd, (fst.mode & 0o7777) | 0o700);
      } catch { /* o readdir dirá */ }
    }
    if (!IS_LINUX) return { mnt: null };
    try {
      return { mnt: parseMntId(fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8')) };
    } catch {
      return { mnt: null };
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Versão assíncrona de {@link runSync}.
 * @param {Op} op
 * @param {number} uid
 * @returns {Promise<unknown>}
 */
async function runAsync(op, uid) {
  try {
    switch (op[0]) {
      case 'lstat': {
        try {
          return await fs.promises.lstat(op[1]);
        } catch (error) {
          if (codeOf(error) === 'ENOENT') return null;
          throw error;
        }
      }
      case 'readdir': return await fs.promises.readdir(op[1], { withFileTypes: true });
      case 'unlink': await fs.promises.unlink(op[1]); return true;
      case 'rmdir': await fs.promises.rmdir(op[1]); return true;
      case 'enter': return await enterAsync(op[1], op[2], uid);
      default: return new Error('operação desconhecida');
    }
  } catch (error) {
    if (codeOf(error) === 'ENOENT' && (op[0] === 'unlink' || op[0] === 'rmdir')) return true;
    return error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Versão assíncrona de {@link enterSync}.
 * @param {string} p
 * @param {fs.Stats} st
 * @param {number} uid
 * @returns {Promise<EnterResult>}
 */
async function enterAsync(p, st, uid) {
  let fh;
  try {
    fh = await fs.promises.open(p, DIR_FLAGS);
  } catch (error) {
    const code = codeOf(error);
    if (code === 'ENOENT') return 'gone';
    if (code === 'ENOTDIR' || code === 'ELOOP') return 'changed';
    let again;
    try { again = await fs.promises.lstat(p); } catch { return 'gone'; }
    if (!again.isDirectory() || !sameInode(again, st)) return 'changed';
    if (needsUnlock(again, uid)) {
      try { await fs.promises.chmod(p, (again.mode & 0o7777) | 0o700); } catch { /* o readdir dirá */ }
    }
    return { mnt: null };
  }
  try {
    const fst = await fh.stat();
    if (!fst.isDirectory() || !sameInode(fst, st)) return 'changed';
    if (needsUnlock(fst, uid)) {
      try {
        if (IS_LINUX) await fs.promises.chmod(`/proc/self/fd/${fh.fd}`, (fst.mode & 0o7777) | 0o700);
        else await fh.chmod((fst.mode & 0o7777) | 0o700);
      } catch { /* o readdir dirá */ }
    }
    if (!IS_LINUX) return { mnt: null };
    try {
      return { mnt: parseMntId(await fs.promises.readFile(`/proc/self/fdinfo/${fh.fd}`, 'utf8')) };
    } catch {
      return { mnt: null };
    }
  } finally {
    await fh.close();
  }
}

/**
 * @typedef {object} RemoveTreeOptions
 * @property {string} scratchRoot `<host-tmp>/agent-scratch`: `target` tem de estar ESTRITAMENTE dentro
 * @property {number} [uid] euid (destrava só diretórios dele); -1 = desconhecido
 * @property {number} [deadline] instante (ms, no relógio `now`) depois do qual o motor síncrono para
 * @property {() => number} [now]
 * @property {(target: string) => string[]} [mounts] detector de montagens (injetável nos testes)
 */

/**
 * @param {string} target
 * @param {RemoveTreeOptions} options
 * @returns {RemoveResult|null} um resultado de recusa, ou null para seguir
 */
function precheck(target, options) {
  if (!isStrictlyInside(options.scratchRoot, target)) {
    throw new Error(`dsh-session-scratch: recusei apagar ${target}: fora de ${options.scratchRoot}`);
  }
  const mounts = (options.mounts ?? mountsAtOrBelow)(target);
  if (mounts.length > 0) return { removed: false, reason: `ponto de montagem dentro: ${mounts[0]}` };
  return null;
}

/**
 * Remove `target` de forma SÍNCRONA, conferindo o prazo antes de cada
 * operação: estourado, para e devolve `timedOut` (o resto fica para a
 * varredura). Lança só quando `target` está fora de `scratchRoot`.
 * @param {string} target
 * @param {RemoveTreeOptions} options
 * @returns {RemoveResult}
 */
export function removeTreeSync(target, options) {
  const refused = precheck(target, options);
  if (refused !== null) return refused;
  const uid = options.uid ?? -1;
  const now = options.now ?? Date.now;
  const gen = removeOps(target);
  let step = gen.next();
  while (step.done !== true) {
    if (options.deadline !== undefined && now() > options.deadline) {
      gen.return({ removed: false });
      return { removed: false, timedOut: true, reason: 'prazo estourado' };
    }
    step = gen.next(runSync(step.value, uid));
  }
  return step.value;
}

/**
 * Remove `target` de forma ASSÍNCRONA (sem travar o event loop). Lança só
 * quando `target` está fora de `scratchRoot`.
 * @param {string} target
 * @param {RemoveTreeOptions} options
 * @returns {Promise<RemoveResult>}
 */
export async function removeTree(target, options) {
  const refused = precheck(target, options);
  if (refused !== null) return refused;
  const uid = options.uid ?? -1;
  const gen = removeOps(target);
  let step = gen.next();
  while (step.done !== true) step = gen.next(await runAsync(step.value, uid));
  return step.value;
}
