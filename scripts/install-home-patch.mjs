#!/usr/bin/env node
// @ts-check
/**
 * Instala/verifica/remove a linha do dsh-session-scratch no patch de HOME
 * do DSH (`$DSH_HOME/cordis.patch.yml`, default `~/.dsh/cordis.patch.yml`),
 * que vale para TODOS os profiles (web, headless, dwg-share…) e tem
 * precedência sobre o patch de cada profile.
 *
 * O arquivo é editado como TEXTO, num bloco delimitado por marcadores, sem
 * reescrever nada do que já existe:
 *
 *   # >>> dsh-session-scratch … >>>
 *   - insert:
 *       - id: session-scratch
 *         name: "/abs/…/src/index.js"
 *         config: { …config completa reafirmada… }
 *   # <<< dsh-session-scratch <<<
 *
 * Regras do DSH respeitadas: arquivo vazio/só comentários quebra o boot (o
 * uninstall deixa `[]`); um `[]` existente é substituído pelo bloco; uma
 * lista em estilo bloco recebe o bloco no fim; qualquer outra forma é
 * recusada (merge manual). Uma linha `session-scratch` FORA do bloco também é
 * recusada (id duplicado colapsa em silêncio no Loader).
 *
 * Uso:
 *   node scripts/install-home-patch.mjs [--home DIR] [--dry-run|--check|--uninstall] [--verify] [--profiles a,b] [--dsh BIN] [--config JSON]
 *
 *   --dry-run    mostra o arquivo resultante, não escreve nada
 *   --check      sai 0 se o bloco está presente e atualizado, 1 se não
 *   --uninstall  remove o bloco (deixa `[]` se nada sobrar)
 *   --verify     roda `dsh --profile <p> --dump-config` (DSH_HOME=--home) e
 *                confere a linha UMA vez em cada profile
 *   --config     JSON parcial mesclado sobre os defaults (validado)
 *
 * Toda escrita faz backup `<arquivo>.bak-session-scratch-<data>` antes.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, resolveConfig } from '../src/config.js';

export const ENTRY_ID = 'session-scratch';
export const BEGIN = '# >>> dsh-session-scratch (gerenciado por scripts/install-home-patch.mjs) >>>';
export const END = '# <<< dsh-session-scratch <<<';
export const PLUGIN_ENTRY = fileURLToPath(new URL('../src/index.js', import.meta.url));
const DEFAULT_DSH_REPO = '/home/ondokai/Projects/deepseek-harness';

/**
 * Bloco YAML gerenciado. Escalares em JSON (subconjunto válido de YAML).
 * @param {string} pluginEntry caminho ABSOLUTO do src/index.js
 * @param {Readonly<import('../src/config.js').Config>} config
 */
export function renderBlock(pluginEntry, config) {
  if (!path.isAbsolute(pluginEntry)) throw new Error(`o caminho do plugin precisa ser absoluto: ${pluginEntry}`);
  const keys = /** @type {(keyof import('../src/config.js').Config)[]} */ (Object.keys(DEFAULTS));
  const lines = [
    BEGIN,
    '# Pasta de temporários privada por sessão + guarda de /tmp literal. Config',
    '# completa reafirmada (a linha é whole-entry replace, sem deep merge).',
    '- insert:',
    `    - id: ${ENTRY_ID}`,
    `      name: ${JSON.stringify(pluginEntry)}`,
    '      config:',
    ...keys.map((k) => `        ${k}: ${JSON.stringify(config[k])}`),
    END,
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Remove o bloco gerenciado (se houver).
 * @param {string} text
 * @returns {{ rest: string, block: string|null }}
 */
export function splitManaged(text) {
  const start = text.indexOf(BEGIN);
  if (start < 0) return { rest: text, block: null };
  const endIdx = text.indexOf(END, start);
  if (endIdx < 0) throw new Error('bloco gerenciado sem marcador de fim: corrija o arquivo à mão');
  let stop = endIdx + END.length;
  if (text[stop] === '\n') stop += 1;
  return { rest: text.slice(0, start) + text.slice(stop), block: text.slice(start, stop) };
}

/**
 * Linhas significativas (sem comentários/brancos).
 * @param {string} text
 */
function meaningful(text) {
  return text.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
}

/**
 * Compõe o novo conteúdo do patch de home.
 * @param {string|null} current conteúdo atual (null = arquivo ausente)
 * @param {string} block
 * @returns {string}
 */
export function composeInstall(current, block) {
  if (current === null) {
    return [
      '# Patch de HOME do DSH: aplicado a TODOS os profiles depois do patch de cada',
      '# profile (precedência maior). Lista YAML de entradas de patch do Loader;',
      '# arquivo vazio quebra o boot — use [] para "sem patches".',
      block,
    ].join('\n');
  }
  const { rest } = splitManaged(current);
  if (/^\s*-\s+id:\s*["']?session-scratch["']?\s*$/m.test(rest) || /^\s*id:\s*["']?session-scratch["']?\s*$/m.test(rest)) {
    throw new Error('já existe uma linha "session-scratch" fora do bloco gerenciado: remova-a ou integre à mão (id duplicado colapsa em silêncio)');
  }
  const body = meaningful(rest);
  if (body.length === 0 || (body.length === 1 && body[0].trim() === '[]')) {
    const kept = rest.split('\n').filter((l) => l.trim() !== '[]').join('\n').replace(/\n+$/, '');
    return kept.length > 0 ? `${kept}\n${block}` : block;
  }
  if (!body[0].startsWith('- ') && body[0] !== '-') {
    throw new Error('o patch de home não é uma lista YAML em estilo bloco (`- ...`): integre a linha à mão');
  }
  const trimmed = rest.replace(/\n+$/, '');
  return `${trimmed}\n${block}`;
}

/**
 * Compõe o conteúdo depois do uninstall.
 * @param {string} current
 */
export function composeUninstall(current) {
  const { rest, block } = splitManaged(current);
  if (block === null) return current;
  if (meaningful(rest).length === 0) {
    const kept = rest.replace(/\n+$/, '');
    return `${kept.length > 0 ? `${kept}\n` : ''}[]\n`;
  }
  return rest;
}

/**
 * Valida o YAML com o js-yaml do próprio DSH (o mesmo parser do boot), se
 * disponível; devolve as entradas com o nosso id.
 * @param {string} text
 * @param {string} dshRepo
 * @returns {{ parsed: boolean, entries: unknown[] }}
 */
export function validateYaml(text, dshRepo = DEFAULT_DSH_REPO) {
  let yaml;
  try {
    const req = createRequire(path.join(dshRepo, 'packages', 'boot', 'app-boot', 'package.json'));
    yaml = req('js-yaml');
  } catch {
    return { parsed: false, entries: [] };
  }
  const doc = yaml.load(text);
  if (!Array.isArray(doc)) throw new Error('o patch resultante não é uma lista YAML de topo (o DSH recusaria no boot)');
  /** @type {unknown[]} */
  const entries = [];
  for (const item of doc) {
    const insert = item && typeof item === 'object' ? /** @type {any} */ (item).insert : undefined;
    if (Array.isArray(insert)) for (const e of insert) if (e && e.id === ENTRY_ID) entries.push(e);
  }
  return { parsed: true, entries };
}

/** @param {Date} d */
function stamp(d) {
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Roda `dsh --profile <p> --dump-config` e conta a linha do plugin.
 * @param {{ dsh: string, home: string, profile: string, pluginEntry: string }} o
 */
export function verifyProfile(o) {
  const r = spawnSync(o.dsh, ['--profile', o.profile, '--dump-config'], {
    env: { ...process.env, DSH_HOME: o.home },
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) return { ok: false, count: 0, detail: `exit ${r.status}: ${(r.stderr || r.error?.message || '').trim().slice(0, 400)}` };
  const lines = r.stdout.split('\n');
  let count = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*-\s+id:\s*session-scratch\s*$/.test(lines[i] ?? '')) {
      count += 1;
      const nameLine = lines[i + 1] ?? '';
      if (!nameLine.includes(`file://${o.pluginEntry}`)) return { ok: false, count, detail: `linha encontrada mas name inesperado: ${nameLine.trim()}` };
    }
  }
  return { ok: count === 1, count, detail: count === 1 ? 'linha presente uma vez' : `linha encontrada ${count} vez(es)` };
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ home: string, mode: 'install'|'dry-run'|'check'|'uninstall', verify: boolean, profiles: string[]|null, dsh: string, config: unknown, plugin: string, dshRepo: string }} */
  const o = {
    home: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    mode: 'install',
    verify: false,
    profiles: null,
    dsh: 'dsh',
    config: undefined,
    plugin: PLUGIN_ENTRY,
    dshRepo: process.env.DSH_REPO || DEFAULT_DSH_REPO,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} precisa de um valor`);
      i += 1;
      return v;
    };
    if (a === '--home') o.home = path.resolve(val());
    else if (a === '--dry-run') o.mode = 'dry-run';
    else if (a === '--check') o.mode = 'check';
    else if (a === '--uninstall') o.mode = 'uninstall';
    else if (a === '--verify') o.verify = true;
    else if (a === '--profiles') o.profiles = val().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--dsh') o.dsh = val();
    else if (a === '--config') o.config = JSON.parse(val());
    else if (a === '--plugin') o.plugin = path.resolve(val());
    else if (a === '--dsh-repo') o.dshRepo = path.resolve(val());
    else if (a === '-h' || a === '--help') {
      process.stdout.write(`${fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 34).join('\n')}\n`);
      process.exit(0);
    } else throw new Error(`argumento desconhecido: ${a}`);
  }
  return o;
}

/** @param {string[]} argv */
export function main(argv) {
  const o = parseArgs(argv);
  const config = resolveConfig(o.config);
  const file = path.join(o.home, 'cordis.patch.yml');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const block = renderBlock(o.plugin, config);
  /** @param {string} m */
  const say = (m) => process.stdout.write(`${m}\n`);
  let code = 0;

  if (o.mode === 'check') {
    const managed = current === null ? null : splitManaged(current).block;
    if (managed === null) { say(`AUSENTE: ${file} não tem o bloco do dsh-session-scratch`); code = 1; }
    else if (managed !== block) { say(`DESATUALIZADO: o bloco em ${file} difere do esperado (rode sem --check para atualizar)`); code = 1; }
    else say(`OK: bloco presente e atualizado em ${file}`);
  } else if (o.mode === 'uninstall') {
    if (current === null) say(`nada a fazer: ${file} não existe`);
    else {
      const next = composeUninstall(current);
      if (next === current) say(`nada a fazer: ${file} não tem o bloco`);
      else {
        const v = validateYaml(next, o.dshRepo);
        const backup = `${file}.bak-session-scratch-${stamp(new Date())}`;
        fs.copyFileSync(file, backup);
        fs.writeFileSync(file, next, { mode: 0o600 });
        say(`removido de ${file} (backup ${backup})${v.parsed ? '; YAML validado com o js-yaml do DSH' : ''}`);
      }
    }
  } else {
    const next = composeInstall(current, block);
    const v = validateYaml(next, o.dshRepo);
    if (v.parsed && v.entries.length !== 1) throw new Error(`esperava 1 linha session-scratch no resultado, achei ${v.entries.length}`);
    if (o.mode === 'dry-run') {
      say(`# --dry-run: ${file} ficaria assim (${current === null ? 'arquivo novo' : 'arquivo existente'}; ${v.parsed ? 'YAML validado com o js-yaml do DSH' : 'js-yaml do DSH indisponível: sem validação de parse'}):`);
      process.stdout.write(next);
    } else if (current === next) {
      say(`já atualizado: ${file}`);
    } else {
      fs.mkdirSync(o.home, { recursive: true, mode: 0o700 });
      let backup = '';
      if (current !== null) {
        backup = `${file}.bak-session-scratch-${stamp(new Date())}`;
        fs.copyFileSync(file, backup);
      }
      fs.writeFileSync(file, next, { mode: 0o600 });
      say(`instalado em ${file}${backup ? ` (backup ${backup})` : ''}${v.parsed ? '; YAML validado com o js-yaml do DSH' : ''}`);
    }
  }

  // Aviso: a rota bundle (dsh plugin add) em algum profile + a rota home = mesma id duas vezes.
  try {
    for (const p of fs.readdirSync(path.join(o.home, 'profiles'))) {
      const pkg = path.join(o.home, 'profiles', p, 'package.json');
      if (fs.existsSync(pkg) && fs.readFileSync(pkg, 'utf8').includes('dsh-session-scratch')) {
        say(`AVISO: o profile ${p} também instala dsh-session-scratch como bundle; use UMA rota só (dsh plugin --profile ${p} remove dsh-session-scratch).`);
      }
    }
  } catch { /* sem profiles */ }

  if (o.verify && o.mode !== 'dry-run') {
    const profiles = o.profiles ?? (() => {
      try { return fs.readdirSync(path.join(o.home, 'profiles')).filter((p) => fs.statSync(path.join(o.home, 'profiles', p)).isDirectory()); } catch { return []; }
    })();
    const expectPresent = o.mode !== 'uninstall';
    for (const profile of profiles) {
      const r = verifyProfile({ dsh: o.dsh, home: o.home, profile, pluginEntry: o.plugin });
      const good = expectPresent ? r.ok : r.count === 0 && !r.detail.startsWith('exit');
      say(`${good ? 'OK ' : 'FALHA'} profile ${profile}: ${r.detail}`);
      if (!good) code = 1;
    }
  }
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`install-home-patch: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
