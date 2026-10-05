// @ts-check
/**
 * Defaults e validação fail-loud da config do plugin. `resolveConfig` lança
 * dentro de `apply()` — o Loader do DSH põe a fibra em FAILED, registra um
 * aviso e o boot continua sem o plugin (nunca um fallback permissivo).
 * @module dsh-session-scratch/config
 */

import { DEFAULT_ALLOW_PREFIXES, DEFAULT_ESCAPE_MARKER } from './detect.js';

/**
 * @typedef {'off'|'warn'|'deny'} GuardMode
 *
 * @typedef {object} Config
 * @property {string} baseDir raiz das pastas de sessão, RELATIVA à raiz temporária do host; `agent-scratch/dsh` (ou `agent-scratch/dsh-<x>`)
 * @property {boolean} exportTmpdir instala o hook BASH_ENV que aponta TMPDIR/TMP/TEMP para a pasta da sessão
 * @property {boolean} promptRule injeta a regra no system prompt
 * @property {GuardMode} guard `deny` bloqueia, `warn` anexa aviso, `off` desliga
 * @property {string[]} guardTools ferramentas de shell (inspeciona `command` e `workdir`)
 * @property {string[]} fileTools ferramentas de arquivo (inspeciona `file_path`/`path`)
 * @property {string} escapeMarker texto que libera /tmp quando o usuário pediu explicitamente
 * @property {string[]} allowPrefixes caminhos sob /tmp que nunca contam como acerto
 * @property {boolean} shareWithSubagents subagentes usam a pasta da sessão raiz
 * @property {number} idleDays pastas PRÓPRIAS sem atividade há mais que isso são apagadas
 * @property {number} orphanGraceMinutes pastas de dono morto mais novas que isso são mantidas
 * @property {number} sweepIntervalMinutes intervalo da varredura
 */

/** @type {Readonly<Config>} */
export const DEFAULTS = Object.freeze({
  baseDir: 'agent-scratch/dsh',
  exportTmpdir: true,
  promptRule: true,
  guard: /** @type {GuardMode} */ ('deny'),
  guardTools: ['bash'],
  fileTools: ['write', 'edit'],
  escapeMarker: DEFAULT_ESCAPE_MARKER,
  allowPrefixes: [...DEFAULT_ALLOW_PREFIXES],
  shareWithSubagents: true,
  idleDays: 3,
  orphanGraceMinutes: 30,
  sweepIntervalMinutes: 30,
});

const KEYS = new Set(Object.keys(DEFAULTS));
const TOOL_NAME = /^[A-Za-z0-9_.:-]+$/;

/**
 * @param {string} key
 * @param {string} message
 * @returns {never}
 */
function fail(key, message) {
  throw new TypeError(`dsh-session-scratch: config.${key} ${message}`);
}

/**
 * @param {string} key
 * @param {unknown} value
 */
function bool(key, value) {
  if (typeof value !== 'boolean') fail(key, `deve ser booleano, recebeu ${JSON.stringify(value)}`);
  return value;
}

/**
 * @param {string} key
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 */
function num(key, value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(key, `deve ser um número entre ${min} e ${max}, recebeu ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * @param {string} key
 * @param {unknown} value
 * @param {(item: string) => boolean} ok
 * @param {string} what
 */
function stringList(key, value, ok, what) {
  if (!Array.isArray(value)) fail(key, `deve ser uma lista, recebeu ${JSON.stringify(value)}`);
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string' || !ok(item)) fail(key, `contém ${JSON.stringify(item)}; esperado ${what}`);
    out.push(item);
  }
  return [...new Set(out)];
}

/** Nome da árvore do DSH sob agent-scratch/: `dsh` ou `dsh-<x>` / `dsh.<x>` / `dsh_<x>`. */
const DSH_TREE = /^dsh(?:[-._][A-Za-z0-9._-]+)?$/;

/**
 * `baseDir` é relativo à raiz temporária do host e é EXATAMENTE
 * `agent-scratch/dsh` (ou uma árvore irmã `agent-scratch/dsh-<x>`): o plugin
 * nunca apaga nada fora de `<host-tmp>/agent-scratch/`, e a varredura trata
 * toda pasta sem marcador DSH como órfã — apontá-la para a árvore de outro
 * harness (`agent-scratch/claude`) ou para DENTRO de outra árvore
 * (`agent-scratch/dsh/x`) apagaria sessões vivas alheias.
 * @param {unknown} value
 */
function baseDir(value) {
  if (typeof value !== 'string') fail('baseDir', `deve ser string, recebeu ${JSON.stringify(value)}`);
  const segments = value.replace(/\/+$/, '').split('/');
  const valid = !value.startsWith('/')
    && segments.length === 2
    && segments[0] === 'agent-scratch'
    && DSH_TREE.test(segments[1] ?? '');
  if (!valid) {
    fail('baseDir', `deve ser agent-scratch/dsh (ou agent-scratch/dsh-<nome>), relativo à raiz temporária do host; agent-scratch/claude e as demais árvores são de outros harnesses. Recebeu ${JSON.stringify(value)}`);
  }
  return segments.join('/');
}

/**
 * Mescla `raw` sobre os defaults e valida tudo. Chaves desconhecidas lançam
 * (pega erro de digitação no cordis.patch.yml em vez de ignorar em silêncio).
 * @param {unknown} raw config vinda do Loader (pode ser undefined/null)
 * @returns {Readonly<Config>}
 */
export function resolveConfig(raw) {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new TypeError(`dsh-session-scratch: config deve ser um objeto, recebeu ${JSON.stringify(raw)}`);
  }
  const input = /** @type {Record<string, unknown>} */ (raw ?? {});
  for (const key of Object.keys(input)) {
    if (!KEYS.has(key)) throw new TypeError(`dsh-session-scratch: chave de config desconhecida ${JSON.stringify(key)}`);
  }
  /** @type {Record<string, unknown>} */
  const merged = { ...DEFAULTS };
  for (const [key, value] of Object.entries(input)) if (value !== undefined) merged[key] = value;

  const guard = merged.guard;
  if (guard !== 'off' && guard !== 'warn' && guard !== 'deny') fail('guard', `deve ser off | warn | deny, recebeu ${JSON.stringify(guard)}`);

  const escapeMarker = merged.escapeMarker;
  if (typeof escapeMarker !== 'string' || escapeMarker.trim().length < 3 || escapeMarker.length > 64 || /[\r\n]/.test(escapeMarker)) {
    fail('escapeMarker', `deve ser texto de 3 a 64 caracteres sem quebra de linha, recebeu ${JSON.stringify(escapeMarker)}`);
  }

  /** @type {Config} */
  const config = {
    baseDir: baseDir(merged.baseDir),
    exportTmpdir: bool('exportTmpdir', merged.exportTmpdir),
    promptRule: bool('promptRule', merged.promptRule),
    guard,
    guardTools: stringList('guardTools', merged.guardTools, (s) => TOOL_NAME.test(s), 'nome de ferramenta'),
    fileTools: stringList('fileTools', merged.fileTools, (s) => TOOL_NAME.test(s), 'nome de ferramenta'),
    escapeMarker,
    allowPrefixes: stringList(
      'allowPrefixes', merged.allowPrefixes,
      (s) => /^\/tmp\/[^/]/.test(s) && !s.replace(/\/$/, '').includes('//') && !s.split('/').some((seg) => seg === '..' || seg === '.'),
      'caminho absoluto sob /tmp/ sem //, . ou ..',
    ),
    shareWithSubagents: bool('shareWithSubagents', merged.shareWithSubagents),
    idleDays: num('idleDays', merged.idleDays, 0.01, 365),
    orphanGraceMinutes: num('orphanGraceMinutes', merged.orphanGraceMinutes, 1, 60 * 24 * 30),
    sweepIntervalMinutes: num('sweepIntervalMinutes', merged.sweepIntervalMinutes, 1, 60 * 24),
  };
  return Object.freeze(config);
}
