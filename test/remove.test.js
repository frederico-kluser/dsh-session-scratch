// @ts-check
/**
 * Remoção segura (src/remove.js): symlinks nunca seguidos, diretórios
 * read-only destravados, prazo respeitado e — com montagens REAIS dentro de
 * um namespace de usuário+montagem sem privilégio (`unshare -Urm`) — nada é
 * apagado do outro lado de um ponto de montagem.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mountsAtOrBelow, parseMountPoints, removeTree, removeTreeSync } from '../src/remove.js';
import { rmrf, tempRoot } from './helpers.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/** @param {string} root */
function layout(root) {
  const scratchRoot = path.join(root, 'agent-scratch');
  const trash = path.join(scratchRoot, 'dsh', '.trash-1-abc');
  fs.mkdirSync(trash, { recursive: true });
  return { scratchRoot, trash };
}

describe('removeTree / removeTreeSync', () => {
  const roots = /** @type {string[]} */ ([]);
  after(() => { for (const r of roots) rmrf(r); });
  /** @param {string} label */
  const make = (label) => { const r = tempRoot(label); roots.push(r); return r; };

  for (const mode of /** @type {const} */ (['sync', 'async'])) {
    /** @param {string} target @param {import('../src/remove.js').RemoveTreeOptions} opts */
    const run = (target, opts) => (mode === 'sync' ? Promise.resolve(removeTreeSync(target, opts)) : removeTree(target, opts));

    it(`${mode}: apaga a árvore sem seguir symlinks (o alvo fora fica intacto)`, async () => {
      const root = make(`rm-link-${mode}`);
      const { scratchRoot, trash } = layout(root);
      const outside = path.join(root, 'precious');
      fs.mkdirSync(path.join(outside, 'deep'), { recursive: true });
      fs.writeFileSync(path.join(outside, 'deep', 'keep'), 'x');
      fs.mkdirSync(path.join(trash, 'a', 'b'), { recursive: true });
      fs.writeFileSync(path.join(trash, 'a', 'b', 'f'), 'x');
      fs.symlinkSync(outside, path.join(trash, 'a', 'dir-link'));
      fs.symlinkSync(path.join(outside, 'deep', 'keep'), path.join(trash, 'file-link'));
      fs.symlinkSync('/nonexistent', path.join(trash, 'dangling'));
      assert.deepEqual(await run(trash, { scratchRoot }), { removed: true });
      assert.equal(fs.existsSync(trash), false);
      assert.equal(fs.readFileSync(path.join(outside, 'deep', 'keep'), 'utf8'), 'x');
    });

    it(`${mode}: destrava diretórios read-only REAIS (0500, 0000) e apaga`, async () => {
      const root = make(`rm-ro-${mode}`);
      const { scratchRoot, trash } = layout(root);
      fs.mkdirSync(path.join(trash, 'go', 'pkg', 'mod'), { recursive: true });
      fs.writeFileSync(path.join(trash, 'go', 'pkg', 'mod', 'f.go'), 'x');
      fs.chmodSync(path.join(trash, 'go', 'pkg', 'mod'), 0o555);
      fs.chmodSync(path.join(trash, 'go', 'pkg'), 0o500);
      fs.mkdirSync(path.join(trash, 'locked'));
      fs.writeFileSync(path.join(trash, 'locked', 'f'), 'x');
      fs.chmodSync(path.join(trash, 'locked'), 0o000);
      // Um diretório read-only FORA, alcançado por symlink: nunca recebe chmod.
      const outsideRo = path.join(root, 'outside-ro');
      fs.mkdirSync(outsideRo);
      fs.chmodSync(outsideRo, 0o500);
      fs.symlinkSync(outsideRo, path.join(trash, 'link-to-ro'));
      assert.deepEqual(await run(trash, { scratchRoot }), { removed: true });
      assert.equal(fs.existsSync(trash), false);
      assert.equal(fs.statSync(outsideRo).mode & 0o777, 0o500, 'chmod nunca atravessa symlink');
    });

    it(`${mode}: recusa a árvore inteira quando há ponto de montagem dentro`, async () => {
      const root = make(`rm-mnt-${mode}`);
      const { scratchRoot, trash } = layout(root);
      fs.mkdirSync(path.join(trash, 'mnt'));
      fs.writeFileSync(path.join(trash, 'mnt', 'remote-data.txt'), 'x');
      const r = await run(trash, { scratchRoot, mounts: () => [path.join(trash, 'mnt')] });
      assert.equal(r.removed, false);
      assert.match(String(r.reason), /montagem/);
      assert.equal(fs.readFileSync(path.join(trash, 'mnt', 'remote-data.txt'), 'utf8'), 'x', 'nada apagado');
    });

    it(`${mode}: recusa alvo fora de agent-scratch/`, async () => {
      const root = make(`rm-out-${mode}`);
      const { scratchRoot } = layout(root);
      await assert.rejects(async () => run(path.join(root, 'elsewhere'), { scratchRoot }), /fora de/);
      await assert.rejects(async () => run(scratchRoot, { scratchRoot }), /fora de/);
    });

    it(`${mode}: alvo ausente conta como removido; symlink como alvo é recusado`, async () => {
      const root = make(`rm-gone-${mode}`);
      const { scratchRoot, trash } = layout(root);
      assert.equal((await run(path.join(trash, 'nope'), { scratchRoot })).removed, true);
      const target = path.join(root, 'target');
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'keep'), 'x');
      fs.symlinkSync(target, path.join(trash, 'link'));
      assert.equal((await run(path.join(trash, 'link'), { scratchRoot })).removed, false);
      assert.equal(fs.existsSync(path.join(target, 'keep')), true);
    });
  }

  it('sync: o prazo é conferido antes de CADA operação (árvore grande não segura a saída)', () => {
    const root = make('rm-deadline');
    const { scratchRoot, trash } = layout(root);
    for (let d = 0; d < 20; d += 1) {
      const dir = path.join(trash, 'node_modules', `pkg${d}`);
      fs.mkdirSync(dir, { recursive: true });
      for (let f = 0; f < 200; f += 1) fs.writeFileSync(path.join(dir, `f${f}`), '');
    }
    let ops = 0;
    const r = removeTreeSync(trash, { scratchRoot, deadline: 100, now: () => { ops += 1; return ops; } });
    assert.equal(r.timedOut, true);
    assert.equal(r.removed, false);
    assert.ok(ops <= 102, `parou no prazo (${ops} consultas ao relógio)`);
    assert.equal(fs.existsSync(trash), true, 'o resto fica para a varredura');
    assert.deepEqual(removeTreeSync(trash, { scratchRoot }), { removed: true });
  });

  it('parseMountPoints desfaz os escapes octais e mountsAtOrBelow filtra por prefixo de caminho', () => {
    const text = [
      '36 35 98:0 /mnt1 /mnt/parent rw,noatime master:1 - ext3 /dev/root rw',
      '37 36 0:30 / /var/tmp/u/agent-scratch/dsh/k/m\\040x rw - fuse.sshfs host:/data rw',
      '38 36 0:31 / /var/tmp/u/agent-scratch/dsh/kk rw - tmpfs tmpfs rw',
    ].join('\n');
    assert.deepEqual(parseMountPoints(text), ['/mnt/parent', '/var/tmp/u/agent-scratch/dsh/k/m x', '/var/tmp/u/agent-scratch/dsh/kk']);
    assert.deepEqual(mountsAtOrBelow('/var/tmp/u/agent-scratch/dsh/k', () => text), ['/var/tmp/u/agent-scratch/dsh/k/m x']);
    assert.deepEqual(mountsAtOrBelow('/var/tmp/u/agent-scratch/dsh/kk', () => text), ['/var/tmp/u/agent-scratch/dsh/kk']);
    assert.deepEqual(mountsAtOrBelow('/var/tmp/u/agent-scratch/dsh/k', () => null), []);
  });
});

/** `unshare -Urm` disponível (Linux com userns sem privilégio)? */
const userns = process.platform === 'linux'
  && spawnSync('unshare', ['--user', '--map-root-user', '--mount', 'true'], { stdio: 'ignore' }).status === 0;

/**
 * Roda um script ESM num namespace de usuário+montagem novo: as montagens
 * somem sozinhas quando o processo sai. Devolve o JSON impresso.
 * @param {string} body corpo do script (tem `fs`, `path`, `sh`, `src`, `T`, `victim`)
 * @param {string} root
 */
function inNamespace(body, root) {
  const script = path.join(root, 'ns-script.mjs');
  fs.writeFileSync(script, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { execFileSync } from 'node:child_process';",
    `const src = ${JSON.stringify(SRC)};`,
    `const T = ${JSON.stringify(root)};`,
    "const victim = path.join(T, 'victim');",
    "const sh = (...a) => execFileSync(a[0], a.slice(1));",
    body,
  ].join('\n'));
  const r = spawnSync('unshare', ['--user', '--map-root-user', '--mount', process.execPath, script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop() ?? 'null');
}

describe('montagens REAIS dentro da pasta da sessão (unshare -Urm)', { skip: userns ? false : 'unshare sem privilégio indisponível' }, () => {
  const roots = /** @type {string[]} */ ([]);
  after(() => { for (const r of roots) rmrf(r); });
  /** @param {string} label */
  const setup = (label) => {
    const root = tempRoot(label);
    roots.push(root);
    fs.mkdirSync(path.join(root, 'victim', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'victim', 'remote-data.txt'), 'data');
    fs.writeFileSync(path.join(root, 'victim', 'sub', 'y'), 'y');
    return root;
  };
  /** @param {string} root */
  const victimIntact = (root) => {
    assert.equal(fs.readFileSync(path.join(root, 'victim', 'remote-data.txt'), 'utf8'), 'data');
    assert.equal(fs.readFileSync(path.join(root, 'victim', 'sub', 'y'), 'utf8'), 'y');
  };

  it('saída do processo (cleanupOwnSync) com bind mount dentro da pasta: a vítima fica intacta', () => {
    const root = setup('ns-exit');
    const report = inNamespace(`
      const { ScratchStore, cleanupOwnSync } = await import(src + 'store.js');
      const store = new ScratchStore({ tmpRoot: T, baseDir: 'agent-scratch/dsh' });
      const dir = store.ensure('session-mount');
      fs.mkdirSync(path.join(dir, 'mnt'));
      sh('mount', '--bind', victim, path.join(dir, 'mnt'));
      const r = cleanupOwnSync();
      console.log(JSON.stringify({ ...r, dirStill: fs.existsSync(dir) }));
    `, root);
    assert.equal(report.dirStill, true, 'a pasta com montagem dentro não é renomeada nem apagada');
    victimIntact(root);
  });

  it('varredura de órfão e remove() com bind mount dentro: recusa e não apaga nada', () => {
    const root = setup('ns-sweep');
    const report = inNamespace(`
      const { ScratchStore } = await import(src + 'store.js');
      const { sweepOnce } = await import(src + 'sweep.js');
      const store = new ScratchStore({ tmpRoot: T, baseDir: 'agent-scratch/dsh' });
      const dir = path.join(store.base, 'orphan');
      fs.mkdirSync(path.join(dir, 'mnt'), { recursive: true });
      const old = (Date.now() - 3 * 3600e3) / 1000;
      fs.utimesSync(dir, old, old);
      sh('mount', '--bind', victim, path.join(dir, 'mnt'));
      const logs = [];
      store.log = (m) => logs.push(m);
      const sweep = await sweepOnce(store, { idleMs: 864e5, graceMs: 60e3 });
      const removed = await store.remove('orphan', { wait: true });
      console.log(JSON.stringify({ deleted: sweep.deleted, removed, logs: logs.length, dirStill: fs.existsSync(dir) }));
    `, root);
    assert.deepEqual(report.deleted, []);
    assert.equal(report.removed, false);
    assert.equal(report.dirStill, true);
    assert.ok(report.logs > 0, 'a recusa é registrada');
    victimIntact(root);
  });

  it('defesa em profundidade: sem mountinfo (corrida), mnt_id e st_dev ainda impedem descer na montagem', () => {
    const root = setup('ns-race');
    const report = inNamespace(`
      const { removeTreeSync, removeTree } = await import(src + 'remove.js');
      const scratchRoot = path.join(T, 'agent-scratch');
      const out = {};
      for (const [label, run] of [['sync', (t, o) => removeTreeSync(t, o)], ['async', (t, o) => removeTree(t, o)]]) {
        const trash = path.join(scratchRoot, 'dsh', '.trash-1-' + label);
        fs.mkdirSync(path.join(trash, 'bind'), { recursive: true });
        fs.mkdirSync(path.join(trash, 'tmpfs'), { recursive: true });
        sh('mount', '--bind', victim, path.join(trash, 'bind'));                 // mesmo st_dev: pega pelo mnt_id
        sh('mount', '-t', 'tmpfs', 'tmpfs', path.join(trash, 'tmpfs'));          // outro st_dev
        fs.writeFileSync(path.join(trash, 'tmpfs', 'on-tmpfs'), 'z');
        const r = await run(trash, { scratchRoot, mounts: () => [] });           // finge que o mountinfo não mostrou nada
        out[label] = { removed: r.removed, tmpfsFile: fs.existsSync(path.join(trash, 'tmpfs', 'on-tmpfs')) };
      }
      console.log(JSON.stringify(out));
    `, root);
    for (const label of ['sync', 'async']) {
      assert.equal(report[label].removed, false, label);
      assert.equal(report[label].tmpfsFile, true, `${label}: nada apagado no tmpfs montado`);
    }
    victimIntact(root);
  });
});
