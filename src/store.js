// @ts-check
/**
 * As pastas de sessão em disco: criação 0700 com marcador de dono, toque
 * (throttled) para a detecção de inatividade, remoção segura e a limpeza
 * síncrona das pastas PRÓPRIAS quando o processo sai.
 *
 * Layout sob `<host-tmp>/<baseDir>` (default `<host-tmp>/agent-scratch/dsh`):
 * ```
 * <key>/                 pasta CANÔNICA da sessão (onde os arquivos ficam)
 * .s/<hash>              apelido curto → ../<key> (o TMPDIR exportado; src/alias.js)
 * .owners/<key>.json     marcador {v,pid,start,boot,createdAt}; mtime = última atividade
 * .owners/<key>@<pid>.share  registro de PARTILHA: outro processo vivo do DSH usa a
 *                        mesma chave sem ser o dono (mesmo formato do marcador)
 * .trash-<pid>-<rand>/   pasta já renomeada, a caminho do rm
 * ```
 *
 * Invariantes de segurança:
 * - só apaga dentro de `<host-tmp>/agent-scratch/` (asserção antes de cada rm);
 * - antes de TODA operação destrutiva revalida a cadeia agent-scratch → base →
 *   .owners (diretórios reais do euid, sem symlink) e a identidade (dev/ino)
 *   da base; uma base trocada por outra pasta só é adotada se for uma base de
 *   scratch (tem `.owners` real) — senão nada é criado nem apagado nela;
 * - nunca segue symlink nem cruza ponto de montagem (src/remove.js);
 * - só apaga diretórios do próprio euid;
 * - apelidos (`.s/<hash>`) só são desligados (unlink do próprio link, nunca
 *   através dele) quando a pasta canônica já saiu do lugar;
 * - a pasta de uma chave PARTILHADA por outro processo vivo (registro
 *   `.owners/<key>@<pid>.share`) nunca é apagada pela saída do dono: o
 *   marcador passa para o processo vivo, que a apaga quando ele sair.
 * @module dsh-session-scratch/store
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertTrustedStat, ensureTrustedDir, isStrictlyInside, isValidKey } from './paths.js';
import { ALIAS_DIRNAME, ensureAlias, isOwnAlias, needsAlias, unlinkAliases } from './alias.js';
import { isSelf, newMarker, ownerState, parseMarker, realProc, selfIdentity } from './owner.js';
import { mountsAtOrBelow, removeTree, removeTreeSync } from './remove.js';

/**
 * @typedef {object} RemoveOptions
 * @property {{ marker: import('./owner.js').OwnerMarker|null, mtimeMs: number|null }} [expect] marcador visto na decisão do sweeper; se mudou, nada é apagado. Sem ele, mantém a pasta quando outro processo vivo é o dono.
 * @property {boolean} [wait] aguarda o rm assíncrono (o sweeper aguarda)
 * @property {() => void} [afterRename] gancho de teste entre o rename e a reverificação
 */

/** Intervalo mínimo entre dois toques (escritas) da mesma chave. */
export const TOUCH_INTERVAL_MS = 60_000;

/**
 * Orçamento da parte PESADA da limpeza síncrona na saída. O prazo é conferido
 * antes de cada operação de disco; o que sobrar fica como `.trash-*` para a
 * próxima varredura (de qualquer processo do DSH com o plugin).
 */
export const EXIT_BUDGET_MS = 1_000;

/**
 * Depois de uma tentativa de apelido que falhou (todos os nomes ocupados,
 * `.s` não confiável), espera isto antes de tentar de novo: sem isso cada
 * chamada de bash refaria a tentativa (e o log) até o fim da sessão.
 */
export const ALIAS_RETRY_MS = TOUCH_INTERVAL_MS;

/** Sufixo do registro de partilha `.owners/<key>@<pid>.share`. */
export const SHARE_SUFFIX = '.share';

/**
 * Nome do registro de partilha. O `@` não existe numa chave válida, então
 * nunca colide com um marcador `<key>.json`.
 * @param {string} key
 * @param {number} pid
 */
export function sharerName(key, pid) {
  return `${key}@${pid}${SHARE_SUFFIX}`;
}

/**
 * @param {string} name
 * @returns {{ key: string, pid: number } | null}
 */
export function parseSharerName(name) {
  const m = /^(.+)@(\d+)\.share$/.exec(name);
  if (m === null || !isValidKey(m[1])) return null;
  return { key: /** @type {string} */ (m[1]), pid: Number(m[2]) };
}

/**
 * @typedef {{ scratchRoot: string, uid: number, verify: () => void }} TrashInfo
 * @typedef {{ markerPath: string, scratchRoot: string, uid: number, self: import('./owner.js').Identity, verify: () => void, dropAliases?: () => string[], handOver?: () => boolean, dropSharer?: () => void }} DirInfo
 * (os três últimos são opcionais: um DirInfo de uma instância anterior do módulo, via HMR, não os tem)
 *
 * Estado por PROCESSO, partilhado entre instâncias do módulo (HMR recarrega o
 * módulo com outra URL): pastas vivas deste processo e lixeiras pendentes.
 * Um único listener de `exit` por processo limpa tudo isso.
 * @typedef {{ dirs: Map<string, DirInfo>, trash: Map<string, TrashInfo>, exitInstalled: boolean, shuttingDown: boolean, trace: ((event: string, detail?: unknown) => void) | null }} ProcessState
 */
const STATE_KEY = Symbol.for('dsh-session-scratch/process-state/v2');

/** @returns {ProcessState} */
export function processState() {
  const g = /** @type {Record<symbol, ProcessState|undefined>} */ (/** @type {unknown} */ (globalThis));
  let state = g[STATE_KEY];
  if (state === undefined) {
    state = { dirs: new Map(), trash: new Map(), exitInstalled: false, shuttingDown: false, trace: null };
    g[STATE_KEY] = state;
  }
  return state;
}

/**
 * @param {string} scratchRoot
 * @param {string} target
 */
function assertInside(scratchRoot, target) {
  if (!isStrictlyInside(scratchRoot, target)) {
    throw new Error(`dsh-session-scratch: recusei apagar ${target}: fora de ${scratchRoot}`);
  }
}

/**
 * @param {unknown} error
 * @returns {string|undefined}
 */
function codeOf(error) {
  return /** @type {NodeJS.ErrnoException} */ (error)?.code;
}

/**
 * Lê um marcador (síncrono).
 * @param {string} file
 * @returns {{ marker: import('./owner.js').OwnerMarker|null, mtimeMs: number|null, raw: string|null }}
 */
function readMarkerSync(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return { marker: null, mtimeMs: null, raw: null };
    const raw = fs.readFileSync(file, 'utf8');
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* corrompido */ }
    return { marker: parseMarker(parsed), mtimeMs: st.mtimeMs, raw };
  } catch {
    return { marker: null, mtimeMs: null, raw: null };
  }
}

/**
 * Mesmo marcador (conteúdo) e mesmo mtime: ninguém o tocou entretanto.
 * @param {{ marker: import('./owner.js').OwnerMarker|null, mtimeMs: number|null }} a
 * @param {{ marker: import('./owner.js').OwnerMarker|null, mtimeMs: number|null }} b
 */
function sameMarker(a, b) {
  return JSON.stringify(a.marker) === JSON.stringify(b.marker) && a.mtimeMs === b.mtimeMs;
}

export class ScratchStore {
  /**
   * @param {object} options
   * @param {string} options.tmpRoot raiz temporária do host (hostTmpdir())
   * @param {string} options.baseDir relativo, validado (agent-scratch/dsh…)
   * @param {import('./owner.js').ProcReader} [options.proc]
   * @param {() => number} [options.now]
   * @param {(msg: string) => void} [options.log]
   * @param {number} [options.uid]
   * @param {(target: string) => string[]} [options.mounts] detector de montagens (injetável nos testes)
   * @param {Pick<import('./alias.js').AliasOptions, 'hashOf'|'link'>} [options.aliasOptions] injeções de teste do apelido
   */
  constructor(options) {
    this.tmpRoot = options.tmpRoot;
    this.baseDir = options.baseDir;
    this.proc = options.proc ?? realProc;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.uid = options.uid ?? process.getuid?.() ?? -1;
    this.mounts = options.mounts ?? mountsAtOrBelow;
    const segments = options.baseDir.split('/');
    /** Componentes acima da base, de `<tmpRoot>/agent-scratch` para baixo. */
    this.parents = segments.slice(0, -1).map((_, i) => path.join(options.tmpRoot, ...segments.slice(0, i + 1)));
    this.scratchRoot = path.join(options.tmpRoot, /** @type {string} */ (segments[0]));
    this.base = path.join(options.tmpRoot, ...segments);
    this.ownersDir = path.join(this.base, '.owners');
    /** Pasta dos apelidos curtos (`.s`). */
    this.aliasDir = path.join(this.base, ALIAS_DIRNAME);
    this.aliasOptions = options.aliasOptions ?? {};
    /** @type {Map<string, string|null>} chave → apelido em uso (null = sem apelido) */
    this.aliases = new Map();
    /** @type {Map<string, number>} chave → quando a última tentativa de apelido falhou (back-off) */
    this.aliasFailedAt = new Map();
    /** @type {Set<string>} chaves que este processo partilha (escreveu o registro .share) */
    this.sharing = new Set();
    /** @type {{ dev: number, ino: number } | null} identidade da base em uso */
    this.baseId = null;
    this.ensureLayout();
    this.self = selfIdentity(this.proc);
    /** @type {Map<string, number>} chave → último toque (ms) */
    this.lastTouch = new Map();
    /** Revalida a cadeia antes de operações destrutivas fora desta instância. */
    this.verify = () => this.verifyLayout();
  }

  /**
   * Aceita `st` como a base em uso. Primeira vez, mesma identidade ou pasta
   * recém-criada por nós: sim. Identidade mudou (base recriada por fora): só
   * se ela é uma base de scratch, isto é, tem um `.owners` real do euid.
   * @param {fs.Stats} st
   * @param {boolean} created
   */
  adoptBase(st, created) {
    const known = this.baseId;
    if (known === null || created || (known.dev === st.dev && known.ino === st.ino)) {
      this.baseId = { dev: st.dev, ino: st.ino };
      return;
    }
    const owners = fs.lstatSync(this.ownersDir, { throwIfNoEntry: false });
    const isScratchBase = owners !== undefined && owners.isDirectory() && (this.uid < 0 || owners.uid === this.uid);
    // Vazia: outro processo acabou de criá-la e ainda vai criar o .owners —
    // adotar não arrisca nada (não há o que apagar nela).
    if (isScratchBase || fs.readdirSync(this.base).length === 0) {
      this.baseId = { dev: st.dev, ino: st.ino };
      this.log(`${this.base} foi recriada por outro processo; adotada`);
      return;
    }
    throw new Error(`dsh-session-scratch: ${this.base} foi trocada por uma pasta que não é uma base de scratch (sem .owners); nada será criado nem apagado nela`);
  }

  /**
   * Cria (se faltar) e valida a cadeia inteira: agent-scratch → base →
   * .owners, cada um diretório real 0700 do euid. Chamado no construtor, quando
   * a base ou o .owners sumiram (tmpfiles, rm manual) e no início de cada
   * varredura. Lança em symlink, dono errado ou base trocada.
   */
  ensureLayout() {
    for (const dir of this.parents) ensureTrustedDir(dir, { uid: this.uid });
    const { st, created } = ensureTrustedDir(this.base, { uid: this.uid });
    this.adoptBase(st, created);
    ensureTrustedDir(this.ownersDir, { uid: this.uid });
  }

  /**
   * Valida a cadeia SEM criar nada (antes de cada operação destrutiva e de
   * cada toque). Componente ausente lança erro com `code: 'ENOENT'`; symlink,
   * dono errado ou base trocada lançam erro comum.
   */
  verifyLayout() {
    for (const dir of this.parents) assertTrustedStat(dir, fs.lstatSync(dir, { throwIfNoEntry: false }), this.uid);
    const st = assertTrustedStat(this.base, fs.lstatSync(this.base, { throwIfNoEntry: false }), this.uid);
    this.adoptBase(st, false);
    assertTrustedStat(this.ownersDir, fs.lstatSync(this.ownersDir, { throwIfNoEntry: false }), this.uid);
  }

  /** @param {string} key */
  dirFor(key) {
    if (!isValidKey(key)) throw new Error(`dsh-session-scratch: chave inválida ${JSON.stringify(key)}`);
    return path.join(this.base, key);
  }

  /** @param {string} key */
  markerPath(key) {
    if (!isValidKey(key)) throw new Error(`dsh-session-scratch: chave inválida ${JSON.stringify(key)}`);
    return path.join(this.ownersDir, `${key}.json`);
  }

  /** @param {string} key @param {number} [pid] */
  sharerPath(key, pid = this.self.pid) {
    if (!isValidKey(key)) throw new Error(`dsh-session-scratch: chave inválida ${JSON.stringify(key)}`);
    return path.join(this.ownersDir, sharerName(key, pid));
  }

  /**
   * Situação do dono do marcador da chave, lida AGORA (síncrona; ausente ou
   * corrompido = `dead`).
   * @param {string} key
   * @returns {'self'|'alive'|'dead'|'unknown'}
   */
  ownerStateSync(key) {
    const { marker } = readMarkerSync(this.markerPath(key));
    return marker === null ? 'dead' : ownerState(marker, this.self, this.proc);
  }

  /**
   * Processos VIVOS (ou indeterminados) que partilham a chave sem ser o dono,
   * pelos registros `.owners/<key>@<pid>.share`. Este processo não conta.
   * Síncrono (roda também na saída). Nunca lança.
   * @param {string} key
   * @returns {import('./owner.js').OwnerMarker[]}
   */
  liveSharers(key) {
    /** @type {import('./owner.js').OwnerMarker[]} */
    const out = [];
    let names;
    try { names = fs.readdirSync(this.ownersDir); } catch { return out; }
    const prefix = `${key}@`;
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const parsed = parseSharerName(name);
      if (parsed === null || parsed.key !== key) continue;
      const { marker } = readMarkerSync(path.join(this.ownersDir, name));
      if (marker === null || marker.pid !== parsed.pid) continue;
      const state = ownerState(marker, this.self, this.proc);
      if (state === 'alive' || state === 'unknown') out.push(marker);
    }
    return out;
  }

  /**
   * Registra que este processo usa a chave sem ser o dono (o dono é outro
   * processo vivo). Atômico (tmp + rename); o mtime é a última atividade.
   * @param {string} key
   */
  writeSharer(key) {
    const file = this.sharerPath(key);
    const tmp = path.join(this.ownersDir, `.${key}@${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(newMarker(this.self, this.now()))}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
    this.sharing.add(key);
  }

  /**
   * Apaga o registro de partilha DESTE processo para a chave (se existir e for
   * dele), com a cadeia revalidada antes. Nunca lança.
   * @param {string} key
   */
  dropSharer(key) {
    this.sharing.delete(key);
    try {
      this.verifyLayout();
      const file = this.sharerPath(key);
      if (isSelf(readMarkerSync(file).marker, this.self)) fs.rmSync(file, { force: true });
    } catch { /* best effort: a varredura apaga registros de pid morto */ }
  }

  /**
   * Na saída do DONO: se outro processo vivo partilha a chave, o marcador
   * passa para ele (escrita atômica) e a pasta e o apelido FICAM — ele os
   * apaga quando sair. Devolve `true` quando há processo vivo partilhando
   * (mesmo se a escrita falhou: nesse caso o marcador fica com o dono que
   * sai, a varredura vê o partilhador vivo e mantém, e o próximo toque dele
   * assume). Nunca lança.
   * @param {string} key
   * @returns {boolean}
   */
  handOver(key) {
    let heirs;
    try {
      this.verifyLayout();
      heirs = this.liveSharers(key);
    } catch {
      return false;
    }
    const heir = heirs[0];
    if (heir === undefined) return false;
    try {
      const tmp = path.join(this.ownersDir, `.${key}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
      fs.writeFileSync(tmp, `${JSON.stringify(newMarker(heir, this.now()))}\n`, { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, this.markerPath(key));
      this.log(`${key}: partilhada com o pid ${heir.pid}, que segue vivo; o marcador passou para ele e a pasta fica`);
    } catch (error) {
      this.log(`${key}: partilhada com o pid ${heir.pid}; não consegui passar o marcador (${String(error)}); a pasta fica`);
    }
    return true;
  }

  /** `true` enquanto este processo usa a chave. @param {string} key */
  isLive(key) {
    return processState().dirs.has(path.join(this.base, key));
  }

  /** @param {string} full */
  isPendingTrash(full) {
    return processState().trash.has(full);
  }

  /** @returns {TrashInfo} */
  trashInfo() {
    return { scratchRoot: this.scratchRoot, uid: this.uid, verify: this.verify };
  }

  /**
   * Escreve o marcador deste processo de forma atômica (tmp + rename).
   * @param {string} key
   */
  writeMarker(key) {
    const file = this.markerPath(key);
    const tmp = path.join(this.ownersDir, `.${key}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(newMarker(this.self, this.now()))}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  }

  /**
   * Garante a pasta da sessão e o marcador; toca ambos (mtime = atividade).
   * Throttled: dentro de {@link TOUCH_INTERVAL_MS} desde o último toque só
   * confere (um lstat) que a pasta ainda existe. Se a base ou o `.owners`
   * sumiram, recria a cadeia (com as mesmas verificações) e tenta de novo.
   * Lança em pasta não confiável.
   * @param {string} key
   * @param {{ force?: boolean }} [options]
   * @returns {string} caminho absoluto da pasta
   */
  ensure(key, options = {}) {
    const dir = this.dirFor(key);
    const now = this.now();
    const last = this.lastTouch.get(key);
    if (options.force !== true && last !== undefined && now - last < TOUCH_INTERVAL_MS) {
      const st = fs.lstatSync(dir, { throwIfNoEntry: false });
      if (st !== undefined && st.isDirectory()) return dir;
    }
    try {
      return this.touch(key, dir, now);
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error;
      this.ensureLayout();
      return this.touch(key, dir, now);
    }
  }

  /**
   * @param {string} key
   * @param {string} dir
   * @param {number} now
   */
  touch(key, dir, now) {
    this.verifyLayout();
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') throw error;
    }
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory() || (this.uid >= 0 && st.uid !== this.uid)) {
      throw new Error(`dsh-session-scratch: ${dir} não é uma pasta confiável`);
    }
    const file = this.markerPath(key);
    const current = readMarkerSync(file);
    const state = current.marker === null ? 'dead' : ownerState(current.marker, this.self, this.proc);
    const seconds = now / 1000;
    if (state === 'dead') {
      this.writeMarker(key); // ausente, corrompido ou dono morto: assume
      if (this.sharing.has(key)) this.dropSharer(key);
    } else if (state === 'self') {
      fs.utimesSync(file, seconds, seconds);
      if (this.sharing.has(key)) this.dropSharer(key); // recebeu o marcador de quem saiu
    } else {
      // 'alive'/'unknown': outro processo vivo usa a mesma sessão — partilha sem
      // roubar o marcador, mas se registra: a saída do dono não apaga a pasta.
      try {
        this.writeSharer(key);
      } catch (error) {
        this.log(`${key}: não consegui registrar a partilha (${String(error)})`);
      }
    }
    try { fs.utimesSync(dir, seconds, seconds); } catch { /* corrida com remoção: o próximo ensure recria */ }
    this.lastTouch.set(key, now);
    processState().dirs.set(dir, {
      markerPath: file,
      scratchRoot: this.scratchRoot,
      uid: this.uid,
      self: this.self,
      verify: this.verify,
      dropAliases: () => this.dropAliases(key),
      handOver: () => this.handOver(key),
      dropSharer: () => this.dropSharer(key),
    });
    this.refreshAlias(key);
    return dir;
  }

  /** @returns {import('./alias.js').AliasOptions} */
  aliasOpts() {
    return { ...this.aliasOptions, uid: this.uid, log: this.log };
  }

  /**
   * (Re)cria o apelido curto da chave, com a cadeia revalidada antes (um `.s`
   * só é criado dentro da base confiável). Depois de uma falha (todos os
   * nomes ocupados, `.s` não confiável) só tenta de novo após
   * {@link ALIAS_RETRY_MS}, e o log sai só na TRANSIÇÃO (apelido → sem
   * apelido, e a volta) — nunca a cada chamada de bash. Nunca lança.
   * @param {string} key
   * @returns {string|null}
   */
  refreshAlias(key) {
    if (!needsAlias(this.base, key, this.aliasOptions)) {
      this.aliases.set(key, null);
      this.aliasFailedAt.delete(key);
      return null;
    }
    const failedAt = this.aliasFailedAt.get(key);
    if (failedAt !== undefined && this.now() - failedAt < ALIAS_RETRY_MS) return null;
    try {
      this.verifyLayout();
    } catch {
      this.aliases.delete(key);
      return null;
    }
    /** @type {string[]} */
    const notes = [];
    const alias = ensureAlias(this.base, key, { ...this.aliasOpts(), log: (m) => { notes.push(m); } });
    this.aliases.set(key, alias);
    if (alias === null) {
      if (failedAt === undefined) for (const m of notes) this.log(m);
      this.aliasFailedAt.set(key, this.now());
    } else {
      for (const m of notes) this.log(m);
      if (failedAt !== undefined) {
        this.aliasFailedAt.delete(key);
        this.log(`apelido curto de ${key} restabelecido: ${alias}`);
      }
    }
    return alias;
  }

  /**
   * Apelido curto em uso pela chave, conferido a cada chamada (lstat +
   * readlink, sem seguir o link) e recriado se sumiu. `null` quando o caminho
   * canônico já é curto, quando `.s` não é confiável ou quando todos os nomes
   * estão ocupados — o TMPDIR fica então no caminho canônico. Nunca lança.
   * @param {string} key
   * @returns {string|null}
   */
  alias(key) {
    const cached = this.aliases.get(key);
    if (typeof cached === 'string' && isOwnAlias(cached, key, this.uid)) return cached;
    return this.refreshAlias(key);
  }

  /**
   * {@link ensure} + {@link alias}: a pasta canônica e o apelido a exportar.
   * @param {string} key
   * @param {{ force?: boolean }} [options]
   * @returns {{ dir: string, alias: string|null }}
   */
  session(key, options = {}) {
    const dir = this.ensure(key, options);
    return { dir, alias: this.alias(key) };
  }

  /**
   * Desliga os apelidos da chave se a pasta canônica já saiu do lugar. Nunca
   * lança (ver {@link unlinkAliases}).
   * @param {string} key
   * @returns {string[]}
   */
  dropAliases(key) {
    try {
      this.verifyLayout();
    } catch {
      return [];
    }
    return unlinkAliases(this.base, key, this.aliasOpts());
  }

  /**
   * Para de considerar a chave viva neste processo (sem apagar nada).
   * @param {string} key
   */
  forget(key) {
    this.lastTouch.delete(key);
    this.aliases.delete(key);
    this.aliasFailedAt.delete(key);
    if (this.sharing.has(key)) this.dropSharer(key);
    processState().dirs.delete(path.join(this.base, key));
  }

  /**
   * Remoção assíncrona e segura de uma árvore (sem seguir symlink, sem cruzar
   * montagem), só sob agent-scratch/ e com a cadeia revalidada. Lança se não
   * conseguiu apagar tudo.
   * @param {string} target
   */
  async rmTree(target) {
    assertInside(this.scratchRoot, target);
    this.verifyLayout();
    const result = await removeTree(target, { scratchRoot: this.scratchRoot, uid: this.uid, mounts: this.mounts });
    if (!result.removed) throw new Error(`${target}: ${result.reason ?? 'não apagada'}`);
  }

  /**
   * Parte síncrona da remoção: revalida a cadeia → lstat → recusa pasta com
   * ponto de montagem dentro → rename para `.trash-<pid>-<rand>` (atômico) →
   * reverifica o marcador (se mudou desde a decisão, desfaz o rename) → apaga
   * o marcador. Devolve a lixeira a apagar, `null` quando a pasta já não
   * existia, ou `false` quando nada deve ser apagado.
   * @param {string} key
   * @param {RemoveOptions} options
   * @returns {string|null|false}
   */
  detach(key, options) {
    const dir = this.dirFor(key);
    assertInside(this.scratchRoot, dir);
    this.verifyLayout();
    const file = this.markerPath(key);
    const before = readMarkerSync(file);
    if (options.expect !== undefined) {
      if (!sameMarker(before, options.expect)) return false;
    } else if (before.marker !== null) {
      const state = ownerState(before.marker, this.self, this.proc);
      if (state === 'alive' || state === 'unknown') {
        // Outra instância viva usa a mesma sessão: só esquece localmente.
        this.forget(key);
        return false;
      }
    }
    const st = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (st === undefined) {
      this.dropMarkerIf(file, before);
      this.forget(key);
      this.dropAliases(key);
      return null;
    }
    if (st.isSymbolicLink() || !st.isDirectory() || (this.uid >= 0 && st.uid !== this.uid)) {
      this.forget(key);
      return false;
    }
    if (this.liveSharers(key).length > 0) {
      // Outro processo vivo partilha a pasta (registro .share): não é lixo.
      this.log(`não removi ${dir}: outro processo vivo a partilha`);
      return false;
    }
    const mounts = this.mounts(dir);
    if (mounts.length > 0) {
      this.log(`não removi ${dir}: ponto de montagem dentro (${mounts[0]}); desmonte e a varredura apaga depois`);
      return false;
    }
    const trash = path.join(this.base, `.trash-${process.pid}-${randomBytes(6).toString('hex')}`);
    fs.renameSync(dir, trash);
    const state = processState();
    state.trash.set(trash, this.trashInfo());
    options.afterRename?.();
    const after = readMarkerSync(file);
    if (!sameMarker(before, after)) {
      // Alguém assumiu a sessão no meio: devolve a pasta.
      try {
        fs.renameSync(trash, dir);
        state.trash.delete(trash);
        return false;
      } catch {
        // A pasta já foi recriada pelo novo dono: a lixeira segue para o rm.
      }
    }
    this.dropMarkerIf(file, before);
    this.forget(key);
    this.dropAliases(key);
    return trash;
  }

  /**
   * Remove a pasta de uma sessão com rm ASSÍNCRONO da lixeira (o rename é
   * síncrono, então o caminho da sessão some na hora). Nunca rejeita.
   * @param {string} key
   * @param {RemoveOptions} [options]
   * @returns {Promise<boolean>} true quando a pasta saiu do lugar
   */
  async remove(key, options = {}) {
    let trash;
    try {
      trash = this.detach(key, options);
    } catch (error) {
      this.log(`não consegui remover ${key}: ${String(error)}`);
      return false;
    }
    if (trash === false) return false;
    if (trash === null) return true;
    const state = processState();
    const done = this.rmTree(trash)
      .then(() => { state.trash.delete(trash); })
      .catch((error) => {
        // Fica como lixeira de um pid que um dia morre: a varredura tenta de novo.
        state.trash.delete(trash);
        this.log(`não consegui apagar ${trash}: ${String(error)}`);
      });
    if (options.wait === true) await done;
    return true;
  }

  /**
   * Remove a pasta de uma sessão de forma totalmente SÍNCRONA. Nunca lança.
   * @param {string} key
   * @param {RemoveOptions} [options]
   * @returns {boolean}
   */
  removeSync(key, options = {}) {
    try {
      const trash = this.detach(key, options);
      if (trash === false) return false;
      if (trash === null) return true;
      try {
        this.verifyLayout();
        const result = removeTreeSync(trash, { scratchRoot: this.scratchRoot, uid: this.uid, mounts: this.mounts });
        if (!result.removed) this.log(`não consegui apagar ${trash}: ${result.reason ?? ''}`);
      } finally {
        processState().trash.delete(trash);
      }
      return true;
    } catch (error) {
      this.log(`não consegui remover ${key}: ${String(error)}`);
      return false;
    }
  }

  /**
   * Apaga o marcador só se ainda for o mesmo visto antes.
   * @param {string} file
   * @param {{ marker: import('./owner.js').OwnerMarker|null, mtimeMs: number|null }} seen
   */
  dropMarkerIf(file, seen) {
    if (seen.marker === null) return;
    const now = readMarkerSync(file);
    if (sameMarker(now, seen)) {
      try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
    }
  }
}

/**
 * Parte RÁPIDA da limpeza das pastas deste processo: cada pasta cujo
 * marcador ainda é deste processo é renomeada para `.trash-<pid>-<rand>`
 * (atômico, O(1)) e o marcador sai. Revalida a cadeia e recusa pasta com
 * ponto de montagem dentro antes de cada rename. Uma pasta PARTILHADA por
 * outro processo vivo não sai: o marcador passa para ele (`handedOver`). Uma
 * pasta que este processo só partilhava perde só o registro `.share` dele.
 * Usada pelo disposer no
 * SIGTERM/SIGINT, que roda DENTRO do teto de 5 s do shutdown do DSH, e pelo
 * `exit`. Se o processo morrer antes do rm, a lixeira de pid morto é apagada
 * pela próxima varredura. Nunca lança.
 * @returns {{ detached: string[], skipped: string[], handedOver: string[] }}
 */
export function detachOwnSync() {
  const state = processState();
  /** @type {{ detached: string[], skipped: string[], handedOver: string[] }} */
  const report = { detached: [], skipped: [], handedOver: [] };
  for (const [dir, info] of [...state.dirs]) {
    try {
      assertInside(info.scratchRoot, dir);
      info.verify();
      const seen = readMarkerSync(info.markerPath);
      if (!isSelf(seen.marker, info.self)) { info.dropSharer?.(); state.dirs.delete(dir); report.skipped.push(dir); continue; }
      if (info.handOver?.() === true) { state.dirs.delete(dir); report.handedOver.push(dir); continue; }
      const st = fs.lstatSync(dir, { throwIfNoEntry: false });
      if (st !== undefined && st.isDirectory() && !st.isSymbolicLink()) {
        if (mountsAtOrBelow(dir).length > 0) { state.dirs.delete(dir); report.skipped.push(dir); continue; }
        const trash = path.join(path.dirname(dir), `.trash-${process.pid}-${randomBytes(6).toString('hex')}`);
        fs.renameSync(dir, trash);
        state.trash.set(trash, { scratchRoot: info.scratchRoot, uid: info.uid, verify: info.verify });
      }
      const again = readMarkerSync(info.markerPath);
      if (sameMarker(seen, again)) fs.rmSync(info.markerPath, { force: true });
      info.dropAliases?.(); // a pasta já saiu do lugar: o apelido ficaria pendurado (?.: DirInfo de uma instância antiga, HMR)
      info.dropSharer?.(); // herdou o marcador de quem saiu antes e não tocou desde então: o registro .share dele sobrou
      state.dirs.delete(dir);
      report.detached.push(dir);
    } catch {
      report.skipped.push(dir);
    }
  }
  return report;
}

/**
 * Limpeza SÍNCRONA completa (evento `exit`): {@link detachOwnSync} e depois a
 * remoção segura das lixeiras pendentes deste processo, com o prazo
 * (`budgetMs`) conferido antes de CADA operação de disco — uma árvore enorme
 * não segura a saída. O que sobrar fica para a varredura. Nunca lança.
 * @param {{ budgetMs?: number, now?: () => number }} [options]
 * @returns {{ removed: string[], skipped: string[], handedOver: string[], trashLeft: number, timedOut: boolean }}
 */
export function cleanupOwnSync(options = {}) {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? EXIT_BUDGET_MS);
  const state = processState();
  const { detached, skipped, handedOver } = detachOwnSync();
  let timedOut = false;
  for (const [trash, info] of [...state.trash]) {
    if (now() > deadline) { timedOut = true; break; }
    try {
      info.verify();
      const result = removeTreeSync(trash, { scratchRoot: info.scratchRoot, uid: info.uid, deadline, now });
      if (result.removed) state.trash.delete(trash);
      if (result.timedOut === true) { timedOut = true; break; }
    } catch { /* fica para a varredura */ }
  }
  return { removed: detached, skipped, handedOver, trashLeft: state.trash.size, timedOut };
}

/**
 * Instala UMA vez por processo o listener de `exit` que chama
 * {@link cleanupOwnSync}. `exit` dispara na saída natural (headless), em
 * `process.exit` (shutdown com teto de 5 s do DSH) e depois de SIGTERM/SIGINT;
 * não dispara em SIGKILL/crash — aí a varredura de outro processo resolve.
 */
export function installExitCleanup() {
  const state = processState();
  if (state.exitInstalled) return;
  state.exitInstalled = true;
  process.on('exit', (code) => {
    try {
      const report = cleanupOwnSync();
      state.trace?.('exit-cleanup', { code, ...report });
    } catch { /* nunca atrapalha a saída */ }
  });
}
