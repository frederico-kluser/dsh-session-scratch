// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { aliasCandidates, needsAlias } from '../src/alias.js';
import * as plugin from '../src/index.js';
import { processState } from '../src/store.js';
import { PROMPT_RULE, SECTION_NAME, WARN_FILE_TEXT, WARN_TEXT, WARN_WORKDIR_TEXT } from '../src/text.js';
import { rmrf, tempRoot } from './helpers.js';

/** Contexto Cordis falso: coleta disposers como o fiber real faria. */
class FakeCtx {
  /** @param {{ agents?: unknown }} [services] */
  constructor(services = {}) {
    /** @type {(() => unknown)[]} */
    this.disposers = [];
    /** @type {Map<string, Function[]>} */
    this.listeners = new Map();
    /** @type {any[]} */
    this.sections = [];
    /** @type {any[]} */
    this.contributors = [];
    /** @type {[string, string][]} */
    this.logs = [];
    /** @type {string[]} */
    this.effects = [];
    this.services = /** @type {Record<string, unknown>} */ (services);
    const self = this;
    this.logger = {
      info: (/** @type {string} */ m) => self.logs.push(['info', m]),
      warn: (/** @type {string} */ m) => self.logs.push(['warn', m]),
      debug: (/** @type {string} */ m) => self.logs.push(['debug', m]),
    };
    this.systemPrompt = {
      getSectionOrder: (/** @type {string} */ n) => /** @type {Record<string, number>} */ ({ TOOL_BASH: 1000 })[n],
      section(/** @type {any} */ s) {
        if (self.sections.some((x) => x.name === s.name)) throw new Error(`duplicate section ${s.name}`);
        self.sections.push(s);
        return self.track(() => { self.sections = self.sections.filter((x) => x !== s); });
      },
    };
    this.shellEnv = {
      register(/** @type {any} */ c) {
        if (self.contributors.some((x) => x.name === c.name)) throw new Error(`duplicate contributor ${c.name}`);
        self.contributors.push(c);
        return self.track(() => { self.contributors = self.contributors.filter((x) => x !== c); });
      },
    };
    this.tools = {};
  }
  /** @param {() => unknown} d */
  track(d) { this.disposers.push(d); return d; }
  /** @param {string} name */
  get(name) { return this.services[name]; }
  /** @param {() => any} fn @param {string} [label] */
  effect(fn, label) { this.effects.push(label ?? 'anonymous'); return this.track(fn()); }
  /** @param {string} name @param {Function} fn */
  on(name, fn) {
    const list = this.listeners.get(name) ?? [];
    list.push(fn);
    this.listeners.set(name, list);
    return this.track(() => { this.listeners.set(name, (this.listeners.get(name) ?? []).filter((f) => f !== fn)); });
  }
  /** @param {string} name */
  count(name) { return (this.listeners.get(name) ?? []).length; }
  /** @param {string} name @param {...unknown} args */
  emit(name, ...args) { for (const fn of this.listeners.get(name) ?? []) fn(...args); }
  /**
   * Waterfall: listeners em ordem, o último cai no fallback.
   * @param {string} name @param {unknown[]} args @param {() => Promise<unknown>} fallback
   */
  waterfall(name, args, fallback) {
    const list = this.listeners.get(name) ?? [];
    /** @param {number} i @returns {Promise<any>} */
    const step = (i) => (i >= list.length ? fallback() : Promise.resolve(list[i](...args, () => step(i + 1))));
    return step(0);
  }
  async dispose() { for (const d of this.disposers.splice(0).reverse()) await d(); }
}

/**
 * @param {string} id
 * @param {{ parentSession?: string, origin?: string, cwd?: string }} [extra]
 */
const agent = (id, extra = {}) => ({ id, session: { header: { id, ...extra } } });

/**
 * O que o plugin exporta para uma chave: o apelido curto `.s/<hash8>` quando
 * a pasta canônica passa de 60 bytes (depende do comprimento do TMPDIR desta
 * máquina), senão a própria pasta.
 * @param {string} root
 * @param {string} key
 */
const exported = (root, key) => {
  const base = path.join(root, 'agent-scratch', 'dsh');
  return needsAlias(base, key) ? /** @type {string} */ (aliasCandidates(base, key)[0]) : path.join(base, key);
};

describe('apply() — fiação com ctx falso', () => {
  /** @type {string} */
  let root;
  /** @type {string|undefined} */
  let savedTmp;
  /** @type {string|undefined} */
  let savedBashEnv;
  /** @type {string|undefined} */
  let savedPrev;
  const roots = /** @type {string[]} */ ([]);

  beforeEach(() => {
    root = tempRoot('apply');
    roots.push(root);
    savedTmp = process.env.TMPDIR;
    savedBashEnv = process.env.BASH_ENV;
    savedPrev = process.env.SESSION_SCRATCH_PREV_BASH_ENV;
    process.env.TMPDIR = root;
    delete process.env.BASH_ENV;
    delete process.env.SESSION_SCRATCH_PREV_BASH_ENV;
  });
  afterEach(() => {
    const restore = (/** @type {string} */ k, /** @type {string|undefined} */ v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    restore('TMPDIR', savedTmp);
    restore('BASH_ENV', savedBashEnv);
    restore('SESSION_SCRATCH_PREV_BASH_ENV', savedPrev);
  });
  after(() => { for (const r of roots) rmrf(r); });

  it('exports nomeados: name/inject/apply, sem default', () => {
    assert.equal(plugin.name, 'dsh-session-scratch');
    assert.deepEqual(plugin.inject, ['systemPrompt', 'shellEnv', 'tools']);
    assert.equal(typeof plugin.apply, 'function');
    assert.equal(/** @type {any} */ (plugin).default, undefined);
    assert.ok(fs.existsSync(plugin.HOOK_PATH));
  });

  it('registra exatamente 1 seção, 1 contribuidor e os listeners; disposers desfazem tudo', async () => {
    const ctx = new FakeCtx();
    plugin.apply(ctx, undefined);
    assert.equal(ctx.sections.length, 1);
    const [section] = ctx.sections;
    assert.equal(section.name, SECTION_NAME);
    assert.equal(section.order, 1005);
    assert.equal(section.interpolate, false);
    assert.equal(section.text, PROMPT_RULE);
    assert.equal(typeof section.text, 'string');
    assert.ok(!section.text.includes('{{'), 'texto estático sem interpolação');
    assert.ok(!/\d{4}-\d{2}-\d{2}|session-/.test(section.text), 'sem data nem id de sessão');
    assert.match(section.text, /só \/tmp \(sandbox\), nada ali persiste entre comandos/, 'avisa do /tmp do sandbox');
    assert.ok(!section.text.includes('apagado quando a sessão termina'), 'sem promessa falsa de vida útil');
    assert.ok(section.text.includes('pode ser um symlink') && section.text.includes('"$TMPDIR/"'), 'avisa que find/du/tar/cp -r precisam de "$TMPDIR/" (o TMPDIR é o apelido)');
    assert.equal(ctx.contributors.length, 1);
    assert.equal(ctx.contributors[0].name, 'session-scratch');
    assert.deepEqual(Object.keys(ctx.contributors[0].variables).sort(), ['DSH_SCRATCH_CANONICAL_DIR', 'DSH_SCRATCH_DIR', 'DSH_SCRATCH_HOST_TMPDIR']);
    assert.equal(ctx.count('agent/created'), 1);
    assert.equal(ctx.count('agent/disposed'), 1);
    assert.equal(ctx.count('tools/pre-execute'), 1);
    assert.equal(ctx.count('tools/post-execute'), 0, 'post-execute só no modo warn');
    assert.equal(process.env.BASH_ENV, plugin.HOOK_PATH);
    await ctx.dispose();
    assert.equal(ctx.sections.length, 0);
    assert.equal(ctx.contributors.length, 0);
    assert.equal(ctx.count('tools/pre-execute'), 0);
    assert.equal(process.env.BASH_ENV, undefined, 'BASH_ENV restaurado (estava ausente)');
  });

  it('BASH_ENV anterior é encadeado e restaurado', async () => {
    process.env.BASH_ENV = '/home/u/.bash_env';
    const ctx = new FakeCtx();
    plugin.apply(ctx, {});
    assert.equal(process.env.BASH_ENV, plugin.HOOK_PATH);
    assert.equal(process.env.SESSION_SCRATCH_PREV_BASH_ENV, '/home/u/.bash_env');
    await ctx.dispose();
    assert.equal(process.env.BASH_ENV, '/home/u/.bash_env');
    assert.equal(process.env.SESSION_SCRATCH_PREV_BASH_ENV, undefined);
  });

  it('reaplicar (HMR) não acumula: 2 ciclos deixam o ambiente intacto', async () => {
    process.env.BASH_ENV = '/x/prev.sh';
    for (let i = 0; i < 2; i += 1) {
      const ctx = new FakeCtx();
      plugin.apply(ctx, {});
      assert.equal(process.env.SESSION_SCRATCH_PREV_BASH_ENV, '/x/prev.sh');
      await ctx.dispose();
    }
    assert.equal(process.env.BASH_ENV, '/x/prev.sh');
  });

  it('exportTmpdir:false não toca BASH_ENV; promptRule:false não registra seção', async () => {
    const ctx = new FakeCtx();
    plugin.apply(ctx, { exportTmpdir: false, promptRule: false });
    assert.equal(process.env.BASH_ENV, undefined);
    assert.equal(ctx.sections.length, 0);
    assert.equal(ctx.contributors.length, 1);
    await ctx.dispose();
  });

  it('resolve(): pasta <host-tmp>/agent-scratch/dsh/<id>; nunca lança', async () => {
    const ctx = new FakeCtx();
    plugin.apply(ctx, {});
    const c = ctx.contributors[0];
    const env = c.resolve({ agent: agent('session-abc') });
    const expected = path.join(root, 'agent-scratch', 'dsh', 'session-abc');
    assert.deepEqual(env, { DSH_SCRATCH_DIR: exported(root, 'session-abc'), DSH_SCRATCH_CANONICAL_DIR: expected, DSH_SCRATCH_HOST_TMPDIR: root });
    assert.equal(fs.realpathSync(env.DSH_SCRATCH_DIR), expected);
    assert.equal(fs.statSync(expected).mode & 0o777, 0o700);
    assert.deepEqual(c.resolve({}), {});
    assert.deepEqual(c.resolve(undefined), {});
    assert.deepEqual(c.resolve({ agent: { session: { header: { id: '' } } } }), {});
    assert.deepEqual(c.resolve({ agent: { session: null } }), {});
    // Id hostil é sanitizado, nunca escapa da base.
    const hostile = c.resolve({ agent: agent('../../evil') });
    assert.ok(hostile.DSH_SCRATCH_DIR.startsWith(path.join(root, 'agent-scratch', 'dsh') + path.sep));
    assert.ok(hostile.DSH_SCRATCH_CANONICAL_DIR.startsWith(path.join(root, 'agent-scratch', 'dsh') + path.sep));
    await ctx.dispose();
  });

  it('resolve(): id real do DSH (session-<uuid>) exporta o apelido curto .s/<hash8> → ../<id>; o apelido some com a pasta', async () => {
    const ctx = new FakeCtx();
    plugin.apply(ctx, {});
    const id = 'session-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
    const env = ctx.contributors[0].resolve({ agent: agent(id) });
    const base = path.join(root, 'agent-scratch', 'dsh');
    assert.equal(env.DSH_SCRATCH_CANONICAL_DIR, path.join(base, id));
    assert.equal(env.DSH_SCRATCH_DIR, aliasCandidates(base, id)[0]);
    assert.match(env.DSH_SCRATCH_DIR, /\/\.s\/[0-9a-f]{8}$/);
    assert.ok(Buffer.byteLength(env.DSH_SCRATCH_DIR) < Buffer.byteLength(env.DSH_SCRATCH_CANONICAL_DIR));
    assert.equal(fs.readlinkSync(env.DSH_SCRATCH_DIR), `../${id}`);
    assert.equal(fs.statSync(path.join(base, '.s')).mode & 0o777, 0o700);
    // Apelido apagado por fora (rm manual): a próxima chamada o recria.
    fs.unlinkSync(env.DSH_SCRATCH_DIR);
    assert.equal(ctx.contributors[0].resolve({ agent: agent(id) }).DSH_SCRATCH_DIR, env.DSH_SCRATCH_DIR);
    assert.equal(fs.readlinkSync(env.DSH_SCRATCH_DIR), `../${id}`);
    await ctx.dispose();
  });

  it('subagentes partilham a pasta da raiz; agent/disposed NÃO apaga (reload do web mantém o rascunho)', async () => {
    const live = new Map();
    const parent = agent('session-root');
    const child = agent('session-child', { parentSession: 'session-root', origin: 'subagent' });
    live.set('session-root', parent);
    live.set('session-child', child);
    const ctx = new FakeCtx({ agents: { get: (/** @type {string} */ id) => live.get(id) } });
    plugin.apply(ctx, {});
    ctx.emit('agent/created', { agent: parent, source: 'startup' });
    ctx.emit('agent/created', { agent: child, source: 'startup' });
    const rootDir = path.join(root, 'agent-scratch', 'dsh', 'session-root');
    assert.ok(fs.existsSync(rootDir));
    assert.equal(ctx.contributors[0].resolve({ agent: child }).DSH_SCRATCH_CANONICAL_DIR, rootDir);
    assert.equal(ctx.contributors[0].resolve({ agent: child }).DSH_SCRATCH_DIR, exported(root, 'session-root'));
    assert.equal(fs.existsSync(path.join(root, 'agent-scratch', 'dsh', 'session-child')), false);
    fs.writeFileSync(path.join(rootDir, 'intermediario.txt'), 'x');
    ctx.emit('agent/disposed', { agent: child });
    assert.ok(fs.existsSync(rootDir), 'filho partilhado não apaga a pasta da raiz');
    // Reload do SessionController (web): o agente é descartado e retomado sob demanda.
    ctx.emit('agent/disposed', { agent: parent });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.readFileSync(path.join(rootDir, 'intermediario.txt'), 'utf8'), 'x', 'o rascunho sobrevive ao reload');
    ctx.emit('agent/created', { agent: parent, source: 'resume' });
    assert.equal(ctx.contributors[0].resolve({ agent: parent }).DSH_SCRATCH_CANONICAL_DIR, rootDir);
    // A pasta continua deste processo: a saída real a apaga.
    assert.equal(processState().dirs.has(rootDir), true);
    await ctx.dispose();
  });

  it('dsh lançado do bash de outro agente (TMPDIR herdado aninhado): base no host, sem aninhar', async () => {
    const nested = path.join(root, 'agent-scratch', 'claude', '3f2b9c1e-aaaa');
    fs.mkdirSync(nested, { recursive: true, mode: 0o700 });
    process.env.TMPDIR = nested;
    const ctx = new FakeCtx();
    plugin.apply(ctx, {});
    const env = ctx.contributors[0].resolve({ agent: agent('session-n') });
    assert.equal(env.DSH_SCRATCH_CANONICAL_DIR, path.join(root, 'agent-scratch', 'dsh', 'session-n'));
    assert.equal(env.DSH_SCRATCH_DIR, exported(root, 'session-n'));
    assert.equal(env.DSH_SCRATCH_HOST_TMPDIR, nested, 'o hook compara com o TMPDIR que o bash herda');
    assert.equal(fs.existsSync(path.join(nested, 'agent-scratch')), false);
    await ctx.dispose();
  });

  it('a base some com o DSH no ar: o próximo bash recria tudo (sem TMPDIR compartilhado em silêncio)', async () => {
    const ctx = new FakeCtx();
    plugin.apply(ctx, {});
    const c = ctx.contributors[0];
    const first = c.resolve({ agent: agent('session-v') });
    fs.rmSync(path.join(root, 'agent-scratch', 'dsh'), { recursive: true });
    const again = c.resolve({ agent: agent('session-v') });
    assert.equal(again.DSH_SCRATCH_DIR, first.DSH_SCRATCH_DIR);
    assert.equal(again.DSH_SCRATCH_CANONICAL_DIR, first.DSH_SCRATCH_CANONICAL_DIR);
    assert.equal(fs.statSync(again.DSH_SCRATCH_CANONICAL_DIR).isDirectory(), true);
    assert.equal(fs.realpathSync(again.DSH_SCRATCH_DIR), again.DSH_SCRATCH_CANONICAL_DIR, 'apelido (se houver) recriado junto');
    assert.equal(ctx.logs.filter(([l]) => l === 'warn').length, 0);
    await ctx.dispose();
  });

  it('agent/created e agent/disposed nunca lançam', async () => {
    const ctx = new FakeCtx();
    plugin.apply(ctx, {});
    assert.doesNotThrow(() => ctx.emit('agent/created', {}));
    assert.doesNotThrow(() => ctx.emit('agent/created', { agent: { session: { header: { id: '' } } } }));
    assert.doesNotThrow(() => ctx.emit('agent/disposed', undefined));
    assert.doesNotThrow(() => ctx.emit('agent/disposed', { agent: { session: { header: { id: 'never-created' } } } }));
    await ctx.dispose();
  });

  it('guard deny: nega /tmp literal no bash e em write/edit com o motivo em pt-BR', async () => {
    const ctx = new FakeCtx();
    plugin.apply(ctx, {});
    const allow = () => Promise.resolve({ kind: 'allow' });
    const a = agent('session-g', { cwd: '/home/u/proj' });
    /** @param {string} name @param {unknown} args */
    const run = (name, args) => ctx.waterfall('tools/pre-execute', [{ name, arguments: args, agent: a }], allow);

    const denied = await run('bash', { command: 'echo hi > /tmp/x', description: 'd' });
    assert.equal(denied.kind, 'deny');
    assert.match(denied.reason, /^Bloqueado: este comando usa o caminho literal \/tmp\./);
    assert.match(denied.reason, /"\$TMPDIR"/);
    assert.match(denied.reason, /mktemp -d/);
    assert.match(denied.reason, /execute de novo o comando corrigido/);
    assert.match(denied.reason, /# allow-literal-tmp/);
    assert.match(denied.reason, /usuário pediu \/tmp explicitamente/);
    // Marcador na PRIMEIRA linha: no fim, colado ao terminador de um heredoc, ele o quebraria.
    assert.match(denied.reason, /sozinho na primeira linha do comando/);

    assert.deepEqual(await run('bash', { command: 'echo hi > "$TMPDIR/x"', description: 'd' }), { kind: 'allow' });
    assert.deepEqual(await run('bash', { command: 'echo hi > /tmp/x # allow-literal-tmp', description: 'd' }), { kind: 'allow' });
    assert.deepEqual(await run('bash', { command: 'ls /tmp/.X11-unix', description: 'd' }), { kind: 'allow' });
    const wd = await run('bash', { command: 'npm test', description: 'd', workdir: '/tmp/proj' });
    assert.equal(wd.kind, 'deny');
    assert.match(wd.reason, /^Bloqueado: o workdir desta chamada fica em \/tmp\./);
    assert.match(wd.reason, /Omita o workdir \(ele não expande variáveis\)/);
    assert.match(wd.reason, /cd "\$TMPDIR" &&/);

    const fileDenied = await run('write', { file_path: '/tmp/a.txt', content: 'x' });
    assert.equal(fileDenied.kind, 'deny');
    assert.match(fileDenied.reason, /^Bloqueado: este caminho fica em \/tmp\./);
    assert.match(fileDenied.reason, /echo "\$TMPDIR"/);
    assert.match(fileDenied.reason, /se ele mostrar só \/tmp, use um caminho no workspace/);
    assert.match(fileDenied.reason, /workspace desta sessão está sob \/tmp, grave pelo bash com caminho relativo/);
    assert.equal((await run('edit', { file_path: '/tmp/a.txt', old_string: 'a', new_string: 'b' })).kind, 'deny');
    assert.deepEqual(await run('read', { file_path: '/tmp/a.txt' }), { kind: 'allow' });
    // Sem agente (chamada de host) a guarda continua valendo.
    assert.equal((await ctx.waterfall('tools/pre-execute', [{ name: 'bash', arguments: { command: 'cd /tmp' } }], allow)).kind, 'deny');
    // O motivo é estático: idêntico entre chamadas.
    assert.equal((await run('bash', { command: 'cat /tmp/a', description: 'd' })).reason, denied.reason);
    await ctx.dispose();
  });

  it('guard warn: não nega e anexa o aviso ao resultado', async () => {
    const ctx = new FakeCtx();
    plugin.apply(ctx, { guard: 'warn' });
    assert.equal(ctx.count('tools/post-execute'), 1);
    const exec = { name: 'bash', arguments: { command: 'echo > /tmp/x', description: 'd' }, agent: agent('session-w') };
    assert.deepEqual(await ctx.waterfall('tools/pre-execute', [exec], () => Promise.resolve({ kind: 'allow' })), { kind: 'allow' });
    const result = { isError: false, content: [{ type: 'text', text: 'ok' }] };
    const d = await ctx.waterfall('tools/post-execute', [exec, result], () => Promise.resolve({ kind: 'accept' }));
    assert.deepEqual(d, { kind: 'accept', content: [{ type: 'text', text: 'ok' }, { type: 'text', text: WARN_TEXT }] });
    // Decisão de outro listener (content trocado / block) é respeitada.
    const replaced = await ctx.waterfall('tools/post-execute', [exec, result], () => Promise.resolve({ kind: 'accept', content: [] }));
    assert.deepEqual(replaced, { kind: 'accept', content: [] });
    const blocked = await ctx.waterfall('tools/post-execute', [exec, result], () => Promise.resolve({ kind: 'block', feedback: [] }));
    assert.equal(blocked.kind, 'block');
    const fileExec = { name: 'write', arguments: { file_path: '/tmp/a.txt', content: 'x' }, agent: agent('session-w') };
    const fd = await ctx.waterfall('tools/post-execute', [fileExec, result], () => Promise.resolve({ kind: 'accept' }));
    assert.equal(fd.content.at(-1).text, WARN_FILE_TEXT, 'write/edit recebe o aviso de caminho, não o de comando');
    const wdExec = { name: 'bash', arguments: { command: 'ls', workdir: '/tmp' }, agent: agent('session-w') };
    const wdd = await ctx.waterfall('tools/post-execute', [wdExec, result], () => Promise.resolve({ kind: 'accept' }));
    assert.equal(wdd.content.at(-1).text, WARN_WORKDIR_TEXT);
    const clean = { ...exec, arguments: { command: 'echo > "$TMPDIR/x"' } };
    assert.deepEqual(await ctx.waterfall('tools/post-execute', [clean, result], () => Promise.resolve({ kind: 'accept' })), { kind: 'accept' });
    await ctx.dispose();
  });

  it('guard off: nada é negado', async () => {
    const ctx = new FakeCtx();
    plugin.apply(ctx, { guard: 'off' });
    const d = await ctx.waterfall('tools/pre-execute', [{ name: 'bash', arguments: { command: 'echo > /tmp/x' } }], () => Promise.resolve({ kind: 'allow' }));
    assert.deepEqual(d, { kind: 'allow' });
    assert.equal(ctx.count('tools/post-execute'), 0);
    await ctx.dispose();
  });

  it('config inválida lança dentro de apply (sem registrar nada)', () => {
    const ctx = new FakeCtx();
    assert.throws(() => plugin.apply(ctx, { guard: 'block' }), TypeError);
    assert.throws(() => plugin.apply(ctx, { idleDays: 0 }), TypeError);
    assert.throws(() => plugin.apply(ctx, { baseDir: '/etc' }), TypeError);
    assert.equal(ctx.sections.length + ctx.contributors.length + ctx.disposers.length, 0);
    assert.equal(process.env.BASH_ENV, undefined);
  });

  it('base que é symlink faz apply lançar', () => {
    fs.mkdirSync(path.join(root, 'elsewhere'));
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'agent-scratch'));
    assert.throws(() => plugin.apply(new FakeCtx(), {}), /symlink/);
  });

  it('texto do prompt é idêntico entre aplicações (cache estável)', async () => {
    const a = new FakeCtx();
    plugin.apply(a, {});
    const b = new FakeCtx();
    await a.dispose();
    plugin.apply(b, {});
    assert.equal(b.sections[0].text, PROMPT_RULE);
    await b.dispose();
  });
});
