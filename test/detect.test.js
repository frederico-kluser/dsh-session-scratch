// @ts-check
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  DEFAULT_ALLOW_PREFIXES,
  classifyToolCall,
  commandUsesLiteralTmp,
  findLiteralTmp,
  pathIsUnderTmp,
  scratchExemptPrefixes,
} from '../src/detect.js';

import { CONTRACT_HITS, CONTRACT_MISSES, MORE_HITS, MORE_MISSES } from './corpus.js';

describe('detector de /tmp literal — contrato', () => {
  for (const cmd of CONTRACT_HITS) {
    it(`acerta: ${JSON.stringify(cmd)}`, () => assert.equal(commandUsesLiteralTmp(cmd), true));
  }
  for (const cmd of CONTRACT_MISSES) {
    it(`não acerta: ${JSON.stringify(cmd)}`, () => assert.equal(commandUsesLiteralTmp(cmd), false));
  }
});

describe('detector de /tmp literal — casos extra', () => {
  for (const cmd of MORE_HITS) {
    it(`acerta: ${JSON.stringify(cmd)}`, () => assert.equal(commandUsesLiteralTmp(cmd), true));
  }
  for (const cmd of MORE_MISSES) {
    it(`não acerta: ${JSON.stringify(cmd)}`, () => assert.equal(commandUsesLiteralTmp(cmd), false));
  }
  it('não-string nunca acerta', () => {
    assert.equal(commandUsesLiteralTmp(undefined), false);
    assert.equal(commandUsesLiteralTmp(42), false);
    assert.equal(commandUsesLiteralTmp(['/tmp']), false);
  });
  it('informa posição e token de cada acerto', () => {
    assert.deepEqual(findLiteralTmp('a /tmp/x b /tmp'), [
      { index: 2, token: '/tmp/x' },
      { index: 11, token: '/tmp' },
    ]);
    assert.deepEqual(findLiteralTmp('/tmp,/tmp'), [
      { index: 0, token: '/tmp' },
      { index: 5, token: '/tmp' },
    ]);
  });
  it('marcador e prefixos configuráveis', () => {
    assert.equal(commandUsesLiteralTmp('ls /tmp # ok-tmp', { escapeMarker: 'ok-tmp' }), false);
    assert.equal(commandUsesLiteralTmp('ls /tmp # allow-literal-tmp', { escapeMarker: 'ok-tmp' }), true);
    assert.equal(commandUsesLiteralTmp('ls /tmp/sock/a', { allowPrefixes: ['/tmp/sock'] }), false);
    assert.equal(commandUsesLiteralTmp('ls /tmp/.X11-unix', { allowPrefixes: [] }), true);
    assert.deepEqual([...DEFAULT_ALLOW_PREFIXES], ['/tmp/.X11-unix', '/tmp/.ICE-unix']);
  });
});

describe('caminho de ferramenta de arquivo', () => {
  const hits = ['/tmp', '/tmp/', '/tmp/x.txt', '/tmp/a/b', '//tmp/x', '/tmp/./x', '/var/../tmp/x', '/tmp/.X11-unix/../x'];
  const misses = ['/var/tmp/x', '/tmpfoo/x', '/home/u/tmp/x', 'tmp/x', './tmp/x', '~/tmp/x', '', '/tmp/.X11-unix/X0', '/tmp/.ICE-unix'];
  for (const p of hits) it(`acerta: ${p}`, () => assert.equal(pathIsUnderTmp(p), true));
  for (const p of misses) it(`não acerta: ${JSON.stringify(p)}`, () => assert.equal(pathIsUnderTmp(p), false));
  it('relativo resolve contra o cwd da sessão', () => {
    // Workspace sob /tmp: write/edit acertam (limitação documentada do contrato).
    assert.equal(pathIsUnderTmp('x.txt', { cwd: '/tmp/proj' }), true);
    assert.equal(pathIsUnderTmp('../../tmp/x', { cwd: '/home/u' }), true);
    assert.equal(pathIsUnderTmp('x.txt', { cwd: '/home/u' }), false);
  });
  it('scratchExemptPrefixes: só quando a árvore fica sob /tmp (DSH sem TMPDIR)', () => {
    assert.deepEqual(scratchExemptPrefixes('/tmp/agent-scratch'), ['/tmp/agent-scratch']);
    assert.deepEqual(scratchExemptPrefixes('/var/tmp/user-1000/agent-scratch'), []);
    assert.deepEqual(scratchExemptPrefixes('/tmpx/agent-scratch'), []);
  });
  it('isenção da árvore de scratch quando o host-tmp fica sob /tmp (sem laço no deny)', () => {
    const exemptPrefixes = ['/tmp/agent-scratch'];
    assert.equal(pathIsUnderTmp('/tmp/agent-scratch/dsh/session-1/notas.md', { exemptPrefixes }), false);
    assert.equal(pathIsUnderTmp('/tmp/agent-scratch', { exemptPrefixes }), false);
    assert.equal(pathIsUnderTmp('/tmp/agent-scratch/../x', { exemptPrefixes }), true);
    assert.equal(pathIsUnderTmp('/tmp/agent-scratchy/x', { exemptPrefixes }), true);
    assert.equal(pathIsUnderTmp('/tmp/x', { exemptPrefixes }), true);
  });
});

describe('classifyToolCall (nomes reais do DSH)', () => {
  const policy = {
    guardTools: ['bash'],
    fileTools: ['write', 'edit'],
    allowPrefixes: [...DEFAULT_ALLOW_PREFIXES],
    escapeMarker: 'allow-literal-tmp',
  };
  it('bash: arguments.command', () => {
    assert.equal(classifyToolCall('bash', { command: 'echo x > /tmp/y', description: 'd' }, policy), 'shell');
    assert.equal(classifyToolCall('bash', { command: 'echo x > "$TMPDIR/y"', description: 'd' }, policy), null);
  });
  it('bash: arguments.workdir em /tmp tem tipo próprio (motivo próprio)', () => {
    assert.equal(classifyToolCall('bash', { command: 'ls', workdir: '/tmp' }, policy), 'workdir');
    assert.equal(classifyToolCall('bash', { command: 'npm test', workdir: '/tmp/proj' }, policy), 'workdir');
    assert.equal(classifyToolCall('bash', { command: 'make', workdir: 'src' }, policy, '/tmp/proj'), 'workdir');
    assert.equal(classifyToolCall('bash', { command: 'ls /tmp', workdir: '/tmp' }, policy), 'shell', 'comando com /tmp vence');
    assert.equal(classifyToolCall('bash', { command: 'ls # allow-literal-tmp', workdir: '/tmp' }, policy), null);
    assert.equal(classifyToolCall('bash', { command: 'ls', workdir: '/home/u' }, policy), null);
  });
  it('write/edit: arguments.file_path', () => {
    assert.equal(classifyToolCall('write', { file_path: '/tmp/a.txt', content: 'x' }, policy), 'file');
    assert.equal(classifyToolCall('edit', { file_path: '/tmp/a.txt', old_string: 'a', new_string: 'b' }, policy), 'file');
    assert.equal(classifyToolCall('write', { file_path: '/var/tmp/user-1000/agent-scratch/dsh/s/a.txt', content: 'x' }, policy), null);
  });
  it('isenção (host-tmp sob /tmp) vale para file_path e workdir, não para o comando', () => {
    const p = { ...policy, exemptPrefixes: ['/tmp/agent-scratch'] };
    assert.equal(classifyToolCall('write', { file_path: '/tmp/agent-scratch/dsh/s/a.txt', content: 'x' }, p), null);
    assert.equal(classifyToolCall('bash', { command: 'ls', workdir: '/tmp/agent-scratch/dsh/s' }, p), null);
    assert.equal(classifyToolCall('bash', { command: 'cat /tmp/agent-scratch/dsh/s/a.txt' }, p), 'shell');
  });
  it('ferramentas fora da política são ignoradas', () => {
    assert.equal(classifyToolCall('read', { file_path: '/tmp/a.txt' }, policy), null);
    assert.equal(classifyToolCall('grep', { pattern: '/tmp' }, policy), null);
  });
  it('str_replace_editor usa `path` e `view` é leitura', () => {
    const p = { ...policy, fileTools: ['str_replace_editor'] };
    assert.equal(classifyToolCall('str_replace_editor', { command: 'create', path: '/tmp/x', file_text: 'a' }, p), 'file');
    assert.equal(classifyToolCall('str_replace_editor', { command: 'view', path: '/tmp/x' }, p), null);
  });
  it('argumentos inválidos não acertam', () => {
    assert.equal(classifyToolCall('bash', null, policy), null);
    assert.equal(classifyToolCall('bash', 'ls /tmp', policy), null);
  });
});

/**
 * Implementação de REFERÊNCIA (a anterior, quadrática): normaliza o token de
 * cada acerto do zero. A nova tem de dar exatamente o mesmo resultado.
 * @param {string} command
 * @param {readonly string[]} prefixes
 */
function referenceHits(command, prefixes = DEFAULT_ALLOW_PREFIXES) {
  if (command.includes('allow-literal-tmp')) return [];
  const re = /(?:^|[\s'"`=:;|&(<>{,])\/tmp(?=$|[\/\s'"`;|&)<>},])/gm;
  /** @type {{ index: number, token: string }[]} */
  const hits = [];
  for (let m = re.exec(command); m !== null; m = re.exec(command)) {
    const index = m.index + m[0].length - 4;
    let end = index + 4;
    while (end < command.length && !/[\s'"`;|&)<>},]/.test(command[end] ?? '')) end += 1;
    const token = command.slice(index, end);
    const norm = path.posix.normalize(token);
    if (!prefixes.some((p) => norm === p || norm.startsWith(`${p}/`))) hits.push({ index, token });
    re.lastIndex = index + 4;
  }
  return hits;
}

describe('detector: equivalência com a referência e tempo linear', () => {
  /** PRNG determinístico (mulberry32): a semente fixa torna o fuzz reprodutível. */
  const prng = (/** @type {number} */ seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  /** @param {() => number} rand @param {readonly string[]} pool @param {number} n */
  const build = (rand, pool, n) => {
    let out = '';
    for (let j = 0; j < n; j += 1) out += pool[Math.floor(rand() * pool.length)];
    return out;
  };
  /** @param {string} cmd */
  const same = (cmd) => {
    const ref = referenceHits(cmd);
    assert.deepEqual(findLiteralTmp(cmd), ref, JSON.stringify(cmd));
    assert.equal(commandUsesLiteralTmp(cmd), ref.length > 0, JSON.stringify(cmd));
    return ref;
  };
  it('fuzz: 20 000 comandos aleatórios dão os mesmos acertos da referência', () => {
    const rand = prng(42);
    const pool = ['/tmp', '/tmp', '/tmp/', '/tmp/.X11-unix', '/tmp/.ICE-unix/', '/', '//', '.', '..', '/.', '/..', '/../',
      '.X11-unix', 'a', ':', ':', '=', '=', '(', '{', ',', ' ', '\n', '"', '}', ';', 'x/'];
    let allowedSeen = 0;
    for (let i = 0; i < 20_000; i += 1) {
      const cmd = build(rand, pool, 1 + Math.floor(rand() * 16));
      if (same(cmd).length < (cmd.match(/\/tmp/g) ?? []).length) allowedSeen += 1;
    }
    assert.ok(allowedSeen > 1000, `o fuzz precisa exercitar acertos permitidos (${allowedSeen})`);
  });
  it('fuzz: tokens longos com muitos acertos no MESMO token (composição da direita para a esquerda)', () => {
    const rand = prng(7);
    const seg = ['/tmp', '/tmp', '/tmp/.X11-unix', '/tmp/.ICE-unix', '/.X11-unix', '/..', '/..', '/..', '/.', '//', '/a', '/q', '/../..'];
    const join = [':', '=', '(', '{'];
    for (let i = 0; i < 20_000; i += 1) {
      const n = 2 + Math.floor(rand() * 12);
      let cmd = 'X=';
      for (let j = 0; j < n; j += 1) cmd += (j > 0 ? join[Math.floor(rand() * join.length)] : '') + build(rand, seg, 1 + Math.floor(rand() * 4));
      same(cmd);
    }
  });
  it('`..` que sobram de um sufixo propagam por vários acertos do mesmo token', () => {
    // 3 acertos num só token. O 3º trecho tem 5 `..`: o próprio `tmp` e os 2
    // segmentos do 2º absorvem 3, e os 2 que sobram tiram `q=` e `.X11-unix`
    // do 1º, cujo token normaliza para /tmp (proibido). Com 4 `..`, sobra o
    // `.X11-unix` e o 1º acerto é permitido.
    assert.deepEqual(same('X=/tmp/.X11-unix/q=/tmp/=/tmp/../../../../..').map((h) => h.index), [2, 19, 25]);
    assert.deepEqual(same('X=/tmp/.X11-unix/q=/tmp/=/tmp/../../../..').map((h) => h.index), [19, 25]);
    same('a=/tmp/.ICE-unix/x/y:/tmp/a/b(/tmp/../../../../../..{/tmp/.X11-unix');
  });
  it('prefixos configurados de vários segmentos também batem com a referência', () => {
    const prefixes = ['/tmp/sock/a'];
    for (const cmd of ['ls /tmp/sock/a', 'ls /tmp/sock/a/b', 'ls /tmp/sock', 'ls /tmp/sock/ab', 'ls /tmp//sock/./a/x', 'X=/tmp/sock/a/:/tmp/sock/a/../b']) {
      assert.equal(commandUsesLiteralTmp(cmd, { allowPrefixes: prefixes }), referenceHits(cmd, prefixes).length > 0, cmd);
    }
  });
  /** @param {() => unknown} fn */
  const timed = (fn) => { const t = performance.now(); fn(); return performance.now() - t; };
  it('lista longa sem espaços (`a=/tmp/x:/tmp/y:…`, ~230 KB) roda em tempo linear', () => {
    const cmd = `export X=${Array.from({ length: 20_000 }, (_, i) => `/tmp/p${i}`).join(':')}`;
    const ms = timed(() => assert.equal(commandUsesLiteralTmp(cmd), true));
    assert.ok(ms < 500, `${ms.toFixed(0)} ms`);
  });
  it('pior caso: milhares de acertos PERMITIDOS no mesmo token roda em tempo linear', () => {
    const cmd = `echo ${Array.from({ length: 15_000 }, () => '/tmp/.X11-unix/').join('=')}`;
    const ms = timed(() => assert.equal(commandUsesLiteralTmp(cmd), false));
    assert.ok(ms < 500, `${ms.toFixed(0)} ms`);
    // E um único acerto proibido no fim ainda é encontrado.
    assert.equal(commandUsesLiteralTmp(`${cmd}=/tmp/x`), true);
  });
  it('classifyToolCall também fica linear (a guarda roda síncrona no host)', () => {
    const cmd = `X=${Array.from({ length: 20_000 }, (_, i) => `(/tmp/.ICE-unix/${i}`).join('')}`;
    const p = { guardTools: ['bash'], fileTools: [], allowPrefixes: [...DEFAULT_ALLOW_PREFIXES], escapeMarker: 'allow-literal-tmp' };
    const ms = timed(() => assert.equal(classifyToolCall('bash', { command: cmd }, p), null));
    assert.ok(ms < 500, `${ms.toFixed(0)} ms`);
  });
});
