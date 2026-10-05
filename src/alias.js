// @ts-check
/**
 * Apelido CURTO da pasta da sessão, para sockets AF_UNIX (`sun_path` aceita
 * 107 bytes). A pasta canônica do contrato fica onde sempre esteve,
 * `<host-tmp>/agent-scratch/dsh/<key>` (81 bytes aqui, com a chave
 * `session-<uuid>`); o TMPDIR EXPORTADO passa a ser o symlink
 * `<host-tmp>/agent-scratch/dsh/.s/<hash>` → `../<key>` (48 bytes aqui). O
 * Chromium põe o `SingletonSocket` em TMPDIR + ~46 bytes e o forkserver do
 * Python em TMPDIR + 32: com o caminho canônico o Chromium morre ("Socket path
 * too long") e o Python cai em silêncio para o `/tmp` literal.
 *
 * Mesmo esquema do hook da tmpdir-agent-skill (`agent-scratch/claude/.s/<hash8>`
 * → `../<sid>`): `<hash>` = os primeiros 8 hex do sha256 da chave, alvo
 * RELATIVO `../<key>`, só quando a pasta passa de {@link MAX_TMPDIR_BYTES} e o
 * apelido é mais curto que ela.
 *
 * Invariantes:
 * - nunca reaponta um apelido existente: um nome ocupado por outra coisa
 *   (apelido de outra sessão, arquivo, pasta) é pulado e o próximo candidato
 *   (hash mais longo: 10, 12, 14, 16 hex) é tentado; esgotados, o hook exporta
 *   o caminho canônico (que funciona, só sem a folga para sockets);
 * - publicação atômica e SEM substituição: symlink temporário em `.s/` +
 *   `link(2)` para o nome final (falha com EEXIST se alguém chegou antes — o
 *   `rename(2)` substituiria em silêncio o apelido de outra sessão; o Node não
 *   expõe `renameat2(RENAME_NOREPLACE)`); onde `link` de symlink não existe,
 *   `symlink(2)` direto no nome final (também atômico e com EEXIST);
 * - um apelido só é "desta sessão" se é symlink do euid com o texto exato
 *   `../<key>` dentro de um `.s` REAL do euid: a verificação é léxica, nunca
 *   segue o link;
 * - `.s` é fixado pela identidade (dev/ino) no início de cada criação e
 *   reconferido antes de cada publicação e depois dela: trocado no meio (por
 *   symlink ou outra pasta), o apelido não é usado (o hook exporta a
 *   canônica). Sem `openat`/`linkat` no Node, a janela entre a conferência e
 *   a syscall continua existindo (microssegundos, síncrona);
 * - remoção = `unlink` do próprio link (nunca segue, nunca apaga através
 *   dele), decidida de novo, de forma SÍNCRONA, imediatamente antes do
 *   `unlink`: `.s` real do euid, o link ainda é `../<key>` (e o mesmo inode,
 *   quando o chamador o viu antes) e a pasta canônica continua ausente. Se a
 *   pasta reaparece logo depois (retomada concorrente), o apelido é
 *   republicado na hora.
 * @module dsh-session-scratch/alias
 */

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureTrustedDir, isValidKey } from './paths.js';

/** Pasta dos apelidos dentro da base (`.s`, como no lado do Claude Code). */
export const ALIAS_DIRNAME = '.s';

/**
 * Acima disto (bytes) o TMPDIR exportado é o apelido. Igual ao
 * `MAX_TMPDIR_BYTES` da skill: 60 + 46 (Chromium) ainda cabe em 107.
 */
export const MAX_TMPDIR_BYTES = 60;

/** Tamanhos de hash tentados, em ordem (8 = o da skill; os demais só em colisão). */
export const ALIAS_HASH_LENGTHS = Object.freeze([8, 10, 12, 14, 16]);

/** Nome do symlink temporário de uma publicação: `.tmp-<pid>-<hex>`. */
export const ALIAS_TEMP_PATTERN = /^\.tmp-(\d+)-[0-9a-f]+$/;

/**
 * @param {unknown} error
 * @returns {string|undefined}
 */
function codeOf(error) {
  return /** @type {NodeJS.ErrnoException} */ (error)?.code;
}

/**
 * sha256 da chave em hex (o mesmo `hashlib.sha256(sid.encode()).hexdigest()` da skill).
 * @param {string} key
 */
export function aliasHash(key) {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * Texto do symlink: relativo à pasta `.s`, logo resolve para `<base>/<key>`.
 * @param {string} key
 */
export function aliasTarget(key) {
  return `../${key}`;
}

/**
 * @typedef {object} AliasOptions
 * @property {number} [uid] euid esperado (-1 = não confere)
 * @property {(key: string) => string} [hashOf] hash hex da chave (injetável nos testes para forçar colisões)
 * @property {(msg: string) => void} [log]
 * @property {(existing: string, created: string) => void} [link] publicação sem substituição (injetável nos testes; default `fs.linkSync`)
 * @property {(candidate: string) => void} [beforePublish] gancho de teste entre o symlink temporário e a publicação
 */

/**
 * Caminhos candidatos do apelido, do mais curto ao mais longo, todos MAIS
 * CURTOS (em bytes) que a pasta canônica.
 * @param {string} base `<host-tmp>/agent-scratch/dsh`
 * @param {string} key chave já sanitizada
 * @param {AliasOptions} [options]
 * @returns {string[]}
 */
export function aliasCandidates(base, key, options = {}) {
  const digest = (options.hashOf ?? aliasHash)(key);
  const canonical = Buffer.byteLength(path.join(base, key));
  /** @type {string[]} */
  const out = [];
  for (const n of ALIAS_HASH_LENGTHS) {
    if (digest.length < n) break;
    const candidate = path.join(base, ALIAS_DIRNAME, digest.slice(0, n));
    if (Buffer.byteLength(candidate) < canonical) out.push(candidate);
  }
  return out;
}

/**
 * `true` quando a pasta canônica passa de {@link MAX_TMPDIR_BYTES} e há um
 * apelido mais curto que ela (o `needs_alias` da skill).
 * @param {string} base
 * @param {string} key
 * @param {AliasOptions} [options]
 */
export function needsAlias(base, key, options = {}) {
  return Buffer.byteLength(path.join(base, key)) > MAX_TMPDIR_BYTES && aliasCandidates(base, key, options).length > 0;
}

/**
 * `.s` como diretório REAL (lstat) do euid, ou `null`. Sem isso nada é
 * criado, usado nem desligado nele.
 * @param {string} dir
 * @param {number} uid
 * @returns {fs.Stats|null}
 */
function aliasDirStat(dir, uid) {
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  return st !== undefined && st.isDirectory() && !st.isSymbolicLink() && (uid < 0 || st.uid === uid) ? st : null;
}

/** `true` se existe a entrada (mesmo symlink pendurado). @param {string} p */
function lexists(p) {
  return fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined;
}

/**
 * `true` quando `candidate` é um apelido DESTA chave: symlink do euid cujo
 * texto é exatamente `../<key>`, dentro de um `.s` que é diretório real do
 * euid (um `.s` trocado por symlink resolveria `../<key>` noutro lugar).
 * Léxico: nunca segue o link.
 * @param {string} candidate
 * @param {string} key
 * @param {number} uid
 */
export function isOwnAlias(candidate, key, uid) {
  if (aliasDirStat(path.dirname(candidate), uid) === null) return false;
  const st = fs.lstatSync(candidate, { throwIfNoEntry: false });
  if (st === undefined || !st.isSymbolicLink() || (uid >= 0 && st.uid !== uid)) return false;
  try {
    return fs.readlinkSync(candidate) === aliasTarget(key);
  } catch {
    return false;
  }
}

/**
 * Publica `candidate` → `../<key>` sem nunca substituir o que já exista:
 * symlink temporário + link(2) (EEXIST se ocupado). Devolve `true` se este
 * processo criou o nome, `false` se ele já existia.
 * @param {string} candidate
 * @param {string} key
 * @param {AliasOptions} options
 */
function publish(candidate, key, options) {
  const dir = path.dirname(candidate);
  const temp = path.join(dir, `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  fs.symlinkSync(aliasTarget(key), temp);
  try {
    options.beforePublish?.(candidate);
    try {
      (options.link ?? fs.linkSync)(temp, candidate);
      return true;
    } catch (error) {
      const code = codeOf(error);
      if (code === 'EEXIST') return false;
      // Sistema de arquivos sem hard link de symlink: symlink(2) direto, que
      // também é atômico e também falha com EEXIST em vez de substituir.
      if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'EMLINK' && code !== 'EXDEV' && code !== 'ENOSYS') throw error;
      try {
        fs.symlinkSync(aliasTarget(key), candidate);
        return true;
      } catch (inner) {
        if (codeOf(inner) === 'EEXIST') return false;
        throw inner;
      }
    }
  } finally {
    try { fs.unlinkSync(temp); } catch { /* já saiu: nada a fazer */ }
  }
}

/**
 * Garante o apelido curto da chave e devolve o caminho dele, ou `null` quando
 * não precisa (caminho já curto), quando `.s` não é confiável ou quando todos
 * os candidatos estão ocupados por outra coisa (o hook exporta então o
 * caminho canônico). Estável: um apelido desta chave que já exista (de
 * qualquer tamanho) é reaproveitado antes de criar outro. Nunca lança.
 * @param {string} base `<host-tmp>/agent-scratch/dsh` (cadeia já validada pelo chamador)
 * @param {string} key chave já sanitizada
 * @param {AliasOptions} [options]
 * @returns {string|null}
 */
export function ensureAlias(base, key, options = {}) {
  const uid = options.uid ?? -1;
  const log = options.log ?? (() => {});
  try {
    if (!isValidKey(key) || !needsAlias(base, key, options)) return null;
    const candidates = aliasCandidates(base, key, options);
    const dir = path.join(base, ALIAS_DIRNAME);
    // `.s` fixado pela identidade: trocado no meio (symlink ou outra pasta), nada vale.
    const pinned = ensureTrustedDir(dir, { uid }).st;
    const samePinned = () => {
      const now = aliasDirStat(dir, uid);
      return now !== null && now.dev === pinned.dev && now.ino === pinned.ino;
    };
    const own = (/** @type {string} */ c) => isOwnAlias(c, key, uid) && samePinned();
    for (const c of candidates) if (own(c)) return c;
    for (const c of candidates) {
      if (!samePinned()) {
        log(`${dir} foi trocado durante a criação do apelido de ${key}; o TMPDIR fica no caminho canônico`);
        return null;
      }
      if (lexists(c)) {
        // Outro processo da MESMA sessão pode tê-lo criado depois da 1ª passada.
        if (own(c)) return c;
        log(`apelido ${c} ocupado por outra coisa (não é reapontado); tentando um hash mais longo`);
        continue;
      }
      publish(c, key, options);
      if (!samePinned()) {
        // O link pode ter ido parar noutro diretório: não é usado nem desligado por este caminho.
        log(`${dir} foi trocado durante a publicação de ${c}; o apelido não é usado`);
        return null;
      }
      // Criado agora, ou criado no mesmo instante por outro processo: só vale se é desta chave.
      if (own(c)) return c;
      log(`apelido ${c} foi criado por outra sessão no mesmo instante (não é reapontado); tentando um hash mais longo`);
    }
    log(`todos os apelidos curtos de ${key} estão ocupados; o TMPDIR fica no caminho canônico`);
    return null;
  } catch (error) {
    log(`sem apelido curto para ${key}: ${String(error)}`);
    return null;
  }
}

/**
 * @typedef {object} UnlinkOptions
 * @property {{ dev: number, ino: number }} [seen] identidade do link vista pelo chamador (outro inode = outro link: fica)
 * @property {() => boolean} [stillStale] reconferência SÍNCRONA das demais entradas da decisão do chamador (ex.: o dono do marcador continua não vivo)
 */

/**
 * Desliga UM apelido de `key`, decidindo de novo, de forma síncrona e
 * imediatamente antes do `unlink` (sem nenhum `await` no meio): `.s` é
 * diretório real do euid, `candidate` é symlink do euid com o texto exato
 * `../<key>` (e o inode `seen`, se dado), a pasta canônica `<base>/<key>`
 * continua AUSENTE e `stillStale()` (se dado) ainda vale. Depois do `unlink`,
 * se a pasta canônica reapareceu (retomada concorrente na janela entre a
 * última conferência e a syscall), republica o apelido na hora. Nunca segue
 * nem apaga através do link. Lança só em erro inesperado de disco.
 * @param {string} base
 * @param {string} key chave já sanitizada
 * @param {string} candidate caminho do link, dentro de `<base>/.s`
 * @param {AliasOptions & UnlinkOptions} [options]
 * @returns {boolean} `true` se este processo desligou o link
 */
export function unlinkStaleAlias(base, key, candidate, options = {}) {
  const uid = options.uid ?? -1;
  const dir = path.join(base, ALIAS_DIRNAME);
  if (!isValidKey(key) || path.dirname(candidate) !== dir) return false;
  if (aliasDirStat(dir, uid) === null) return false;
  const st = fs.lstatSync(candidate, { throwIfNoEntry: false });
  if (st === undefined || !st.isSymbolicLink() || (uid >= 0 && st.uid !== uid)) return false;
  if (options.seen !== undefined && (st.dev !== options.seen.dev || st.ino !== options.seen.ino)) return false;
  let text;
  try { text = fs.readlinkSync(candidate); } catch { return false; }
  if (text !== aliasTarget(key)) return false;
  const canonical = path.join(base, key);
  if (lexists(canonical)) return false;
  if (options.stillStale !== undefined && !options.stillStale()) return false;
  if (aliasDirStat(dir, uid) === null) return false;
  try {
    fs.unlinkSync(candidate);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return false; // corrida: outro processo já desligou
    throw error;
  }
  if (lexists(canonical)) {
    // A sessão foi retomada entre a conferência e o unlink: o apelido volta já.
    const again = ensureAlias(base, key, options);
    options.log?.(`${key} foi retomada durante a limpeza do apelido; republicado: ${again ?? '(sem apelido; o hook usa a canônica)'}`);
  }
  return true;
}

/**
 * Desliga os apelidos (todos os candidatos) de `key` que ainda apontam para
 * `../<key>`, cada um com a decisão refeita imediatamente antes do seu
 * `unlink` ({@link unlinkStaleAlias}): a pasta canônica tem de continuar
 * ausente — outro processo que a recriou no meio (retomada) continua usando
 * o apelido, e um apelido desligado na janela final é republicado. Nunca
 * segue nem apaga através do link. Nunca lança.
 * @param {string} base
 * @param {string} key
 * @param {AliasOptions & UnlinkOptions} [options]
 * @returns {string[]} apelidos desligados
 */
export function unlinkAliases(base, key, options = {}) {
  /** @type {string[]} */
  const removed = [];
  try {
    if (!isValidKey(key)) return removed;
    const dir = path.join(base, ALIAS_DIRNAME);
    const digest = (options.hashOf ?? aliasHash)(key);
    for (const n of ALIAS_HASH_LENGTHS) {
      if (digest.length < n) break;
      const candidate = path.join(dir, digest.slice(0, n));
      try {
        if (unlinkStaleAlias(base, key, candidate, options)) removed.push(candidate);
      } catch (error) {
        options.log?.(`apelido ${candidate}: ${String(error)}`);
      }
    }
  } catch (error) {
    options.log?.(`apelidos de ${key}: ${String(error)}`);
  }
  return removed;
}
