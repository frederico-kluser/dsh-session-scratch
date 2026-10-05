// @ts-check
/**
 * Paridade JS ⇄ Python do detector do CONTRATO partilhado: roda o mesmo corpus
 * no `commandUsesLiteralTmp`/`pathIsUnderTmp` daqui e no `command_hits`/
 * `path_hits` do hook do Claude Code (tmpdir-agent-skill). Pulado quando o
 * hook ou o python3 não estão nesta máquina (DSS_TMPDIR_HOOK sobrescreve o
 * caminho).
 *
 * Fora do corpus, de propósito: os separadores \x1c-\x1f/\x85 (o `\s` do
 * Python os inclui, o do JS não) e ﻿ (o inverso). Nenhum deles separa
 * palavras no bash, então a diferença não muda o que um comando acessa.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MAX_TMPDIR_BYTES, aliasCandidates, needsAlias } from '../src/alias.js';
import { commandUsesLiteralTmp, pathIsUnderTmp } from '../src/detect.js';
import { hostTmpdir } from '../src/paths.js';
import { PROMPT_RULE } from '../src/text.js';
import { CONTRACT_HITS, CONTRACT_MISSES, MORE_HITS, MORE_MISSES } from './corpus.js';

const HOOK = process.env.DSS_TMPDIR_HOOK ?? '/home/ondokai/Agent-Skills/tmpdir-agent-skill/hooks/claude/tmpdir_hook.py';
const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
const skip = !fs.existsSync(HOOK) ? `hook Python ausente (${HOOK})` : python.status !== 0 ? 'python3 ausente' : false;

/**
 * Avalia o corpus no hook Python, num processo só.
 * @param {string[]} commands
 * @param {[string, string|null][]} paths
 * @param {string[]} tmpdirs valores de TMPDIR para o host_tmp()
 * @param {[string, string][]} aliases pares (base, id) para alias_path()/needs_alias()
 * @returns {{ commands: boolean[], paths: boolean[], hosts: (string|null)[], aliases: [string, boolean][], max: number, rule: string }}
 */
function runPython(commands, paths, tmpdirs, aliases) {
  const script = [
    'import importlib.util, json, sys',
    `spec = importlib.util.spec_from_file_location("tmpdir_hook", ${JSON.stringify(HOOK)})`,
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'data = json.load(sys.stdin)',
    'commands = [m.command_hits(c) for c in data["commands"]]',
    'paths = [m.path_hits(p, cwd) for p, cwd in data["paths"]]',
    'hosts = []',
    'for t in data["tmpdirs"]:',
    '    import os; os.environ["TMPDIR"] = t; hosts.append(m.host_tmp())',
    'aliases = [[m.alias_path(b, k), m.needs_alias(b, k)] for b, k in data["aliases"]]',
    'print(json.dumps({"commands": commands, "paths": paths, "hosts": hosts, "aliases": aliases, "max": m.MAX_TMPDIR_BYTES, "rule": m.PROMPT_RULE}))',
  ].join('\n');
  // TMPDIR fora de /tmp: a isenção do scratch sob /tmp (host-dependente) não entra na conta.
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/', TMPDIR: path.resolve(process.env.TMPDIR ?? '/var/tmp') };
  const r = spawnSync('python3', ['-c', script], { input: JSON.stringify({ commands, paths, tmpdirs, aliases }), encoding: 'utf8', env, maxBuffer: 64 << 20 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

/** Corpus aleatório reprodutível (mesmo gerador do detect.test.js). */
function fuzzCorpus() {
  let seed = 99;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pool = ['/tmp', '/tmp', '/tmp/', '/tmp/.X11-unix', '/tmp/.ICE-unix/', '/', '//', '.', '..', '/.', '/..', '/../',
    '.X11-unix', 'a', ':', '=', '(', '{', ',', ' ', '\t', '\n', '"', "'", '`', '}', ')', ';', '|', '&', '<', '>', 'x/', '#', 'allow-literal-tmp'];
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < 3_000; i += 1) {
    let cmd = '';
    const n = 1 + Math.floor(rand() * 14);
    for (let j = 0; j < n; j += 1) cmd += pool[Math.floor(rand() * pool.length)];
    out.push(cmd);
  }
  return out;
}

describe('paridade com o hook Python da tmpdir-agent-skill', { skip }, () => {
  const extra = [
    // Casos que divergiam antes da normalização do token nos dois lados.
    'cp a /tmp/.ICE-unix/../x', 'ls /tmp/.X11-unix/../../etc/passwd', 'ls /tmp//.X11-unix', 'ls /tmp/./.X11-unix/X0',
    // Falsos positivos/negativos CONHECIDOS do contrato (os dois lados iguais).
    'grep -rn "/tmp" src/', 'git commit -m "fix: parar de gravar em /tmp"', 'ssh host \'ls -la /tmp\'',
    'export PATH=/tmp:$PATH', 'ls -d /tmp*', 'cp x /tmp$SUFFIX', 'curl file:///tmp/x', "sed 's#/tmp#x#'", 'ls /private/tmp/x',
  ];
  const commands = [...CONTRACT_HITS, ...CONTRACT_MISSES, ...MORE_HITS, ...MORE_MISSES, ...extra, ...fuzzCorpus()];
  /** @type {[string, string|null][]} */
  const paths = [
    ['/tmp', null], ['/tmp/', null], ['/tmp/x.txt', null], ['//tmp/x', null], ['/tmp/./x', null], ['/var/../tmp/x', null],
    ['/tmp/.X11-unix/../x', null], ['/tmp/.X11-unix/X0', null], ['/tmp/.ICE-unix', null], ['/var/tmp/x', null],
    ['/tmpfoo/x', null], ['tmp/x', null], ['x.txt', '/tmp/proj'], ['../../tmp/x', '/home/u'], ['x.txt', '/home/u'],
    ['/tmp//.X11-unix/X0', null], ['', null],
  ];
  const tmpdirs = [
    '/var/tmp/user-1000', '/var/tmp/user-1000/', '/var/tmp/user-1000/agent-scratch/claude/3f2b9c1e-aaaa',
    '/var/tmp/user-1000/agent-scratch/dsh/session-abc/tmp.XyZ', '/x/agent-scratch/claude/s/agent-scratch/dsh/k',
    '/var/tmp/agent-scratch', '/agent-scratch/dsh/k', '/tmp', '/var/tmp/agent-scratchy/x', '/a//b/./agent-scratch/dsh/k',
    // TMPDIR herdado que é um APELIDO curto (dsh lançado do bash de um agente).
    '/var/tmp/user-1000/agent-scratch/dsh/.s/abcd1234', '/var/tmp/user-1000/agent-scratch/claude/.s/1a2b3c4d/x',
  ];
  /** @type {[string, string][]} */
  const aliasCases = [];
  for (const base of ['/var/tmp/user-1000/agent-scratch/dsh', '/var/tmp/user-1000/agent-scratch/claude', '/agent-scratch/dsh', '/v/agent-scratch/dsh', `/${'x'.repeat(60)}/agent-scratch/dsh`]) {
    for (const key of ['session-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', '3f2b9c1e-aaaa-4bbb-8ccc-0123456789ab', 'abc', 'session-a', 'session-ab', 'session-abc', 'k'.repeat(41), 'k'.repeat(42), 'a.b_c-D'.repeat(20)]) {
      aliasCases.push([base, key]);
    }
  }
  const py = skip ? { commands: [], paths: [], hosts: [], aliases: [], max: 0, rule: '' } : runPython(commands, paths, tmpdirs, aliasCases);

  it(`comandos: ${commands.length} casos, mesmo veredito nos dois lados`, () => {
    const diverging = commands.filter((c, i) => commandUsesLiteralTmp(c) !== py.commands[i]);
    assert.deepEqual(diverging, []);
  });
  it(`caminhos de ferramenta de arquivo: ${paths.length} casos, mesmo veredito`, () => {
    const diverging = paths.filter(([p, cwd], i) => pathIsUnderTmp(p, cwd === null ? {} : { cwd }) !== py.paths[i]);
    assert.deepEqual(diverging, []);
  });
  it(`raiz do host (TMPDIR herdado de uma sessão-mãe): ${tmpdirs.length} casos, mesmo valor`, () => {
    assert.deepEqual(tmpdirs.map((t) => hostTmpdir(t)), py.hosts);
  });
  it(`apelido curto: ${aliasCases.length} pares (base, id), mesmo nome (.s/<sha256[:8]>) e mesmo limiar (${MAX_TMPDIR_BYTES} bytes)`, () => {
    assert.equal(py.max, MAX_TMPDIR_BYTES);
    assert.deepEqual(aliasCases.map(([base, key]) => needsAlias(base, key)), py.aliases.map(([, need]) => need));
    for (let i = 0; i < aliasCases.length; i += 1) {
      const [base, key] = /** @type {[string, string]} */ (aliasCases[i]);
      const name = /** @type {[string, boolean]} */ (py.aliases[i])[0];
      assert.equal(path.join(base, '.s', createHash('sha256').update(key).digest('hex').slice(0, 8)), name, `${base} ${key}`);
      if (needsAlias(base, key)) assert.equal(aliasCandidates(base, key)[0], name, `${base} ${key}`);
    }
  });
  it('regra do prompt: os dois lados avisam que o TMPDIR pode ser symlink (find/du/tar/cp -r com "$TMPDIR/")', () => {
    for (const rule of [PROMPT_RULE, py.rule]) {
      assert.ok(rule.includes('"$TMPDIR/"') && /symlink/.test(rule) && /find/.test(rule) && /cp -r/.test(rule), rule);
    }
  });
});
