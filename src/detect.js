// @ts-check
/**
 * Detector puro de `/tmp` literal — mesmo contrato do hook PreToolUse da
 * tmpdir-agent-skill (Claude Code), para que os dois lados concordem caso a
 * caso:
 *
 * - comando de shell: um acerto é `/tmp` no INÍCIO de um token de caminho,
 *   regex (multiline) `(?:^|[\s'"`=:;|&(<>{,])/tmp(?=$|[/\s'"`;|&)<>},])`;
 * - caminho de ferramenta de arquivo: acerto quando o caminho resolve para
 *   `/tmp` ou para algo sob `/tmp/`;
 * - em ambos, ocorrências sob os prefixos permitidos (`/tmp/.X11-unix`,
 *   `/tmp/.ICE-unix`) são ignoradas; no comando, o token que começa em `/tmp`
 *   (até o próximo `[\s'"`;|&)<>},]`) é NORMALIZADO antes desse teste, de modo
 *   que `/tmp/.X11-unix/../x` acerta e `/tmp//.X11-unix` não (igual ao
 *   `posixpath.normpath` do lado Python);
 * - num comando, o marcador de escape (`allow-literal-tmp`) em qualquer
 *   posição desliga o detector.
 *
 * Tempo LINEAR no tamanho do comando (a guarda roda síncrona em todo bash do
 * host): os acertos de um mesmo token longo (`a=/tmp/x:/tmp/y:…`) partilham o
 * fim do token, e a normalização de cada um é composta da direita para a
 * esquerda em vez de refeita do zero.
 *
 * Sem I/O: só funções puras sobre strings.
 * @module dsh-session-scratch/detect
 */

import path from 'node:path';

/** O padrão do contrato, como fonte (o `g` é recriado a cada uso). */
export const LITERAL_TMP_SOURCE = String.raw`(?:^|[\s'"\x60=:;|&(<>{,])\/tmp(?=$|[\/\s'"\x60;|&)<>},])`;

/** Caracteres que terminam um token de caminho depois de `/tmp`. */
const TOKEN_END = /[\s'"`;|&)<>},]/;

/** Prefixos permitidos por omissão (sockets X11/ICE do sistema). */
export const DEFAULT_ALLOW_PREFIXES = Object.freeze(['/tmp/.X11-unix', '/tmp/.ICE-unix']);

/** Marcador de escape por omissão. */
export const DEFAULT_ESCAPE_MARKER = 'allow-literal-tmp';

/**
 * @typedef {object} DetectOptions
 * @property {readonly string[]} [allowPrefixes] prefixos sob /tmp que não contam
 * @property {string} [escapeMarker] texto que, presente no comando, desliga o detector
 */

/**
 * `true` quando `p` é exatamente um dos prefixos ou está sob ele.
 * @param {string} p caminho normalizado
 * @param {readonly string[]} prefixes
 */
function underAllowedPrefix(p, prefixes) {
  for (const raw of prefixes) {
    const prefix = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    if (p === prefix || p.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

/**
 * Segmentos normalizados de um caminho absoluto (`/a//./b/` → `['a','b']`).
 * @param {string} p
 * @returns {string[]}
 */
function absoluteSegments(p) {
  return path.posix.normalize(p).split('/').filter((s) => s.length > 0);
}

/**
 * Resumo da normalização RELATIVA de um trecho de caminho: `up` = quantos
 * `..` sobram sem par à esquerda; `len` = segmentos que ficam; `head` = os
 * primeiros `k` deles (só isso importa para o teste de prefixo).
 * @typedef {{ up: number, len: number, head: string[] }} Summary
 */

/**
 * Pilha completa de um trecho (custo linear no trecho).
 * @param {string} text
 * @returns {{ up: number, stack: string[] }}
 */
function chunkStack(text) {
  let up = 0;
  /** @type {string[]} */
  const stack = [];
  for (const seg of text.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (stack.length > 0) stack.pop();
      else up += 1;
    } else {
      stack.push(seg);
    }
  }
  return { up, stack };
}

/**
 * Compõe `chunk` (à esquerda, completo) com `rest` (à direita, resumido).
 * @param {{ up: number, stack: string[] }} chunk
 * @param {Summary} rest
 * @param {number} k
 * @returns {Summary}
 */
function compose(chunk, rest, k) {
  if (rest.up <= chunk.stack.length) {
    const kept = chunk.stack.length - rest.up;
    const head = chunk.stack.slice(0, Math.min(kept, k));
    for (let i = 0; head.length < k && i < rest.head.length; i += 1) head.push(/** @type {string} */ (rest.head[i]));
    return { up: chunk.up, len: kept + rest.len, head };
  }
  return { up: chunk.up + rest.up - chunk.stack.length, len: rest.len, head: rest.head };
}

/**
 * @typedef {{ index: number, end: number }} RawHit posição de `/tmp` e fim do token
 */

/**
 * Núcleo linear: os acertos NÃO permitidos, em ordem. Com `stopAtFirst`
 * devolve no máximo um (a guarda só precisa de um booleano).
 * @param {unknown} command
 * @param {DetectOptions} options
 * @param {boolean} stopAtFirst
 * @returns {RawHit[]}
 */
function scan(command, options, stopAtFirst) {
  if (typeof command !== 'string' || command.length === 0 || !command.includes('/tmp')) return [];
  const marker = options.escapeMarker ?? DEFAULT_ESCAPE_MARKER;
  if (marker.length > 0 && command.includes(marker)) return [];
  const prefixes = (options.allowPrefixes ?? DEFAULT_ALLOW_PREFIXES).map(absoluteSegments);
  const k = prefixes.reduce((m, p) => Math.max(m, p.length), 0);

  // 1. Todos os acertos do regex e o fim do token de cada um. Acertos em
  //    ordem crescente: se o novo começa antes do fim do token anterior, o
  //    fim é o mesmo (não há terminador entre eles) — custo total O(n).
  /** @type {RawHit[]} */
  const raw = [];
  const re = new RegExp(LITERAL_TMP_SOURCE, 'gm');
  let runEnd = -1;
  for (let m = re.exec(command); m !== null; m = re.exec(command)) {
    // O grupo de abertura consome 0 ou 1 caractere; `/tmp` é o fim do match.
    const index = m.index + m[0].length - 4;
    if (index >= runEnd) {
      runEnd = index + 4;
      while (runEnd < command.length && !TOKEN_END.test(command[runEnd] ?? '')) runEnd += 1;
    }
    raw.push({ index, end: runEnd });
    // `/tmp,/tmp`: recua para o delimitador partilhado não ficar consumido.
    re.lastIndex = index + 4;
  }
  if (raw.length === 0) return [];

  // 2. Por token (run), da direita para a esquerda: resumo da normalização do
  //    sufixo que começa em cada acerto = trecho até o próximo acerto ∘ resumo
  //    do próximo. Os trechos são disjuntos: custo total O(n).
  /** @type {boolean[]} */
  const allowed = new Array(raw.length).fill(false);
  /** @type {Summary|null} */
  let next = null;
  for (let i = raw.length - 1; i >= 0; i -= 1) {
    const hit = /** @type {RawHit} */ (raw[i]);
    const following = raw[i + 1];
    const sameRun = following !== undefined && following.end === hit.end;
    const chunk = chunkStack(command.slice(hit.index, sameRun ? following.index : hit.end));
    /** @type {Summary} */
    const summary = sameRun && next !== null
      ? compose(chunk, next, k)
      : { up: chunk.up, len: chunk.stack.length, head: chunk.stack.slice(0, k) };
    next = summary;
    // O token é absoluto: `..` sobrando na raiz somem, a pilha é o caminho.
    allowed[i] = prefixes.some((p) => p.length > 0 && summary.len >= p.length && p.every((seg, j) => summary.head[j] === seg));
  }
  /** @type {RawHit[]} */
  const hits = [];
  for (let i = 0; i < raw.length; i += 1) {
    if (allowed[i]) continue;
    hits.push(/** @type {RawHit} */ (raw[i]));
    if (stopAtFirst) break;
  }
  return hits;
}

/**
 * Todos os acertos de `/tmp` literal num comando de shell (diagnóstico; a
 * guarda usa {@link commandUsesLiteralTmp}).
 * @param {unknown} command texto do comando (qualquer coisa que não seja string não acerta)
 * @param {DetectOptions} [options]
 * @returns {{ index: number, token: string }[]} posição de cada `/tmp` e o token de caminho que começa nela
 */
export function findLiteralTmp(command, options = {}) {
  const text = typeof command === 'string' ? command : '';
  return scan(command, options, false).map((h) => ({ index: h.index, token: text.slice(h.index, h.end) }));
}

/**
 * `true` quando o comando usa `/tmp` literal (fora dos prefixos permitidos e
 * sem o marcador de escape). Linear no tamanho do comando.
 * @param {unknown} command
 * @param {DetectOptions} [options]
 */
export function commandUsesLiteralTmp(command, options = {}) {
  return scan(command, options, true).length > 0;
}

/**
 * `true` quando um caminho de ferramenta de arquivo resolve para `/tmp` ou
 * para algo sob `/tmp/` (fora dos prefixos permitidos). Caminhos relativos
 * resolvem contra `cwd` (o cwd da sessão); sem `cwd` um relativo nunca acerta.
 * `~` não é expandido pelas ferramentas do DSH, logo `~/tmp` não acerta.
 * `exemptPrefixes`: a própria árvore de scratch quando o host-tmp fica sob
 * /tmp (TMPDIR ausente no DSH) — senão o remédio do deny ("use o caminho de
 * `echo "$TMPDIR"`") seria negado de novo (mesma isenção do `_scratch_exempt`
 * da skill).
 * @param {unknown} filePath
 * @param {{ cwd?: string, allowPrefixes?: readonly string[], exemptPrefixes?: readonly string[] }} [options]
 */
export function pathIsUnderTmp(filePath, options = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  let resolved;
  if (filePath.startsWith('/')) resolved = path.posix.resolve(filePath);
  else if (typeof options.cwd === 'string' && options.cwd.startsWith('/')) resolved = path.posix.resolve(options.cwd, filePath);
  else return false;
  if (resolved !== '/tmp' && !resolved.startsWith('/tmp/')) return false;
  if (underAllowedPrefix(resolved, options.exemptPrefixes ?? [])) return false;
  return !underAllowedPrefix(resolved, options.allowPrefixes ?? DEFAULT_ALLOW_PREFIXES);
}

/**
 * Isenções de caminho (file_path/workdir) para a própria árvore de scratch:
 * só quando ela fica sob /tmp (DSH sem TMPDIR → host-tmp = /tmp). Mesma regra
 * do `_scratch_exempt` da skill.
 * @param {string} scratchRoot `<host-tmp>/agent-scratch`
 * @returns {string[]}
 */
export function scratchExemptPrefixes(scratchRoot) {
  const root = path.posix.normalize(scratchRoot);
  return root.startsWith('/tmp/') ? [root.replace(/\/+$/, '')] : [];
}

/**
 * @typedef {object} GuardPolicy
 * @property {readonly string[]} guardTools ferramentas cujo `arguments.command` é shell (e `arguments.workdir` um caminho)
 * @property {readonly string[]} fileTools ferramentas cujo `arguments.file_path` (ou `path`) é um caminho
 * @property {readonly string[]} allowPrefixes
 * @property {string} escapeMarker
 * @property {readonly string[]} [exemptPrefixes] caminhos (sob /tmp) isentos para file_path/workdir
 */

/**
 * Classifica uma chamada de ferramenta contra a política.
 * @param {string} toolName nome real da ferramenta (`bash`, `write`, `edit`…)
 * @param {unknown} args argumentos já parseados (congelados pelo DSH)
 * @param {GuardPolicy} policy
 * @param {string} [cwd] cwd da sessão, para caminhos relativos
 * @returns {'shell'|'workdir'|'file'|null} o tipo de acerto, ou null quando não há /tmp literal
 */
export function classifyToolCall(toolName, args, policy, cwd) {
  if (args === null || typeof args !== 'object') return null;
  const a = /** @type {Record<string, unknown>} */ (args);
  const opts = { allowPrefixes: policy.allowPrefixes, escapeMarker: policy.escapeMarker };
  const pathOpts = { cwd, allowPrefixes: policy.allowPrefixes, exemptPrefixes: policy.exemptPrefixes ?? [] };
  if (policy.guardTools.includes(toolName)) {
    if (commandUsesLiteralTmp(a.command, opts)) return 'shell';
    const marker = policy.escapeMarker;
    const escaped = typeof a.command === 'string' && marker.length > 0 && a.command.includes(marker);
    if (!escaped && pathIsUnderTmp(a.workdir, pathOpts)) return 'workdir';
    return null;
  }
  if (policy.fileTools.includes(toolName)) {
    const target = typeof a.file_path === 'string' ? a.file_path : a.path;
    // `str_replace_editor` partilha o campo `command` mas só `view` é leitura.
    if (a.command === 'view') return null;
    if (pathIsUnderTmp(target, pathOpts)) return 'file';
  }
  return null;
}
