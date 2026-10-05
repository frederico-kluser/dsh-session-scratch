// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULTS, resolveConfig } from '../src/config.js';

describe('resolveConfig', () => {
  it('defaults do contrato', () => {
    const c = resolveConfig(undefined);
    assert.deepEqual({ ...c }, {
      baseDir: 'agent-scratch/dsh',
      exportTmpdir: true,
      promptRule: true,
      guard: 'deny',
      guardTools: ['bash'],
      fileTools: ['write', 'edit'],
      escapeMarker: 'allow-literal-tmp',
      allowPrefixes: ['/tmp/.X11-unix', '/tmp/.ICE-unix'],
      shareWithSubagents: true,
      idleDays: 3,
      orphanGraceMinutes: 30,
      sweepIntervalMinutes: 30,
    });
    assert.ok(Object.isFrozen(c));
    assert.deepEqual(resolveConfig(null), c);
    assert.deepEqual(resolveConfig({}), c);
  });
  it('a config completa reafirmada no patch é aceita', () => {
    assert.deepEqual(resolveConfig({ ...DEFAULTS }), resolveConfig(undefined));
  });
  it('override parcial mantém o resto', () => {
    const c = resolveConfig({ guard: 'warn', idleDays: 1.5 });
    assert.equal(c.guard, 'warn');
    assert.equal(c.idleDays, 1.5);
    assert.equal(c.baseDir, 'agent-scratch/dsh');
  });

  const bad = /** @type {[string, unknown][]} */ ([
    ['guard', 'block'],
    ['guard', true],
    ['exportTmpdir', 'yes'],
    ['promptRule', 1],
    ['shareWithSubagents', null],
    ['guardTools', 'bash'],
    ['guardTools', ['ba sh']],
    ['fileTools', [1]],
    ['escapeMarker', ''],
    ['escapeMarker', 'ab'],
    ['escapeMarker', 'a\nb-c'],
    ['allowPrefixes', ['/var/tmp/x']],
    ['allowPrefixes', ['/tmp/']],
    ['allowPrefixes', ['/tmp/../etc']],
    ['idleDays', 0],
    ['idleDays', -1],
    ['idleDays', Number.NaN],
    ['idleDays', '3'],
    ['orphanGraceMinutes', 0],
    ['sweepIntervalMinutes', 0],
    ['sweepIntervalMinutes', 99999],
    ['baseDir', '/abs/path'],
    ['baseDir', 'dsh-scratch'],
    ['baseDir', 'agent-scratch'],
    ['baseDir', 'agent-scratch/../x'],
    ['baseDir', 'agent-scratch/./x'],
    ['baseDir', 'agent-scratch/a b'],
    ['baseDir', 42],
    // Árvores de OUTROS harnesses e caminhos DENTRO de uma árvore: a varredura
    // trataria as sessões alheias como órfãs (sem marcador DSH) e as apagaria.
    ['baseDir', 'agent-scratch/claude'],
    ['baseDir', 'agent-scratch/codex'],
    ['baseDir', 'agent-scratch/dsh/x'],
    ['baseDir', 'agent-scratch/dsh-test/x'],
    ['baseDir', 'agent-scratch/claude/dsh'],
    ['baseDir', 'agent-scratch/dshx'],
    ['baseDir', 'agent-scratch/.dsh'],
    ['allowPrefixes', ['/tmp/a//b']],
  ]);
  for (const [key, value] of bad) {
    it(`rejeita ${key}=${JSON.stringify(value)}`, () => {
      assert.throws(() => resolveConfig({ [key]: value }), TypeError);
    });
  }
  it('rejeita chave desconhecida (erro de digitação)', () => {
    assert.throws(() => resolveConfig({ guardTool: ['bash'] }), /desconhecida/);
  });
  it('rejeita config que não é objeto', () => {
    assert.throws(() => resolveConfig('deny'), TypeError);
    assert.throws(() => resolveConfig([]), TypeError);
  });
  it('baseDir: agent-scratch/dsh ou uma árvore irmã dsh-<x>; barra final normalizada', () => {
    assert.equal(resolveConfig({ baseDir: 'agent-scratch/dsh/' }).baseDir, 'agent-scratch/dsh');
    assert.equal(resolveConfig({ baseDir: 'agent-scratch/dsh-test' }).baseDir, 'agent-scratch/dsh-test');
    assert.equal(resolveConfig({ baseDir: 'agent-scratch/dsh.e2e_1' }).baseDir, 'agent-scratch/dsh.e2e_1');
  });
  it('a mensagem de erro do baseDir cita a árvore do Claude Code', () => {
    assert.throws(() => resolveConfig({ baseDir: 'agent-scratch/claude' }), /agent-scratch\/claude/);
  });
  it('listas são deduplicadas', () => {
    assert.deepEqual(resolveConfig({ guardTools: ['bash', 'bash'] }).guardTools, ['bash']);
  });
});
