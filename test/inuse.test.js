// @ts-check
/**
 * "Em uso por algum processo vivo?" (src/inuse.js): o proc_refs/refs_hit da
 * skill, com processos reais.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { lazyInUse, procRefs, refsHit } from '../src/inuse.js';
import { rmrf, tempRoot } from './helpers.js';

describe('refsHit', () => {
  it('igual ou DEBAIXO do caminho; nunca um prefixo sem fronteira de pasta', () => {
    const refs = ['/v/agent-scratch/dsh/.s/abcd1234', '/v/agent-scratch/dsh/session-1/sub', '/v/agent-scratch/dsh/.trash-9-x/p (deleted)', 'socket:[123]'];
    assert.equal(refsHit(refs, ['/v/agent-scratch/dsh/.s/abcd1234']), true, 'TMPDIR = apelido');
    assert.equal(refsHit(refs, ['/v/agent-scratch/dsh/session-1']), true, 'cwd debaixo da canônica');
    assert.equal(refsHit(refs, ['/v/agent-scratch/dsh/session-1/']), true, 'barra final no caminho');
    assert.equal(refsHit(refs, ['/v/agent-scratch/dsh/.trash-9-x']), true, 'cwd de pasta renomeada (deleted)');
    assert.equal(refsHit(refs, ['/v/agent-scratch/dsh/session']), false, 'session ≠ session-1');
    assert.equal(refsHit(refs, ['/v/agent-scratch/dsh/.s/abcd']), false);
    assert.equal(refsHit(refs, ['', '/nada']), false);
    assert.equal(refsHit([], ['/v']), false);
  });
});

describe('procRefs (processos reais)', () => {
  const root = tempRoot('inuse');
  after(() => rmrf(root));

  it('vê cwd, fds e TMPDIR/TMP/TEMP/TMPPREFIX de um processo do euid; ignora os excluídos', async () => {
    const dir = path.join(root, 'sessao');
    fs.mkdirSync(path.join(dir, 'cwd'), { recursive: true });
    const held = path.join(dir, 'held.txt');
    fs.writeFileSync(held, 'x');
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: path.join(root, 'alias-a'), TMP: path.join(root, 'alias-b'), TEMP: path.join(root, 'alias-c'), TMPPREFIX: path.join(root, 'alias-d', 'zsh') };
    const child = spawn('sh', ['-c', `exec 3<"$1"; exec sleep 60`, 'sh', held], { cwd: path.join(dir, 'cwd'), env, stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 150));
      const refs = await procRefs();
      assert.ok(refs.includes(path.join(dir, 'cwd')), 'cwd');
      assert.ok(refs.includes(held), 'fd aberto');
      for (const v of Object.values(env).slice(1)) assert.ok(refs.includes(v), v);
      const without = await procRefs({ exclude: [process.pid, /** @type {number} */ (child.pid)] });
      assert.equal(refsHit(without, [dir, path.join(root, 'alias-a')]), false, 'excluído não conta');
      assert.deepEqual(await procRefs({ procRoot: path.join(root, 'nao-existe') }), [], '/proc ilegível: nada (e não lança)');
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('lazyInUse lê o /proc no máximo uma vez, e só se alguém perguntar', async () => {
    let reads = 0;
    const inUse = lazyInUse(async () => { reads += 1; return ['/a/b/c']; });
    assert.equal(reads, 0);
    assert.equal(await inUse(['/a/b']), true);
    assert.equal(await inUse(['/x']), false);
    assert.equal(reads, 1);
    const failing = lazyInUse(async () => { throw new Error('sem /proc'); });
    assert.equal(await failing(['/a']), false, 'erro de leitura = nada em uso');
  });
});
