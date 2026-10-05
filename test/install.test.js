// @ts-check
/**
 * Instalador do patch de home: lógica pura + CLI contra um DSH_HOME
 * TEMPORÁRIO (nunca o ~/.dsh real). Se o launcher `dsh` e os profiles reais
 * existirem, copia-os (só profiles/, ~1 MB, symlinks preservados) para o home
 * temporário e confere o resultado com `dsh --profile <p> --dump-config`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, resolveConfig } from '../src/config.js';
import {
  BEGIN, END, PLUGIN_ENTRY, composeInstall, composeUninstall, renderBlock, splitManaged, validateYaml,
} from '../scripts/install-home-patch.mjs';
import { rmrf, tempRoot } from './helpers.js';

const SCRIPT = fileURLToPath(new URL('../scripts/install-home-patch.mjs', import.meta.url));
const DSH_LAUNCHER = process.env.DSH_LAUNCHER ?? path.join(os.homedir(), '.local', 'bin', 'dsh');
const REAL_PROFILES = path.join(os.homedir(), '.dsh', 'profiles');
const PROFILES = ['web', 'headless', 'dwg-share'];
const block = renderBlock(PLUGIN_ENTRY, resolveConfig(undefined));

/**
 * Copia um profile reescrevendo symlinks RELATIVOS (pnpm `link:`) como
 * absolutos para o alvo original — a cópia continua resolvendo os bundles.
 * @param {string} src @param {string} dest
 */
function copyProfile(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) fs.symlinkSync(path.resolve(src, fs.readlinkSync(from)), to);
    else if (entry.isDirectory()) copyProfile(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

/** @param {string[]} args */
function cli(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('install-home-patch — composição pura', () => {
  it('arquivo ausente: cabeçalho + bloco', () => {
    const out = composeInstall(null, block);
    assert.equal(out.split(BEGIN).length, 2);
    assert.ok(out.endsWith(`${END}\n`));
  });
  it('`[]` (com comentários) é trocado pelo bloco e é idempotente', () => {
    const cur = '# comentário do usuário\n[]\n';
    const once = composeInstall(cur, block);
    assert.ok(once.startsWith('# comentário do usuário\n'));
    assert.ok(!/^\[\]$/m.test(once));
    assert.equal(composeInstall(once, block), once);
  });
  it('lista em estilo bloco recebe o bloco no fim, sem tocar no resto', () => {
    const cur = '- id: hmr\n  disabled: true\n';
    const out = composeInstall(cur, block);
    assert.ok(out.startsWith(cur));
    assert.equal(composeInstall(out, block), out);
  });
  it('atualiza um bloco antigo no lugar', () => {
    const old = composeInstall(null, renderBlock(PLUGIN_ENTRY, resolveConfig({ guard: 'warn' })));
    const out = composeInstall(old, block);
    assert.match(out, /guard: "deny"/);
    assert.equal(out.split(BEGIN).length, 2);
  });
  it('recusa lista flow não vazia e linha session-scratch fora do bloco', () => {
    assert.throws(() => composeInstall('[{id: x, disabled: true}]\n', block), /estilo bloco/);
    assert.throws(() => composeInstall('- insert:\n    - id: session-scratch\n      name: /x.js\n', block), /fora do bloco/);
  });
  it('uninstall deixa `[]` quando nada sobra e preserva outras linhas', () => {
    assert.equal(composeUninstall(composeInstall(null, block)).trim().split('\n').at(-1), '[]');
    const mixed = composeInstall('- id: hmr\n  disabled: true\n', block);
    assert.equal(composeUninstall(mixed), '- id: hmr\n  disabled: true\n');
    assert.equal(composeUninstall('[]\n'), '[]\n');
  });
  it('bloco sem marcador de fim é erro explícito', () => {
    assert.throws(() => splitManaged(`${BEGIN}\n- insert: []\n`), /marcador de fim/);
  });
  it('o YAML gerado é aceito pelo js-yaml do próprio DSH com a config completa', (t) => {
    const v = validateYaml(composeInstall(null, block));
    if (!v.parsed) { t.skip('js-yaml do DSH indisponível'); return; }
    assert.equal(v.entries.length, 1);
    const entry = /** @type {any} */ (v.entries[0]);
    assert.equal(entry.name, PLUGIN_ENTRY);
    assert.deepEqual(entry.config, JSON.parse(JSON.stringify(DEFAULTS)));
    assert.deepEqual(resolveConfig(entry.config), resolveConfig(undefined));
  });
});

describe('install-home-patch — CLI contra DSH_HOME temporário', () => {
  const roots = /** @type {string[]} */ ([]);
  after(() => { for (const r of roots) rmrf(r); });

  it('--dry-run não escreve; install; --check; atualização; --uninstall', () => {
    const home = tempRoot('home');
    roots.push(home);
    const file = path.join(home, 'cordis.patch.yml');
    fs.writeFileSync(file, '# meu patch\n[]\n', { mode: 0o640 });
    fs.chmodSync(file, 0o640);

    const dry = cli(['--home', home, '--dry-run']);
    assert.equal(dry.code, 0, dry.err);
    assert.match(dry.out, /--dry-run/);
    assert.equal(fs.readFileSync(file, 'utf8'), '# meu patch\n[]\n');

    assert.equal(cli(['--home', home, '--check']).code, 1);
    const inst = cli(['--home', home]);
    assert.equal(inst.code, 0, inst.err);
    assert.match(inst.out, /instalado em .*backup/);
    assert.equal(fs.readdirSync(home).filter((n) => n.includes('.bak-session-scratch-')).length, 1);
    assert.equal(cli(['--home', home, '--check']).code, 0);
    assert.match(cli(['--home', home]).out, /já atualizado/);

    // Edição manual dentro do bloco → --check acusa, reinstalar corrige.
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"deny"', '"off"'));
    assert.equal(cli(['--home', home, '--check']).code, 1);
    assert.equal(cli(['--home', home]).code, 0);
    assert.equal(cli(['--home', home, '--check']).code, 0);

    const un = cli(['--home', home, '--uninstall']);
    assert.equal(un.code, 0, un.err);
    assert.equal(fs.readFileSync(file, 'utf8'), '# meu patch\n[]\n');
    assert.equal(fs.statSync(file).mode & 0o777, 0o640, 'modo do arquivo existente preservado');
  });
  it('arquivo novo nasce 0600', () => {
    const home = tempRoot('newfile');
    roots.push(home);
    assert.equal(cli(['--home', home]).code, 0);
    assert.equal(fs.statSync(path.join(home, 'cordis.patch.yml')).mode & 0o777, 0o600);
  });

  it('--config parcial é validado e reafirmado por inteiro', () => {
    const home = tempRoot('cfg');
    roots.push(home);
    assert.equal(cli(['--home', home, '--config', '{"guard":"warn"}']).code, 0);
    const text = fs.readFileSync(path.join(home, 'cordis.patch.yml'), 'utf8');
    assert.match(text, /guard: "warn"/);
    assert.match(text, /sweepIntervalMinutes: 30/);
    const bad = cli(['--home', home, '--config', '{"guard":"nope"}']);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /guard/);
  });

  const canVerify = fs.existsSync(DSH_LAUNCHER) && PROFILES.every((p) => fs.existsSync(path.join(REAL_PROFILES, p, 'package.json')));
  it('--verify: dsh --dump-config dos profiles web, headless e dwg-share (cópia temporária)', { skip: canVerify ? false : 'launcher dsh ou profiles reais ausentes', timeout: 600_000 }, () => {
    const home = tempRoot('verify');
    roots.push(home);
    for (const p of PROFILES) copyProfile(path.join(REAL_PROFILES, p), path.join(home, 'profiles', p));
    const inst = cli(['--home', home, '--verify', '--dsh', DSH_LAUNCHER, '--profiles', PROFILES.join(',')]);
    assert.equal(inst.code, 0, `${inst.out}\n${inst.err}`);
    for (const p of PROFILES) assert.match(inst.out, new RegExp(`OK  profile ${p}: linha presente uma vez`));
    const un = cli(['--home', home, '--uninstall', '--verify', '--dsh', DSH_LAUNCHER, '--profiles', PROFILES.join(',')]);
    assert.equal(un.code, 0, `${un.out}\n${un.err}`);
    assert.equal(fs.readFileSync(path.join(home, 'cordis.patch.yml'), 'utf8').trim().split('\n').at(-1), '[]');
  });
});
