// @ts-check
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { ensureAlias } from '../src/alias.js';
import { selfIdentity } from '../src/owner.js';
import { ScratchStore, sharerName } from '../src/store.js';
import { decide, sessionPaths, sweepOnce, trashPid } from '../src/sweep.js';
import { fakeProc, manualClock, rmrf, tempRoot } from './helpers.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const BOOT = 'boot-A';
const ME = process.pid;
const OTHER = 424242;

describe('decide (puro: relógio, identidade e /proc injetados)', () => {
  const proc = fakeProc({ self: ME, boot: BOOT, procs: { [ME]: '100', [OTHER]: '200' } });
  const self = selfIdentity(proc, ME);
  const now = 10 * DAY;
  const ctx = { now, idleMs: 3 * DAY, graceMs: 30 * MIN, self, proc };
  const marker = (/** @type {Partial<import('../src/owner.js').OwnerMarker>} */ m) => ({ v: /** @type {const} */ (1), pid: ME, start: '100', boot: BOOT, createdAt: 0, ...m });

  const table = /** @type {[string, import('../src/sweep.js').SweepEntry, string, string][]} */ ([
    ['própria e ativa', { dirMtimeMs: now - DAY, marker: marker({}), markerMtimeMs: now - MIN }, 'keep', 'live-own'],
    ['própria e ociosa além de idleDays', { dirMtimeMs: now - 4 * DAY, marker: marker({}), markerMtimeMs: now - 4 * DAY }, 'delete', 'idle-own'],
    ['própria: pasta tocada recentemente salva', { dirMtimeMs: now - MIN, marker: marker({}), markerMtimeMs: now - 4 * DAY }, 'keep', 'live-own'],
    ['outro processo vivo, mesmo velhíssima', { dirMtimeMs: 0, marker: marker({ pid: OTHER, start: '200' }), markerMtimeMs: 0 }, 'keep', 'live-other'],
    ['pid morto, além da carência', { dirMtimeMs: now - 31 * MIN, marker: marker({ pid: 999 }), markerMtimeMs: now - 31 * MIN }, 'delete', 'orphan'],
    ['pid morto, dentro da carência', { dirMtimeMs: now - 5 * MIN, marker: marker({ pid: 999 }), markerMtimeMs: now - 5 * MIN }, 'keep', 'orphan-grace'],
    ['pid reaproveitado (starttime diferente)', { dirMtimeMs: now - DAY, marker: marker({ pid: OTHER, start: '199' }), markerMtimeMs: now - DAY }, 'delete', 'orphan'],
    ['boot_id diferente', { dirMtimeMs: now - DAY, marker: marker({ pid: OTHER, start: '200', boot: 'boot-OLD' }), markerMtimeMs: now - DAY }, 'delete', 'orphan'],
    ['sem marcador, velha', { dirMtimeMs: now - 2 * DAY, marker: null, markerMtimeMs: null }, 'delete', 'orphan'],
    ['sem marcador, fresca (corrida de criação)', { dirMtimeMs: now - MIN, marker: null, markerMtimeMs: null }, 'keep', 'orphan-grace'],
    ['dono morto mas marcador tocado agora (takeover)', { dirMtimeMs: now - DAY, marker: marker({ pid: 999 }), markerMtimeMs: now - MIN }, 'keep', 'orphan-grace'],
  ]);
  for (const [label, entry, action, reason] of table) {
    it(label, () => assert.deepEqual(decide(entry, ctx), { action, reason }));
  }
  it('dono indeterminado (sem /proc, kill inconclusivo) é mantido', () => {
    const p = fakeProc({ self: ME, boot: null, procs: {}, noProc: true, killResult: () => null });
    const me = selfIdentity(p, ME);
    const d = decide({ dirMtimeMs: 0, marker: { v: 1, pid: OTHER, start: null, boot: null, createdAt: 0 }, markerMtimeMs: 0 }, { ...ctx, self: me, proc: p });
    assert.deepEqual(d, { action: 'keep', reason: 'unknown-owner' });
  });
  it('trashPid', () => {
    assert.equal(trashPid('.trash-123-abc'), 123);
    assert.equal(trashPid('.trash-x-abc'), null);
    assert.equal(trashPid('session-1'), null);
  });
});

describe('sweepOnce (disco real, /proc falso)', () => {
  const roots = /** @type {string[]} */ ([]);
  after(() => { for (const r of roots) rmrf(r); });

  /**
   * @param {string} label
   */
  function setup(label) {
    const root = tempRoot(label);
    roots.push(root);
    const clock = manualClock(100 * DAY);
    const proc = fakeProc({ self: ME, boot: BOOT, procs: { [ME]: '100', [OTHER]: '200' } });
    const store = new ScratchStore({ tmpRoot: root, baseDir: 'agent-scratch/dsh', proc, now: clock.now });
    /**
     * @param {string} key
     * @param {{ marker?: object|null|string, ageMs: number }} spec
     */
    const plant = (key, spec) => {
      const dir = path.join(store.base, key);
      fs.mkdirSync(dir, { mode: 0o700 });
      fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
      const t = (clock.now() - spec.ageMs) / 1000;
      if (spec.marker !== undefined && spec.marker !== null) {
        const file = store.markerPath(key);
        fs.writeFileSync(file, typeof spec.marker === 'string' ? spec.marker : JSON.stringify(spec.marker));
        fs.utimesSync(file, t, t);
      }
      fs.utimesSync(dir, t, t);
      return dir;
    };
    return { root, clock, proc, store, plant };
  }

  it('apaga órfãos e ociosas próprias; preserva vivas e frescas; nunca segue symlink', async () => {
    const { root, clock, store, plant } = setup('sweep');
    const mine = { v: 1, pid: ME, start: '100', boot: BOOT, createdAt: 0 };
    plant('own-active', { marker: mine, ageMs: MIN });
    plant('own-idle', { marker: mine, ageMs: 4 * DAY });
    plant('other-live', { marker: { ...mine, pid: OTHER, start: '200' }, ageMs: 50 * DAY });
    plant('dead-old', { marker: { ...mine, pid: 999 }, ageMs: 2 * 60 * MIN });
    plant('dead-fresh', { marker: { ...mine, pid: 999 }, ageMs: 5 * MIN });
    plant('reused-pid', { marker: { ...mine, pid: OTHER, start: '1' }, ageMs: DAY });
    plant('no-marker-old', { marker: null, ageMs: DAY });
    plant('corrupt-marker', { marker: '{not json', ageMs: DAY });
    // Alvo FORA da base, alcançável só via symlink: nunca pode ser tocado.
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'precious'), 'keep');
    fs.symlinkSync(outside, path.join(store.base, 'evil-link'));
    // Nomes fora do esquema são ignorados.
    fs.mkdirSync(path.join(store.base, 'has space'));
    // Lixeira velha de outro processo.
    fs.mkdirSync(path.join(store.base, '.trash-999-abc'));
    fs.writeFileSync(path.join(store.base, '.trash-999-abc', 'junk'), 'x');

    const report = await sweepOnce(store, { idleMs: 3 * DAY, graceMs: 30 * MIN, now: clock.now });
    assert.deepEqual(report.deleted.sort(), ['corrupt-marker', 'dead-old', 'no-marker-old', 'own-idle', 'reused-pid']);
    assert.deepEqual(report.trashCleared, ['.trash-999-abc']);
    assert.equal(report.kept['own-active'], 'live-own');
    assert.equal(report.kept['other-live'], 'live-other');
    assert.equal(report.kept['dead-fresh'], 'orphan-grace');
    const left = fs.readdirSync(store.base).sort();
    assert.deepEqual(left, ['.owners', 'dead-fresh', 'evil-link', 'has space', 'other-live', 'own-active']);
    assert.equal(fs.readFileSync(path.join(outside, 'precious'), 'utf8'), 'keep');
    // Marcadores das pastas apagadas sumiram; os das mantidas ficaram.
    assert.equal(fs.existsSync(store.markerPath('dead-old')), false);
    assert.equal(fs.existsSync(store.markerPath('own-idle')), false);
    assert.equal(fs.existsSync(store.markerPath('other-live')), true);
  });

  it('marcador sem pasta: apagado quando o dono morreu e a carência passou', async () => {
    const { clock, store } = setup('markers');
    const t = (clock.now() - 2 * 60 * MIN) / 1000;
    for (const [key, pid] of /** @type {[string, number][]} */ ([['m-dead', 999], ['m-live', OTHER]])) {
      const file = store.markerPath(key);
      fs.writeFileSync(file, JSON.stringify({ v: 1, pid, start: pid === OTHER ? '200' : '1', boot: BOOT, createdAt: 0 }));
      fs.utimesSync(file, t, t);
    }
    const report = await sweepOnce(store, { idleMs: 3 * DAY, graceMs: 30 * MIN, now: clock.now });
    assert.deepEqual(report.markersCleared, ['m-dead']);
    assert.equal(fs.existsSync(store.markerPath('m-live')), true);
  });

  it('corrida de takeover: marcador muda depois do rename → a pasta volta', async () => {
    const { clock, store, plant } = setup('takeover');
    const dead = { v: 1, pid: 999, start: '1', boot: BOOT, createdAt: 0 };
    const dir = plant('raced', { marker: dead, ageMs: DAY });
    const file = store.markerPath('raced');
    const st = fs.statSync(file);
    const removed = await store.remove('raced', {
      expect: { marker: /** @type {any} */ (dead), mtimeMs: st.mtimeMs },
      wait: true,
      afterRename: () => {
        // Outro processo assume a sessão entre a decisão e a reverificação.
        fs.writeFileSync(file, JSON.stringify({ ...dead, pid: OTHER, start: '200' }));
      },
    });
    assert.equal(removed, false);
    assert.equal(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'x');
    assert.equal(fs.readdirSync(store.base).some((n) => n.startsWith('.trash-')), false);
    // E a varredura seguinte respeita o novo dono vivo.
    const report = await sweepOnce(store, { idleMs: 3 * DAY, graceMs: 30 * MIN, now: clock.now });
    assert.equal(report.kept.raced, 'live-other');
  });

  it('marcador mudou entre decisão e remoção (expect diferente) → nada é apagado', async () => {
    const { store, plant } = setup('expect');
    plant('k', { marker: { v: 1, pid: 999, start: '1', boot: BOOT, createdAt: 0 }, ageMs: DAY });
    const removed = await store.remove('k', { expect: { marker: null, mtimeMs: null }, wait: true });
    assert.equal(removed, false);
    assert.equal(fs.existsSync(path.join(store.base, 'k')), true);
  });

  it('base trocada por symlink depois do arranque: a varredura aborta e o alvo fica intacto', async () => {
    const { root, clock, store } = setup('swap');
    const victim = path.join(root, 'victim');
    fs.mkdirSync(path.join(victim, 'Projects'), { recursive: true });
    fs.writeFileSync(path.join(victim, 'Projects', 'f'), 'x');
    fs.mkdirSync(path.join(victim, 'config'));
    fs.writeFileSync(path.join(victim, 'config', 'package.json'), '{}');
    fs.symlinkSync(path.join(victim, 'config'), path.join(victim, '.owners'));
    const t = (clock.now() - 2 * 60 * MIN) / 1000;
    fs.utimesSync(path.join(victim, 'Projects'), t, t);
    fs.utimesSync(path.join(victim, 'config', 'package.json'), t, t);
    fs.rmSync(store.base, { recursive: true });
    fs.symlinkSync(victim, store.base);
    const logs = /** @type {string[]} */ ([]);
    const report = await sweepOnce(store, { idleMs: 3 * DAY, graceMs: 30 * MIN, now: clock.now, log: (m) => logs.push(m) });
    assert.deepEqual(report, { deleted: [], kept: {}, trashCleared: [], markersCleared: [], sharersCleared: [], aliasesCleared: [] });
    assert.match(logs.join('\n'), /não confiável/);
    assert.equal(fs.readFileSync(path.join(victim, 'Projects', 'f'), 'utf8'), 'x');
    assert.equal(fs.existsSync(path.join(victim, 'config', 'package.json')), true);
  });

  it('só o .owners trocado por symlink: aborta antes de apagar qualquer <key>.json do alvo', async () => {
    const { root, clock, store } = setup('swap-owners');
    const victim = path.join(root, 'config');
    fs.mkdirSync(victim);
    fs.writeFileSync(path.join(victim, 'package.json'), '{}');
    const t = (clock.now() - 2 * 60 * MIN) / 1000;
    fs.utimesSync(path.join(victim, 'package.json'), t, t);
    fs.rmSync(store.ownersDir, { recursive: true });
    fs.symlinkSync(victim, store.ownersDir);
    const report = await sweepOnce(store, { idleMs: 3 * DAY, graceMs: 30 * MIN, now: clock.now });
    assert.deepEqual(report.markersCleared, []);
    assert.equal(fs.existsSync(path.join(victim, 'package.json')), true);
  });

  it('base sumiu (tmpfiles): a varredura recria base e .owners e segue sem erro', async () => {
    const { clock, store } = setup('vanished');
    fs.rmSync(store.scratchRoot, { recursive: true });
    const logs = /** @type {string[]} */ ([]);
    const report = await sweepOnce(store, { idleMs: 3 * DAY, graceMs: 30 * MIN, now: clock.now, log: (m) => logs.push(m) });
    assert.deepEqual(report.deleted, []);
    assert.deepEqual(logs, []);
    assert.equal(fs.statSync(store.ownersDir).isDirectory(), true);
  });

  it('apelidos .s/: pendurados de dono morto saem após a carência; de sessão viva, com pasta, alheios e frescos ficam', async () => {
    const { root, clock, store, plant } = setup('aliases');
    const adir = path.join(store.base, '.s');
    fs.mkdirSync(adir, { mode: 0o700 });
    const t = (clock.now() - 2 * 60 * MIN) / 1000;
    /** @param {string} name @param {string} target @param {number} [when] */
    const link = (name, target, when = t) => {
      const p = path.join(adir, name);
      fs.symlinkSync(target, p);
      fs.lutimesSync(p, when, when);
      return p;
    };
    /** @param {string} key @param {number} pid @param {string} start */
    const marker = (key, pid, start) => {
      fs.writeFileSync(store.markerPath(key), JSON.stringify({ v: 1, pid, start, boot: BOOT, createdAt: 0 }));
      fs.utimesSync(store.markerPath(key), t, t);
    };
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'precious'), 'keep');
    marker('gone-dead', 999, '1');
    const danglingDead = link('aaaaaaaa', '../gone-dead');
    const danglingNoMarker = link('bbbbbbbb', '../gone-nomarker');
    const danglingFresh = link('cccccccc', '../gone-fresh', clock.now() / 1000);
    marker('gone-live', OTHER, '200');
    const danglingLiveOwner = link('dddddddd', '../gone-live');
    store.ensure('own-live-key-long');
    fs.rmSync(path.join(store.base, 'own-live-key-long'), { recursive: true });
    const danglingSelfLive = link('eeeeeeee', '../own-live-key-long');
    plant('present', { marker: { v: 1, pid: OTHER, start: '200', boot: BOOT, createdAt: 0 }, ageMs: DAY });
    const withDir = link('ffffffff', '../present');
    const foreign = link('11111111', outside);
    const weird = link('22222222', '../has/slash');
    fs.mkdirSync(path.join(adir, '33333333'));
    const tempDead = link('.tmp-999-abcd', '../gone-dead');
    const tempLiveFresh = link(`.tmp-${OTHER}-abcd`, '../present', clock.now() / 1000);

    const report = await sweepOnce(store, { idleMs: 3 * DAY, graceMs: 30 * MIN, now: clock.now });
    assert.deepEqual(report.aliasesCleared.sort(), ['.tmp-999-abcd', 'aaaaaaaa', 'bbbbbbbb']);
    for (const p of [danglingDead, danglingNoMarker, tempDead]) assert.equal(fs.existsSync(p) || fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined, false, p);
    for (const p of [danglingFresh, danglingLiveOwner, danglingSelfLive, withDir, foreign, weird, tempLiveFresh]) assert.equal(fs.lstatSync(p).isSymbolicLink(), true, p);
    assert.equal(fs.statSync(path.join(adir, '33333333')).isDirectory(), true);
    assert.equal(fs.readFileSync(path.join(outside, 'precious'), 'utf8'), 'keep');
    assert.equal(fs.readFileSync(path.join(store.base, 'present', 'f.txt'), 'utf8'), 'x', 'pasta de dono vivo apontada por apelido: intacta');
    assert.equal(report.kept.present, 'live-other');
  });

  it('órfão com apelido: a pasta sai e o apelido dela também (nunca o conteúdo através do link)', async () => {
    const { clock, store, plant } = setup('alias-orphan');
    const key = 'session-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
    plant(key, { marker: { v: 1, pid: 999, start: '1', boot: BOOT, createdAt: 0 }, ageMs: 2 * 60 * MIN });
    const alias = /** @type {string} */ (store.alias(key));
    assert.ok(alias !== null && fs.lstatSync(alias).isSymbolicLink(), 'o comprimento da base de teste pede apelido');
    const report = await sweepOnce(store, { idleMs: 3 * DAY, graceMs: 30 * MIN, now: clock.now });
    assert.deepEqual(report.deleted, [key]);
    assert.equal(fs.lstatSync(alias, { throwIfNoEntry: false }), undefined);
  });

  it('.s trocado por symlink: a varredura de apelidos não desliga nada no alvo', async () => {
    const { root, clock, store } = setup('alias-swap');
    const victim = path.join(root, 'victim');
    fs.mkdirSync(victim);
    const t = (clock.now() - 2 * 60 * MIN) / 1000;
    const p = path.join(victim, 'aaaaaaaa');
    fs.symlinkSync('../gone', p);
    fs.lutimesSync(p, t, t);
    fs.symlinkSync(victim, path.join(store.base, '.s'));
    const logs = /** @type {string[]} */ ([]);
    const report = await sweepOnce(store, { idleMs: 3 * DAY, graceMs: 30 * MIN, now: clock.now, log: (m) => logs.push(m) });
    assert.deepEqual(report.aliasesCleared, []);
    assert.equal(fs.lstatSync(p).isSymbolicLink(), true);
    assert.match(logs.join('\n'), /não é um diretório real/);
  });

  const SID = 'session-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
  const live = (/** @type {number} */ pid = OTHER) => JSON.stringify({ v: 1, pid, start: pid === OTHER ? '200' : '100', boot: BOOT, createdAt: 0 });
  /**
   * Apelido PENDURADO de 2 h (pasta canônica e marcador ausentes).
   * @param {ScratchStore} store
   * @param {number} nowMs
   */
  function dangling(store, nowMs) {
    fs.mkdirSync(path.join(store.base, SID), { mode: 0o700 });
    const a = /** @type {string} */ (ensureAlias(store.base, SID, { uid: process.getuid?.() ?? -1 }));
    fs.rmdirSync(path.join(store.base, SID));
    const t = (nowMs - 2 * 60 * MIN) / 1000;
    fs.lutimesSync(a, t, t);
    return a;
  }

  it('retomada DURANTE a varredura (pasta recriada + dono vivo no último await): o apelido fica', async () => {
    const { clock, store } = setup('alias-resume');
    const a = dangling(store, clock.now());
    const report = await sweepOnce(store, {
      idleMs: 3 * DAY,
      graceMs: 30 * MIN,
      now: clock.now,
      // O último await antes do unlink: aqui a sessão é retomada por outro processo vivo.
      inUse: async () => {
        fs.mkdirSync(path.join(store.base, SID), { mode: 0o700 });
        fs.writeFileSync(store.markerPath(SID), live());
        return false;
      },
    });
    assert.deepEqual(report.aliasesCleared, []);
    assert.equal(fs.realpathSync(a), path.join(store.base, SID), 'apelido da sessão retomada intacto');
  });

  it('dono volta a viver no último await (pasta ainda ausente): o apelido fica', async () => {
    const { clock, store } = setup('alias-resume-marker');
    const a = dangling(store, clock.now());
    const report = await sweepOnce(store, {
      idleMs: 3 * DAY, graceMs: 30 * MIN, now: clock.now,
      inUse: async () => { fs.writeFileSync(store.markerPath(SID), live()); return false; },
    });
    assert.deepEqual(report.aliasesCleared, []);
    assert.equal(fs.lstatSync(a).isSymbolicLink(), true);
  });

  it('apelido pendurado referenciado por um processo vivo (TMPDIR herdado), ou com partilhador vivo: fica', async () => {
    const { clock, store } = setup('alias-inuse');
    const a = dangling(store, clock.now());
    /** @type {string[][]} */
    const asked = [];
    let report = await sweepOnce(store, { idleMs: 3 * DAY, graceMs: 30 * MIN, now: clock.now, inUse: async (paths) => { asked.push(paths); return true; } });
    assert.deepEqual(report.aliasesCleared, []);
    assert.ok(asked.some((p) => p.includes(a) && p.includes(path.join(store.base, SID))), JSON.stringify(asked));
    fs.writeFileSync(path.join(store.ownersDir, sharerName(SID, OTHER)), live());
    report = await sweepOnce(store, { idleMs: 3 * DAY, graceMs: 30 * MIN, now: clock.now, inUse: async () => false });
    assert.deepEqual(report.aliasesCleared, []);
    fs.rmSync(path.join(store.ownersDir, sharerName(SID, OTHER)));
    report = await sweepOnce(store, { idleMs: 3 * DAY, graceMs: 30 * MIN, now: clock.now, inUse: async () => false });
    assert.deepEqual(report.aliasesCleared, [path.basename(a)], 'sem referência nem partilhador: sai');
  });

  it('órfã ou ociosa EM USO por um processo vivo (cwd, fd ou TMPDIR na canônica ou num apelido): fica; lixeira em uso também', async () => {
    const { clock, store, plant } = setup('inuse-inject');
    plant('orphan-busy', { marker: { v: 1, pid: 999, start: '1', boot: BOOT, createdAt: 0 }, ageMs: 2 * 60 * MIN });
    plant('idle-busy', { marker: { v: 1, pid: ME, start: '100', boot: BOOT, createdAt: 0 }, ageMs: 4 * DAY });
    plant('orphan-free', { marker: { v: 1, pid: 999, start: '1', boot: BOOT, createdAt: 0 }, ageMs: 2 * 60 * MIN });
    fs.mkdirSync(path.join(store.base, '.trash-999-busy'));
    /** @type {string[][]} */
    const asked = [];
    const report = await sweepOnce(store, {
      idleMs: 3 * DAY, graceMs: 30 * MIN, now: clock.now,
      inUse: async (paths) => { asked.push(paths); return paths.some((p) => /busy/.test(p)); },
    });
    assert.deepEqual(report.deleted, ['orphan-free']);
    assert.equal(report.kept['orphan-busy'], 'in-use');
    assert.equal(report.kept['idle-busy'], 'in-use');
    assert.equal(report.kept['.trash-999-busy'], 'in-use');
    assert.deepEqual(report.trashCleared, []);
    const forOrphan = asked.find((p) => p[0] === path.join(store.base, 'orphan-busy'));
    assert.deepEqual(forOrphan, sessionPaths(store, 'orphan-busy'), 'a canônica e todos os nomes de apelido');
  });

  it('órfã com um SOBREVIVENTE real (cwd pelo apelido, TMPDIR = apelido): fica enquanto ele vive; sai depois', async () => {
    const { clock, store, plant } = setup('inuse-real');
    const dir = plant(SID, { marker: { v: 1, pid: 999, start: '1', boot: BOOT, createdAt: 0 }, ageMs: 2 * 60 * MIN });
    fs.mkdirSync(path.join(dir, 'chrome-profile'));
    const a = /** @type {string} */ (ensureAlias(store.base, SID, { uid: process.getuid?.() ?? -1 }));
    const t = (clock.now() - 2 * 60 * MIN) / 1000;
    fs.utimesSync(dir, t, t);
    const byCwd = spawn('sleep', ['60'], { cwd: path.join(a, 'chrome-profile'), stdio: 'ignore' });
    const byEnv = spawn('sleep', ['60'], { cwd: store.base, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: a }, stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 150));
      let report = await sweepOnce(store, { idleMs: 3 * DAY, graceMs: 30 * MIN, now: clock.now });
      assert.equal(report.kept[SID], 'in-use', JSON.stringify(report));
      assert.equal(fs.existsSync(path.join(dir, 'chrome-profile')), true);
      byCwd.kill('SIGKILL');
      await new Promise((r) => byCwd.once('exit', r));
      report = await sweepOnce(store, { idleMs: 3 * DAY, graceMs: 30 * MIN, now: clock.now });
      assert.equal(report.kept[SID], 'in-use', 'só o TMPDIR (apelido) no environ do outro já segura');
      byEnv.kill('SIGKILL');
      await new Promise((r) => byEnv.once('exit', r));
      report = await sweepOnce(store, { idleMs: 3 * DAY, graceMs: 30 * MIN, now: clock.now });
      assert.deepEqual(report.deleted, [SID]);
      assert.equal(fs.lstatSync(a, { throwIfNoEntry: false }), undefined, 'apelido sai junto');
    } finally {
      byCwd.kill('SIGKILL');
      byEnv.kill('SIGKILL');
    }
  });

  it('órfã com partilhador vivo: fica (live-sharer); registros .share de pid morto saem, de vivo ficam', async () => {
    const { clock, store, plant } = setup('sharer-sweep');
    plant('shared-orphan', { marker: { v: 1, pid: 999, start: '1', boot: BOOT, createdAt: 0 }, ageMs: 2 * 60 * MIN });
    fs.writeFileSync(path.join(store.ownersDir, sharerName('shared-orphan', OTHER)), live());
    fs.writeFileSync(path.join(store.ownersDir, sharerName('shared-orphan', 999)), JSON.stringify({ v: 1, pid: 999, start: '1', boot: BOOT, createdAt: 0 }));
    fs.writeFileSync(path.join(store.ownersDir, sharerName('gone', 998)), '{corrompido');
    fs.writeFileSync(path.join(store.ownersDir, sharerName('mine-unused', ME)), live(ME));
    const report = await sweepOnce(store, { idleMs: 3 * DAY, graceMs: 30 * MIN, now: clock.now, inUse: async () => false });
    assert.equal(report.kept['shared-orphan'], 'live-sharer');
    assert.equal(fs.existsSync(path.join(store.base, 'shared-orphan', 'f.txt')), true);
    assert.deepEqual(report.sharersCleared.sort(), [sharerName('gone', 998), sharerName('mine-unused', ME), sharerName('shared-orphan', 999)].sort());
    assert.equal(fs.existsSync(path.join(store.ownersDir, sharerName('shared-orphan', OTHER))), true);
  });

  it('lixeiras: de pid morto e read-only saem; de outro processo VIVO, só depois da carência', async () => {
    const { store } = setup('trash');
    const dead = path.join(store.base, '.trash-999-dead');
    fs.mkdirSync(path.join(dead, 'ro'), { recursive: true });
    fs.writeFileSync(path.join(dead, 'ro', 'f'), 'x');
    fs.chmodSync(path.join(dead, 'ro'), 0o500);
    const live = path.join(store.base, `.trash-${OTHER}-live`);
    fs.mkdirSync(live);
    const real = { now: () => Date.now() };
    let report = await sweepOnce(store, { idleMs: 3 * DAY, graceMs: 30 * MIN, ...real });
    assert.deepEqual(report.trashCleared, ['.trash-999-dead']);
    assert.equal(fs.existsSync(live), true, 'outro processo vivo pode estar apagando');
    const t = (Date.now() - 31 * MIN) / 1000;
    fs.utimesSync(live, t, t);
    report = await sweepOnce(store, { idleMs: 3 * DAY, graceMs: 30 * MIN, ...real });
    assert.deepEqual(report.trashCleared, [`.trash-${OTHER}-live`]);
  });
});
