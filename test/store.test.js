// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { realProc } from '../src/owner.js';
import { ScratchStore, TOUCH_INTERVAL_MS, cleanupOwnSync, detachOwnSync, processState } from '../src/store.js';
import { fakeProc, manualClock, rmrf, tempRoot } from './helpers.js';

const ME = process.pid;

describe('ScratchStore', () => {
  const roots = /** @type {string[]} */ ([]);
  after(() => { for (const r of roots) rmrf(r); });

  /** @param {string} label */
  function make(label, proc = realProc) {
    const root = tempRoot(label);
    roots.push(root);
    const clock = manualClock();
    const store = new ScratchStore({ tmpRoot: root, baseDir: 'agent-scratch/dsh', proc, now: clock.now });
    return { root, clock, store };
  }

  it('ensure cria a pasta 0700 e o marcador deste processo', () => {
    const { store } = make('ensure');
    const dir = store.ensure('session-a');
    assert.equal(dir, path.join(store.base, 'session-a'));
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    const marker = JSON.parse(fs.readFileSync(store.markerPath('session-a'), 'utf8'));
    assert.equal(marker.v, 1);
    assert.equal(marker.pid, ME);
    assert.equal(fs.statSync(store.markerPath('session-a')).mode & 0o777, 0o600);
    assert.equal(store.isLive('session-a'), true);
  });

  it('ensure é throttled (não reescreve o marcador) mas recria na hora a pasta apagada', () => {
    const { store, clock } = make('touch');
    const dir = store.ensure('s');
    const marker = store.markerPath('s');
    const old = (clock.now() - 10_000) / 1000;
    fs.utimesSync(marker, old, old);
    clock.advance(1000);
    store.ensure('s'); // dentro do intervalo e a pasta existe: nenhuma escrita
    assert.equal(Math.round(fs.statSync(marker).mtimeMs / 1000), Math.round(old));
    fs.rmSync(dir, { recursive: true });
    store.ensure('s'); // dentro do intervalo, mas a pasta sumiu: recria
    assert.equal(fs.statSync(dir).isDirectory(), true);
    clock.advance(TOUCH_INTERVAL_MS + 1);
    store.ensure('s');
    const mtime = fs.statSync(marker).mtimeMs;
    assert.ok(Math.abs(mtime - clock.now()) < 1000, `mtime ${mtime} ≈ ${clock.now()}`);
  });

  it('.owners e a base somem com o DSH no ar (tmpfiles, rm manual): ensure recria e segue', () => {
    const { store, clock } = make('vanish');
    store.ensure('session-a');
    // A varredura ociosa apaga pasta e marcador; o tmpfiles (idade 3d) remove o .owners vazio.
    fs.rmSync(path.join(store.base, 'session-a'), { recursive: true });
    fs.rmSync(store.markerPath('session-a'));
    fs.rmdirSync(store.ownersDir);
    const b = store.ensure('session-b');
    assert.equal(fs.statSync(b).isDirectory(), true);
    assert.equal(JSON.parse(fs.readFileSync(store.markerPath('session-b'), 'utf8')).pid, ME);
    fs.rmSync(store.base, { recursive: true });
    const c = store.ensure('session-c');
    assert.equal(fs.statSync(c).mode & 0o777, 0o700);
    assert.equal(fs.statSync(store.ownersDir).mode & 0o777, 0o700);
    assert.equal(fs.existsSync(store.markerPath('session-c')), true);
    // Até agent-scratch inteiro: recriado com as mesmas verificações.
    fs.rmSync(store.scratchRoot, { recursive: true });
    clock.advance(TOUCH_INTERVAL_MS + 1);
    assert.equal(fs.statSync(store.ensure('session-c')).isDirectory(), true);
  });

  it('base recriada por OUTRO processo (tem .owners) é adotada', () => {
    const { root, store } = make('adopt');
    store.ensure('a');
    fs.rmSync(store.base, { recursive: true });
    const other = new ScratchStore({ tmpRoot: root, baseDir: 'agent-scratch/dsh' }); // recria base + .owners
    assert.equal(fs.statSync(store.ensure('b')).isDirectory(), true);
    assert.equal(other.base, store.base);
  });

  it('base recriada VAZIA por outro processo (antes de ele criar o .owners) é adotada', () => {
    const { store } = make('adopt-empty');
    store.ensure('a');
    fs.rmSync(store.base, { recursive: true });
    fs.mkdirSync(store.base, { mode: 0o700 });
    assert.equal(fs.statSync(store.ensure('b', { force: true })).isDirectory(), true);
    assert.equal(fs.statSync(store.ownersDir).isDirectory(), true);
  });

  it('base trocada por uma pasta REAL alheia (sem .owners): nada é criado nem apagado nela', async () => {
    const { root, store } = make('swapped');
    store.ensure('a');
    const foreign = path.join(root, 'foreign');
    fs.mkdirSync(path.join(foreign, 'Projects'), { recursive: true });
    fs.writeFileSync(path.join(foreign, 'Projects', 'f'), 'x');
    fs.rmSync(store.base, { recursive: true });
    fs.renameSync(foreign, store.base);
    assert.throws(() => store.ensure('b', { force: true }), /não é uma base de scratch/);
    assert.equal(await store.remove('Projects'), false);
    assert.deepEqual(fs.readdirSync(store.base), ['Projects']);
    assert.equal(fs.readFileSync(path.join(store.base, 'Projects', 'f'), 'utf8'), 'x');
  });

  it('base trocada por symlink depois do arranque: remove/detach recusam e o alvo fica', async () => {
    const { root, store } = make('swaplink');
    store.ensure('k');
    const victim = path.join(root, 'victim');
    fs.mkdirSync(path.join(victim, 'k'), { recursive: true });
    fs.writeFileSync(path.join(victim, 'k', 'data'), 'x');
    fs.mkdirSync(path.join(victim, '.owners'));
    fs.rmSync(store.base, { recursive: true });
    fs.symlinkSync(victim, store.base);
    assert.equal(await store.remove('k', { wait: true }), false);
    assert.equal(store.removeSync('k'), false);
    assert.throws(() => store.ensure('k', { force: true }), /symlink/);
    const report = detachOwnSync();
    assert.ok(report.skipped.includes(path.join(store.base, 'k')));
    assert.equal(fs.readFileSync(path.join(victim, 'k', 'data'), 'utf8'), 'x');
  });

  it('ensure assume o marcador de dono morto e partilha o de dono vivo', () => {
    const proc = fakeProc({ self: ME, boot: 'b', procs: { [ME]: '1', 777: '2' } });
    const { store } = make('takeover', proc);
    fs.mkdirSync(path.join(store.base, 'dead'));
    fs.writeFileSync(store.markerPath('dead'), JSON.stringify({ v: 1, pid: 555, start: '9', boot: 'b', createdAt: 0 }));
    fs.mkdirSync(path.join(store.base, 'live'));
    const liveMarker = JSON.stringify({ v: 1, pid: 777, start: '2', boot: 'b', createdAt: 0 });
    fs.writeFileSync(store.markerPath('live'), liveMarker);
    store.ensure('dead');
    store.ensure('live');
    assert.equal(JSON.parse(fs.readFileSync(store.markerPath('dead'), 'utf8')).pid, ME);
    assert.equal(fs.readFileSync(store.markerPath('live'), 'utf8'), liveMarker);
  });

  it('ensure recusa chave inválida e pasta que é symlink', () => {
    const { root, store } = make('reject');
    assert.throws(() => store.ensure('../x'), /chave inválida/);
    assert.throws(() => store.ensure('.owners'), /chave inválida/);
    fs.mkdirSync(path.join(root, 'target'));
    fs.symlinkSync(path.join(root, 'target'), path.join(store.base, 'linked'));
    assert.throws(() => store.ensure('linked'), /não é uma pasta confiável/);
  });

  it('remove (async): o caminho some na hora e a lixeira é apagada', async () => {
    const { store } = make('remove');
    const dir = store.ensure('r');
    fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(1024));
    const pending = store.remove('r', { wait: true });
    assert.equal(fs.existsSync(dir), false); // rename síncrono
    assert.equal(await pending, true);
    assert.deepEqual(fs.readdirSync(store.base), ['.owners']);
    assert.equal(fs.existsSync(store.markerPath('r')), false);
    assert.equal(store.isLive('r'), false);
  });

  it('remove não apaga pasta usada por outro processo vivo', async () => {
    const proc = fakeProc({ self: ME, boot: 'b', procs: { [ME]: '1', 777: '2' } });
    const { store } = make('shared', proc);
    fs.mkdirSync(path.join(store.base, 'shared'));
    fs.writeFileSync(store.markerPath('shared'), JSON.stringify({ v: 1, pid: 777, start: '2', boot: 'b', createdAt: 0 }));
    assert.equal(await store.remove('shared'), false);
    assert.equal(fs.existsSync(path.join(store.base, 'shared')), true);
  });

  it('remove não segue symlink: só some o link, o alvo fica', async () => {
    const { root, store } = make('symlink');
    const target = path.join(root, 'precious');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep'), 'x');
    const dir = store.ensure('s');
    fs.symlinkSync(target, path.join(dir, 'link-to-precious'));
    assert.equal(await store.remove('s', { wait: true }), true);
    assert.equal(fs.readFileSync(path.join(target, 'keep'), 'utf8'), 'x');
  });

  it('removeSync', () => {
    const { store } = make('removesync');
    const dir = store.ensure('z');
    fs.writeFileSync(path.join(dir, 'a'), 'a');
    assert.equal(store.removeSync('z'), true);
    assert.equal(fs.existsSync(dir), false);
    assert.equal(store.removeSync('z'), true); // já não existe: idempotente
  });

  it('cleanupOwnSync apaga só as pastas cujo marcador ainda é deste processo', () => {
    const { store } = make('exit');
    const a = store.ensure('mine-a');
    const b = store.ensure('mine-b');
    fs.writeFileSync(path.join(a, 'x'), 'x');
    // b foi assumida por outro processo (marcador mudou): não é nossa.
    fs.writeFileSync(store.markerPath('mine-b'), JSON.stringify({ v: 1, pid: 1, start: '1', boot: 'other', createdAt: 0 }));
    const report = cleanupOwnSync();
    assert.ok(report.removed.includes(a));
    assert.ok(report.skipped.includes(b));
    assert.equal(fs.existsSync(a), false);
    assert.equal(fs.existsSync(b), true);
    assert.equal(fs.existsSync(store.markerPath('mine-a')), false);
    assert.equal(processState().dirs.has(a), false);
  });

  it('subpasta read-only (cache 0555 do Go) não vaza lixeira na saída', () => {
    const { store } = make('ro');
    const dir = store.ensure('s1');
    fs.mkdirSync(path.join(dir, 'go', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'go', 'pkg', 'f'), 'x');
    fs.chmodSync(path.join(dir, 'go', 'pkg'), 0o555);
    fs.mkdirSync(path.join(dir, 'ro'));
    fs.writeFileSync(path.join(dir, 'ro', 'f'), 'x');
    fs.chmodSync(path.join(dir, 'ro'), 0o500);
    const report = cleanupOwnSync();
    assert.equal(report.trashLeft, 0);
    assert.deepEqual(fs.readdirSync(store.base), ['.owners']);
  });

  it('saída com árvore enorme respeita o orçamento; o resto fica como lixeira', () => {
    const { store } = make('budget');
    const dir = store.ensure('big');
    for (let d = 0; d < 40; d += 1) {
      const pkg = path.join(dir, 'node_modules', `pkg${d}`);
      fs.mkdirSync(pkg, { recursive: true });
      for (let f = 0; f < 250; f += 1) fs.writeFileSync(path.join(pkg, `f${f}`), '');
    }
    const t = performance.now();
    const report = cleanupOwnSync({ budgetMs: 30 });
    const ms = performance.now() - t;
    assert.equal(report.timedOut, true);
    assert.equal(report.trashLeft, 1);
    assert.ok(ms < 1000, `${ms.toFixed(0)} ms`);
    assert.equal(fs.existsSync(dir), false, 'o caminho da sessão some (rename)');
    const leftover = fs.readdirSync(store.base).filter((n) => n.startsWith('.trash-'));
    assert.equal(leftover.length, 1);
    // Na saída real o processo termina aqui; no teste, termina a limpeza.
    assert.equal(cleanupOwnSync({ budgetMs: 60_000 }).trashLeft, 0);
  });

  it('detachOwnSync (SIGTERM) só renomeia; cleanupOwnSync (exit) apaga a lixeira', () => {
    const { store } = make('detach');
    const dir = store.ensure('sig');
    fs.writeFileSync(path.join(dir, 'big'), Buffer.alloc(4096));
    const report = detachOwnSync();
    assert.ok(report.detached.includes(dir));
    assert.equal(fs.existsSync(dir), false);
    assert.equal(fs.existsSync(store.markerPath('sig')), false);
    const trash = fs.readdirSync(store.base).filter((n) => n.startsWith(`.trash-${process.pid}-`));
    assert.equal(trash.length, 1, 'lixeira pendente com o pid deste processo');
    assert.equal(store.isPendingTrash(path.join(store.base, String(trash[0]))), true);
    const exit = cleanupOwnSync();
    assert.equal(exit.trashLeft, 0);
    assert.deepEqual(fs.readdirSync(store.base), ['.owners']);
  });
});
