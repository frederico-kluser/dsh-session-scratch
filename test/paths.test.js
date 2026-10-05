// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { ID_PATTERN, MAX_KEY_LENGTH, ensureBase, hostTmpdir, isStrictlyInside, isValidKey, processTmpdir, rootSessionKey, sanitizeId } from '../src/paths.js';
import { rmrf, tempRoot } from './helpers.js';

describe('sanitizeId', () => {
  it('ids normais do DSH passam intactos', () => {
    assert.equal(sanitizeId('session-0b6c2f0e-1d2a-4c55-9a0e-6f1f7d3c2b1a'), 'session-0b6c2f0e-1d2a-4c55-9a0e-6f1f7d3c2b1a');
    assert.equal(sanitizeId('abc.DEF-123'), 'abc.DEF-123');
  });
  it('../x não escapa da base', () => {
    const key = sanitizeId('../x');
    assert.equal(key, '_2e._2fx');
    assert.match(key, ID_PATTERN);
    assert.ok(!key.includes('/'));
  });
  it('. e .. viram chaves válidas que não começam com ponto', () => {
    assert.equal(sanitizeId('.'), '_2e');
    assert.equal(sanitizeId('..'), '_2e.');
    assert.equal(isValidKey(sanitizeId('.hidden')), true);
  });
  it('unicode vira hex por byte UTF-8', () => {
    assert.equal(sanitizeId('sessão'), 'sess_c3_a3o');
    assert.equal(sanitizeId('a b/c'), 'a_20b_2fc');
  });
  it('é injetiva no _ (escapa como __)', () => {
    assert.equal(sanitizeId('a_2f'), 'a__2f');
    assert.notEqual(sanitizeId('a_2f'), sanitizeId('a/'));
  });
  it('string vazia e não-string lançam', () => {
    assert.throws(() => sanitizeId(''), TypeError);
    assert.throws(() => sanitizeId(undefined), TypeError);
    assert.throws(() => sanitizeId(12), TypeError);
  });
  it('id longo é truncado com hash e continua único', () => {
    const a = sanitizeId('x'.repeat(500));
    const b = sanitizeId(`${'x'.repeat(499)}y`);
    assert.equal(a.length, MAX_KEY_LENGTH);
    assert.notEqual(a, b);
    assert.equal(isValidKey(a), true);
  });
});

describe('isValidKey', () => {
  it('rejeita ., .., ponto inicial, barras, vazio', () => {
    for (const bad of ['.', '..', '.owners', '.trash-1-a', 'a/b', '', 'a b', 'x'.repeat(201)]) {
      assert.equal(isValidKey(bad), false, bad);
    }
    assert.equal(isValidKey('session-1'), true);
  });
});

describe('rootSessionKey (cadeias de subagentes)', () => {
  /** @type {Record<string, { id: string, parentSession?: string, origin?: string }>} */
  const sessions = {
    root: { id: 'root' },
    child: { id: 'child', parentSession: 'root', origin: 'subagent' },
    grandchild: { id: 'grandchild', parentSession: 'child', origin: 'subagent' },
    fork: { id: 'fork', parentSession: 'root' },
    orphan: { id: 'orphan', parentSession: 'gone', origin: 'subagent' },
  };
  const lookup = (/** @type {string} */ id) => sessions[id];
  it('raiz usa o próprio id', () => assert.equal(rootSessionKey(sessions.root, { lookup }), 'root'));
  it('filho e neto sobem até a raiz', () => {
    assert.equal(rootSessionKey(sessions.child, { lookup }), 'root');
    assert.equal(rootSessionKey(sessions.grandchild, { lookup }), 'root');
  });
  it('fork da Web UI (sem origin) tem pasta própria', () => assert.equal(rootSessionKey(sessions.fork, { lookup }), 'fork'));
  it('pai desconhecido: usa o id do pai', () => assert.equal(rootSessionKey(sessions.orphan, { lookup }), 'gone'));
  it('sem partilha cada sessão tem a sua', () => assert.equal(rootSessionKey(sessions.grandchild, { lookup, share: false }), 'grandchild'));
  it('cache curto-circuita a subida', () => {
    const cache = new Map([['child', 'cached-root']]);
    assert.equal(rootSessionKey(sessions.grandchild, { lookup: () => undefined, cache }), 'cached-root');
  });
  it('ciclo não trava (limite de profundidade)', () => {
    /** @type {Record<string, { id: string, parentSession?: string, origin?: string }>} */
    const loop = { a: { id: 'a', parentSession: 'b', origin: 'subagent' }, b: { id: 'b', parentSession: 'a', origin: 'subagent' } };
    const key = rootSessionKey(loop.a, { lookup: (id) => loop[id] });
    assert.ok(key === 'a' || key === 'b');
  });
  it('ids hostis são sanitizados', () => {
    assert.equal(rootSessionKey({ id: 'x', parentSession: '../../etc', origin: 'subagent' }, { lookup: () => undefined }), '_2e._2f.._2fetc');
  });
});

describe('ensureBase / isStrictlyInside', () => {
  const roots = /** @type {string[]} */ ([]);
  after(() => { for (const r of roots) rmrf(r); });

  it('cria agent-scratch/dsh com 0700', () => {
    const root = tempRoot('base');
    roots.push(root);
    const { base, scratchRoot } = ensureBase(root, 'agent-scratch/dsh');
    assert.equal(base, path.join(root, 'agent-scratch', 'dsh'));
    assert.equal(scratchRoot, path.join(root, 'agent-scratch'));
    assert.equal(fs.statSync(base).mode & 0o777, 0o700);
    assert.equal(fs.statSync(scratchRoot).mode & 0o777, 0o700);
  });
  it('corrige permissões abertas de uma pasta própria', () => {
    const root = tempRoot('mode');
    roots.push(root);
    fs.mkdirSync(path.join(root, 'agent-scratch'), { mode: 0o777 });
    fs.chmodSync(path.join(root, 'agent-scratch'), 0o777);
    ensureBase(root, 'agent-scratch/dsh');
    assert.equal(fs.statSync(path.join(root, 'agent-scratch')).mode & 0o777, 0o700);
  });
  it('recusa base que é symlink', () => {
    const root = tempRoot('link');
    roots.push(root);
    fs.mkdirSync(path.join(root, 'elsewhere'));
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'agent-scratch'));
    assert.throws(() => ensureBase(root, 'agent-scratch/dsh'), /symlink/);
  });
  it('recusa base que é arquivo', () => {
    const root = tempRoot('file');
    roots.push(root);
    fs.writeFileSync(path.join(root, 'agent-scratch'), 'x');
    assert.throws(() => ensureBase(root, 'agent-scratch/dsh'), /diretório real/);
  });
  it('isStrictlyInside', () => {
    assert.equal(isStrictlyInside('/a/agent-scratch', '/a/agent-scratch/dsh/x'), true);
    assert.equal(isStrictlyInside('/a/agent-scratch', '/a/agent-scratch'), false);
    assert.equal(isStrictlyInside('/a/agent-scratch', '/a/agent-scratch/../x'), false);
    assert.equal(isStrictlyInside('/a/agent-scratch', '/a/agent-scratchy/x'), false);
  });
});

describe('hostTmpdir (raiz do host sem aninhar; mesma regra do host_tmp() da skill)', () => {
  const table = /** @type {[string, string][]} */ ([
    ['/var/tmp/user-1000', '/var/tmp/user-1000'],
    ['/var/tmp/user-1000/', '/var/tmp/user-1000'],
    // `dsh` lançado do Bash do Claude Code ou do bash de outra sessão DSH.
    ['/var/tmp/user-1000/agent-scratch/claude/3f2b9c1e-aaaa', '/var/tmp/user-1000'],
    ['/var/tmp/user-1000/agent-scratch/dsh/session-abc', '/var/tmp/user-1000'],
    ['/var/tmp/user-1000/agent-scratch/dsh/session-abc/tmp.XyZ', '/var/tmp/user-1000'],
    ['/var/tmp/user-1000/agent-scratch/claude/.s/1a2b3c4d', '/var/tmp/user-1000'],
    // Corta no PRIMEIRO segmento agent-scratch que tem filho.
    ['/x/agent-scratch/claude/s/agent-scratch/dsh/k', '/x'],
    // `agent-scratch` sem filho não é uma pasta de sessão: fica.
    ['/var/tmp/agent-scratch', '/var/tmp/agent-scratch'],
    ['/agent-scratch/dsh/k', '/'],
    ['/tmp', '/tmp'],
    ['/var/tmp/agent-scratchy/x', '/var/tmp/agent-scratchy/x'],
  ]);
  for (const [input, expected] of table) {
    it(`${input} → ${expected}`, () => assert.equal(hostTmpdir(input), expected));
  }
  it('processTmpdir é o TMPDIR cru (o que o bash herda), só absoluto e sem barra final', () => {
    assert.equal(processTmpdir('/var/tmp/user-1000/agent-scratch/claude/s/'), '/var/tmp/user-1000/agent-scratch/claude/s');
  });
});
