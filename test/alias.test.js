// @ts-check
/**
 * Apelido curto `.s/<hash>` → `../<key>` (src/alias.js) e a integração com o
 * ScratchStore: criação, colisão (nunca reapontar), corrida (processos
 * reais em paralelo), queda para symlink(2) sem link(2) e remoção (só o link,
 * só com a pasta canônica fora do lugar).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ALIAS_HASH_LENGTHS,
  MAX_TMPDIR_BYTES,
  aliasCandidates,
  aliasHash,
  ensureAlias,
  isOwnAlias,
  needsAlias,
  unlinkAliases,
  unlinkStaleAlias,
} from '../src/alias.js';
import { realProc, parseStartTime } from '../src/owner.js';
import { ALIAS_RETRY_MS, ScratchStore, cleanupOwnSync, detachOwnSync, sharerName } from '../src/store.js';
import { fakeProc, manualClock, rmrf, tempRoot } from './helpers.js';

const ALIAS_JS = fileURLToPath(new URL('../src/alias.js', import.meta.url));
/** Id real de sessão do DSH (`session-<uuid>`, 44 caracteres). */
const SID = 'session-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
const OTHER_SID = 'session-99999999-8888-7777-6666-555555555555';
/** Hash fixo: força TODAS as chaves para os mesmos candidatos (colisão). */
const COLLIDE = 'ab'.repeat(32);
const collide = () => COLLIDE;
const UID = process.getuid?.() ?? -1;

const roots = /** @type {string[]} */ ([]);
after(() => { for (const r of roots) rmrf(r); });

/**
 * Base `<root>/agent-scratch/dsh` com o caminho LONGO o bastante para pedir
 * apelido (o TMPDIR dos testes pode ser curto ou longo).
 * @param {string} label
 */
function makeBase(label) {
  const root = tempRoot(label);
  roots.push(root);
  const base = path.join(root, 'agent-scratch', 'dsh');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  return { root, base };
}

/** @param {string} base @param {string} key */
function mkSession(base, key) {
  const dir = path.join(base, key);
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'work.txt'), key);
  return dir;
}

/** @param {string} base */
function aliasEntries(base) {
  const dir = path.join(base, '.s');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

describe('esquema do apelido (igual ao da skill: sha256[:8], alvo ../<key>, > 60 bytes)', () => {
  it('no layout real desta máquina: canônica 81 bytes, apelido 48 bytes', () => {
    const base = '/var/tmp/user-1000/agent-scratch/dsh';
    assert.equal(Buffer.byteLength(path.join(base, SID)), 81);
    assert.equal(needsAlias(base, SID), true);
    const [first] = aliasCandidates(base, SID);
    assert.equal(first, `${base}/.s/${createHash('sha256').update(SID).digest('hex').slice(0, 8)}`);
    assert.equal(Buffer.byteLength(/** @type {string} */ (first)), 48);
    assert.ok(Buffer.byteLength(/** @type {string} */ (first)) + 46 <= 107, 'cabe o SingletonSocket do Chromium');
  });

  it('candidatos em ordem crescente (8, 10, 12, 14, 16 hex), todos mais curtos que a canônica e ≤ 60 bytes aqui', () => {
    const base = '/var/tmp/user-1000/agent-scratch/dsh';
    const c = aliasCandidates(base, SID);
    assert.deepEqual(c.map((p) => path.basename(p).length), [...ALIAS_HASH_LENGTHS]);
    for (const p of c) assert.ok(Buffer.byteLength(p) <= MAX_TMPDIR_BYTES, p);
    assert.equal(aliasHash(SID), createHash('sha256').update(SID, 'utf8').digest('hex'));
  });

  it('sem apelido quando a canônica já é curta (≤ 60) ou quando o apelido não seria mais curto', () => {
    assert.equal(needsAlias('/v/agent-scratch/dsh', 'abc'), false);
    assert.equal(needsAlias('/agent-scratch/dsh', 'k'.repeat(41)), false, 'exatamente 60 bytes: fica o caminho canônico');
    assert.equal(needsAlias('/agent-scratch/dsh', 'k'.repeat(42)), true, '61 bytes: apelido');
    assert.equal(needsAlias('/var/tmp/user-1000/agent-scratch/dsh', 'session-a'), false, 'chave ≤ 10: o apelido nunca é mais curto');
    const long = `/${'x'.repeat(60)}/agent-scratch/dsh`;
    assert.equal(needsAlias(long, 'session-ab'), false);
    assert.deepEqual(aliasCandidates(long, 'session-abcd').map((p) => path.basename(p).length), [8], 'só os candidatos mais curtos que a canônica');
  });
});

describe('ensureAlias', () => {
  it('cria .s (0700) e o symlink exato ../<key>; idempotente; sem sobra de temporário', () => {
    const { base } = makeBase('alias-create');
    const dir = mkSession(base, SID);
    const a = ensureAlias(base, SID, { uid: UID });
    assert.equal(a, aliasCandidates(base, SID)[0]);
    assert.equal(fs.readlinkSync(/** @type {string} */ (a)), `../${SID}`);
    assert.equal(fs.realpathSync(/** @type {string} */ (a)), dir);
    assert.equal(fs.statSync(path.join(base, '.s')).mode & 0o777, 0o700);
    assert.equal(ensureAlias(base, SID, { uid: UID }), a);
    assert.deepEqual(aliasEntries(base), [path.basename(/** @type {string} */ (a))], 'um apelido só, nenhum .tmp-*');
    assert.equal(isOwnAlias(/** @type {string} */ (a), SID, UID), true);
    assert.equal(isOwnAlias(/** @type {string} */ (a), OTHER_SID, UID), false);
  });

  it('chave curta: nada é criado (nem .s)', () => {
    const { base } = makeBase('alias-short');
    mkSession(base, 'k');
    assert.equal(ensureAlias(base, 'k', { uid: UID }), null);
    assert.equal(fs.existsSync(path.join(base, '.s')), false);
  });

  it('colisão com o apelido de OUTRA sessão: nunca reaponta; usa o hash mais longo e fica com ele', () => {
    const { base } = makeBase('alias-collide');
    mkSession(base, SID);
    mkSession(base, OTHER_SID);
    const theirs = ensureAlias(base, OTHER_SID, { uid: UID, hashOf: collide });
    const [c8, c10] = aliasCandidates(base, SID, { hashOf: collide });
    assert.equal(theirs, c8);
    const mine = ensureAlias(base, SID, { uid: UID, hashOf: collide });
    assert.equal(mine, c10);
    assert.equal(fs.readlinkSync(/** @type {string} */ (c8)), `../${OTHER_SID}`, 'o apelido alheio ficou intacto');
    assert.equal(fs.readlinkSync(/** @type {string} */ (c10)), `../${SID}`);
    // O nome curto vaga depois: a sessão continua com o seu (estável, sem segundo apelido).
    fs.unlinkSync(/** @type {string} */ (c8));
    assert.equal(ensureAlias(base, SID, { uid: UID, hashOf: collide }), c10);
    assert.deepEqual(aliasEntries(base), [path.basename(/** @type {string} */ (c10))]);
  });

  it('nome ocupado por arquivo, pasta ou link pendurado alheio: pulado; todos ocupados → null, nada mexido', () => {
    const { base } = makeBase('alias-full');
    mkSession(base, SID);
    const c = aliasCandidates(base, SID, { hashOf: collide });
    fs.mkdirSync(path.join(base, '.s'), { mode: 0o700 });
    fs.writeFileSync(/** @type {string} */ (c[0]), 'arquivo');
    fs.mkdirSync(/** @type {string} */ (c[1]));
    fs.symlinkSync('../gone-session', /** @type {string} */ (c[2]));
    assert.equal(ensureAlias(base, SID, { uid: UID, hashOf: collide }), c[3]);
    fs.unlinkSync(/** @type {string} */ (c[3]));
    fs.symlinkSync('/etc', /** @type {string} */ (c[3]));
    fs.symlinkSync(`../${OTHER_SID}`, /** @type {string} */ (c[4]));
    const logs = /** @type {string[]} */ ([]);
    assert.equal(ensureAlias(base, SID, { uid: UID, hashOf: collide, log: (m) => logs.push(m) }), null);
    assert.match(logs.join('\n'), /ocupados/);
    assert.equal(fs.readFileSync(/** @type {string} */ (c[0]), 'utf8'), 'arquivo');
    assert.equal(fs.statSync(/** @type {string} */ (c[1])).isDirectory(), true);
    assert.equal(fs.readlinkSync(/** @type {string} */ (c[2])), '../gone-session', 'pendurado alheio não é reapontado');
    assert.equal(fs.readlinkSync(/** @type {string} */ (c[3])), '/etc');
    assert.equal(fs.readlinkSync(/** @type {string} */ (c[4])), `../${OTHER_SID}`);
    assert.equal(aliasEntries(base).some((n) => n.startsWith('.tmp-')), false);
  });

  it('corrida: outra sessão publica o MESMO nome entre o temporário e o link → EEXIST, nada substituído, próximo hash', () => {
    const { base } = makeBase('alias-race-other');
    mkSession(base, SID);
    const [c8, c10] = aliasCandidates(base, SID, { hashOf: collide });
    let raced = false;
    const a = ensureAlias(base, SID, {
      uid: UID,
      hashOf: collide,
      beforePublish: (candidate) => {
        if (raced) return;
        raced = true;
        fs.symlinkSync(`../${OTHER_SID}`, candidate);
      },
    });
    assert.equal(a, c10);
    assert.equal(fs.readlinkSync(/** @type {string} */ (c8)), `../${OTHER_SID}`);
    assert.equal(aliasEntries(base).some((n) => n.startsWith('.tmp-')), false);
  });

  it('corrida: outro processo da MESMA sessão publica o mesmo nome → reaproveitado, um apelido só', () => {
    const { base } = makeBase('alias-race-same');
    mkSession(base, SID);
    const [c8] = aliasCandidates(base, SID);
    const a = ensureAlias(base, SID, { uid: UID, beforePublish: (candidate) => fs.symlinkSync(`../${SID}`, candidate) });
    assert.equal(a, c8);
    assert.deepEqual(aliasEntries(base), [path.basename(/** @type {string} */ (c8))]);
  });

  it('sistema de arquivos sem link(2) de symlink (EPERM): cai para symlink(2), também sem substituir', () => {
    const { base } = makeBase('alias-nolink');
    mkSession(base, SID);
    const eperm = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
    const [c8, c10] = aliasCandidates(base, SID, { hashOf: collide });
    assert.equal(ensureAlias(base, SID, { uid: UID, hashOf: collide, link: eperm }), c8);
    fs.unlinkSync(/** @type {string} */ (c8));
    let raced = false;
    const a = ensureAlias(base, SID, {
      uid: UID,
      hashOf: collide,
      link: eperm,
      beforePublish: (candidate) => { if (!raced) { raced = true; fs.symlinkSync(`../${OTHER_SID}`, candidate); } },
    });
    assert.equal(a, c10);
    assert.equal(fs.readlinkSync(/** @type {string} */ (c8)), `../${OTHER_SID}`);
    assert.equal(aliasEntries(base).some((n) => n.startsWith('.tmp-')), false);
  });

  it('.s trocado por symlink: nada é criado no alvo e o apelido não é usado', () => {
    const { root, base } = makeBase('alias-swap');
    mkSession(base, SID);
    const victim = path.join(root, 'victim');
    fs.mkdirSync(victim);
    fs.symlinkSync(victim, path.join(base, '.s'));
    const logs = /** @type {string[]} */ ([]);
    assert.equal(ensureAlias(base, SID, { uid: UID, log: (m) => logs.push(m) }), null);
    assert.deepEqual(fs.readdirSync(victim), []);
    assert.match(logs.join('\n'), /symlink/);
  });

  it('.s trocado por symlink NO MEIO do laço de candidatos: nada é publicado no alvo e o apelido não é devolvido', () => {
    const { root, base } = makeBase('alias-swap-mid');
    mkSession(base, SID);
    const foreign = path.join(root, 'foreign');
    fs.mkdirSync(foreign);
    const [c8] = aliasCandidates(base, SID);
    fs.mkdirSync(path.join(base, '.s'), { mode: 0o700 });
    fs.writeFileSync(/** @type {string} */ (c8), 'ocupado'); // força o laço a seguir para o hash10
    let swapped = false;
    const logs = /** @type {string[]} */ ([]);
    const a = ensureAlias(base, SID, {
      uid: UID,
      log: (m) => {
        logs.push(m);
        if (swapped) return;
        swapped = true; // o log do c8 ocupado roda entre a conferência e o próximo candidato
        fs.renameSync(path.join(base, '.s'), path.join(root, 'old-s'));
        fs.symlinkSync(foreign, path.join(base, '.s'));
      },
    });
    assert.equal(a, null);
    assert.deepEqual(fs.readdirSync(foreign), [], 'nenhum link criado no diretório alheio');
    assert.match(logs.join('\n'), /trocado durante a criação/);
  });

  it('.s trocado logo DEPOIS da publicação (outra identidade): o apelido não é devolvido', () => {
    const { root, base } = makeBase('alias-swap-after');
    mkSession(base, SID);
    const logs = /** @type {string[]} */ ([]);
    const a = ensureAlias(base, SID, {
      uid: UID,
      log: (m) => logs.push(m),
      link: (existing, created) => {
        fs.linkSync(existing, created);
        // Troca por uma pasta REAL nova: mesma localização, outro inode.
        fs.renameSync(path.join(base, '.s'), path.join(root, 'old-s'));
        fs.mkdirSync(path.join(base, '.s'), { mode: 0o700 });
      },
    });
    assert.equal(a, null);
    assert.match(logs.join('\n'), /trocado durante a publicação/);
    assert.deepEqual(fs.readdirSync(path.join(base, '.s')), []);
  });

  it('corrida REAL entre processos: 18 processos, 3 sessões com o mesmo hash → um apelido por sessão, nenhum reapontado', async () => {
    const { base } = makeBase('alias-procs');
    const THIRD = 'session-33333333-4444-5555-6666-777777777777';
    for (const k of [SID, OTHER_SID, THIRD]) mkSession(base, k);
    const startAt = Date.now() + 700;
    const script = [
      `import { ensureAlias } from ${JSON.stringify(ALIAS_JS)};`,
      'const [base, key, startAt] = process.argv.slice(1);',
      'while (Date.now() < Number(startAt)) { /* barreira: todos publicam juntos */ }',
      `process.stdout.write(String(ensureAlias(base, key, { uid: ${UID}, hashOf: () => ${JSON.stringify(COLLIDE)} })));`,
    ].join('\n');
    /** @param {string} key @returns {Promise<string>} */
    const run = (key) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, base, key, String(startAt)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { err += c; });
      child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(err))));
    });
    const sessions = [SID, OTHER_SID, THIRD];
    const keys = Array.from({ length: 18 }, (_, i) => /** @type {string} */ (sessions[i % 3]));
    const results = await Promise.all(keys.map(run));
    /** @type {string[]} */
    const chosen = [];
    for (const k of sessions) {
      const got = new Set(results.filter((_, i) => keys[i] === k));
      assert.equal(got.size, 1, `${k}: ${[...got].join(',')}`);
      const [a] = [...got];
      assert.equal(fs.readlinkSync(/** @type {string} */ (a)), `../${k}`, 'cada apelido aponta para a SUA sessão');
      chosen.push(/** @type {string} */ (a));
    }
    assert.equal(new Set(chosen).size, 3);
    assert.deepEqual(aliasEntries(base), chosen.map((a) => path.basename(a)).sort(), 'três apelidos, nenhum .tmp-*');
  });
});

describe('unlinkAliases', () => {
  it('só com a canônica fora do lugar; só os links desta chave; nunca através do link', () => {
    const { root, base } = makeBase('alias-unlink');
    const dir = mkSession(base, SID);
    mkSession(base, OTHER_SID);
    const c8 = /** @type {string} */ (ensureAlias(base, OTHER_SID, { uid: UID, hashOf: collide }));
    const mine = /** @type {string} */ (ensureAlias(base, SID, { uid: UID, hashOf: collide }));
    assert.deepEqual(unlinkAliases(base, SID, { uid: UID, hashOf: collide }), [], 'canônica presente: fica');
    assert.equal(fs.readlinkSync(mine), `../${SID}`);
    // A canônica sai do lugar (rename para a lixeira, como na remoção real).
    const trash = path.join(base, '.trash-1-x');
    fs.renameSync(dir, trash);
    assert.deepEqual(unlinkAliases(base, SID, { uid: UID, hashOf: collide }), [mine]);
    assert.equal(fs.existsSync(mine), false);
    assert.equal(fs.readlinkSync(c8), `../${OTHER_SID}`, 'apelido de outra sessão no mesmo .s intacto');
    assert.equal(fs.readFileSync(path.join(trash, 'work.txt'), 'utf8'), SID, 'nada apagado através do link');
    assert.equal(fs.readFileSync(path.join(base, OTHER_SID, 'work.txt'), 'utf8'), OTHER_SID);
    // .s trocado por symlink: nada desligado no alvo.
    const victim = path.join(root, 'victim');
    fs.mkdirSync(victim);
    fs.symlinkSync(`../${SID}`, path.join(victim, aliasHash(SID).slice(0, 8)));
    fs.renameSync(path.join(base, '.s'), path.join(root, 'old-s'));
    fs.symlinkSync(victim, path.join(base, '.s'));
    assert.deepEqual(unlinkAliases(base, SID, { uid: UID }), []);
    assert.equal(fs.readdirSync(victim).length, 1);
  });

  it('retomada DEPOIS da 1ª conferência (a pasta volta antes do laço): nada é desligado', () => {
    const { base } = makeBase('alias-unlink-resume');
    const dir = mkSession(base, SID);
    const a = /** @type {string} */ (ensureAlias(base, SID, { uid: UID }));
    fs.rmSync(dir, { recursive: true });
    // hashOf roda depois da validação da chave e antes do laço: simula a retomada concorrente.
    const removed = unlinkAliases(base, SID, { uid: UID, hashOf: (k) => { fs.mkdirSync(dir, { mode: 0o700 }); return aliasHash(k); } });
    assert.deepEqual(removed, []);
    assert.equal(fs.readlinkSync(a), `../${SID}`, 'a sessão retomada continua com o apelido');
  });

  it('retomada na janela FINAL (entre a última conferência e o unlink): o apelido é republicado na hora', () => {
    const { base } = makeBase('alias-unlink-window');
    const dir = mkSession(base, SID);
    const a = /** @type {string} */ (ensureAlias(base, SID, { uid: UID }));
    fs.rmSync(dir, { recursive: true });
    const logs = /** @type {string[]} */ ([]);
    const removed = unlinkStaleAlias(base, SID, a, {
      uid: UID,
      log: (m) => logs.push(m),
      stillStale: () => { fs.mkdirSync(dir, { mode: 0o700 }); return true; },
    });
    assert.equal(removed, true, 'o link foi desligado');
    assert.equal(fs.readlinkSync(a), `../${SID}`, 'e republicado: a sessão retomada não fica sem apelido');
    assert.equal(fs.realpathSync(a), dir);
    assert.match(logs.join('\n'), /retomada durante a limpeza/);
  });

  it('unlinkStaleAlias só desliga o MESMO link (inode visto), com o texto exato, dentro de <base>/.s', () => {
    const { root, base } = makeBase('alias-unlink-same');
    const dir = mkSession(base, SID);
    const a = /** @type {string} */ (ensureAlias(base, SID, { uid: UID }));
    const seen = fs.lstatSync(a);
    fs.rmSync(dir, { recursive: true });
    fs.unlinkSync(a);
    fs.symlinkSync(`../${SID}`, a); // recriado: outro inode
    assert.equal(unlinkStaleAlias(base, SID, a, { uid: UID, seen }), false);
    assert.equal(unlinkStaleAlias(base, SID, a, { uid: UID, stillStale: () => false }), false, 'a decisão do chamador mudou: fica');
    const outside = path.join(root, 'elsewhere');
    fs.mkdirSync(outside);
    fs.symlinkSync(`../${SID}`, path.join(outside, 'x'));
    assert.equal(unlinkStaleAlias(base, SID, path.join(outside, 'x'), { uid: UID }), false, 'fora de <base>/.s: recusado');
    assert.equal(fs.lstatSync(path.join(outside, 'x')).isSymbolicLink(), true);
    assert.equal(unlinkStaleAlias(base, SID, a, { uid: UID }), true);
    assert.equal(fs.lstatSync(a, { throwIfNoEntry: false }), undefined);
  });
});

describe('ScratchStore + apelido', () => {
  /** @param {string} label */
  function make(label, proc = fakeProc({ self: process.pid, boot: 'b', procs: { [process.pid]: '1', 777: '2' } })) {
    const root = tempRoot(label);
    roots.push(root);
    const clock = manualClock();
    const store = new ScratchStore({ tmpRoot: root, baseDir: 'agent-scratch/dsh', proc, now: clock.now });
    return { root, clock, store };
  }

  it('session(): pasta canônica + apelido; alias() confere e recria um apelido apagado por fora', () => {
    const { store } = make('st-session');
    const { dir, alias } = store.session(SID);
    assert.equal(dir, path.join(store.base, SID));
    assert.equal(alias, aliasCandidates(store.base, SID)[0]);
    assert.equal(fs.realpathSync(/** @type {string} */ (alias)), dir);
    fs.unlinkSync(/** @type {string} */ (alias));
    assert.equal(store.alias(SID), alias);
    assert.equal(fs.readlinkSync(/** @type {string} */ (alias)), `../${SID}`);
    assert.equal(store.session('short').alias, null, 'chave curta: sem apelido');
  });

  it('removeSync / remove: pasta e apelido somem; o apelido de outra sessão fica', async () => {
    const { store } = make('st-remove');
    const a = /** @type {string} */ (store.session(SID).alias);
    const b = /** @type {string} */ (store.session(OTHER_SID).alias);
    assert.equal(store.removeSync(SID), true);
    assert.equal(fs.existsSync(path.join(store.base, SID)), false);
    assert.equal(fs.existsSync(a), false);
    assert.equal(fs.readlinkSync(b), `../${OTHER_SID}`);
    assert.equal(await store.remove(OTHER_SID, { wait: true }), true);
    assert.deepEqual(aliasEntries(store.base), []);
  });

  it('dono vivo de outro processo: remove não apaga a pasta nem o apelido', async () => {
    const { store } = make('st-alive');
    const a = /** @type {string} */ (store.session(SID).alias);
    fs.writeFileSync(store.markerPath(SID), JSON.stringify({ v: 1, pid: 777, start: '2', boot: 'b', createdAt: 0 }));
    assert.equal(await store.remove(SID, { wait: true }), false);
    assert.equal(fs.readlinkSync(a), `../${SID}`);
    assert.equal(fs.existsSync(path.join(store.base, SID)), true);
  });

  it('corrida de takeover (marcador muda depois do rename): a pasta volta e o apelido fica', async () => {
    const { store } = make('st-takeover');
    const a = /** @type {string} */ (store.session(SID).alias);
    const file = store.markerPath(SID);
    const before = JSON.parse(fs.readFileSync(file, 'utf8'));
    const st = fs.statSync(file);
    const removed = await store.remove(SID, {
      expect: { marker: before, mtimeMs: st.mtimeMs },
      wait: true,
      afterRename: () => fs.writeFileSync(file, JSON.stringify({ ...before, pid: 777, start: '2' })),
    });
    assert.equal(removed, false);
    assert.equal(fs.readlinkSync(a), `../${SID}`);
    assert.equal(fs.realpathSync(a), path.join(store.base, SID));
  });

  it('HMR de uma versão anterior (DirInfo sem dropAliases): a saída ainda apaga a pasta, e o apelido pendurado fica para a varredura', async () => {
    const { store, clock } = make('st-hmr');
    const a = /** @type {string} */ (store.session(SID).alias);
    const dir = path.join(store.base, SID);
    const state = (await import('../src/store.js')).processState();
    const info = /** @type {any} */ ({ ...state.dirs.get(dir) });
    delete info.dropAliases;
    state.dirs.set(dir, info);
    const report = detachOwnSync();
    assert.ok(report.detached.includes(dir), JSON.stringify(report));
    assert.equal(fs.existsSync(dir), false);
    assert.equal(fs.lstatSync(a).isSymbolicLink(), true, 'pendurado: a instância antiga não o conhecia');
    assert.equal(cleanupOwnSync().trashLeft, 0);
    const { sweepOnce } = await import('../src/sweep.js');
    const old = (clock.now() - 2 * 60 * 60_000) / 1000;
    fs.lutimesSync(a, old, old);
    const swept = await sweepOnce(store, { idleMs: 3 * 86_400_000, graceMs: 30 * 60_000, now: clock.now });
    assert.deepEqual(swept.aliasesCleared, [path.basename(a)]);
    assert.equal(fs.lstatSync(a, { throwIfNoEntry: false }), undefined);
  });

  it('saída do processo (detachOwnSync no SIGTERM, cleanupOwnSync no exit): apelido some junto com a pasta', () => {
    const { store } = make('st-exit');
    const a = /** @type {string} */ (store.session(SID).alias);
    const b = /** @type {string} */ (store.session(OTHER_SID).alias);
    const report = detachOwnSync();
    assert.ok(report.detached.includes(path.join(store.base, SID)));
    assert.equal(fs.existsSync(a), false);
    assert.equal(fs.existsSync(b), false);
    assert.equal(cleanupOwnSync().trashLeft, 0);
    assert.deepEqual(fs.readdirSync(store.base).sort(), ['.owners', '.s']);
    assert.deepEqual(aliasEntries(store.base), []);
  });

  it('apelido em cache com o .s trocado por symlink: alias() não o devolve mais', () => {
    const { root, store } = make('st-swap-cached');
    const a = /** @type {string} */ (store.session(SID).alias);
    const foreign = path.join(root, 'foreign');
    fs.mkdirSync(foreign);
    fs.symlinkSync(`../${SID}`, path.join(foreign, path.basename(a)));
    fs.renameSync(store.aliasDir, path.join(root, 'old-s'));
    fs.symlinkSync(foreign, store.aliasDir);
    assert.equal(store.alias(SID), null, 'o hook exporta a canônica');
    assert.deepEqual(fs.readdirSync(foreign), [path.basename(a)], 'nada criado nem apagado no alvo');
  });

  it('sem apelido possível (todos os nomes ocupados): back-off e log só na transição, não a cada bash', () => {
    const logs = /** @type {string[]} */ ([]);
    const root = tempRoot('st-backoff');
    roots.push(root);
    const clock = manualClock();
    const store = new ScratchStore({ tmpRoot: root, baseDir: 'agent-scratch/dsh', proc: fakeProc({ self: process.pid, boot: 'b', procs: { [process.pid]: '1' } }), now: clock.now, log: (m) => logs.push(m) });
    fs.mkdirSync(store.aliasDir, { mode: 0o700 });
    const names = aliasCandidates(store.base, SID);
    for (const c of names) fs.writeFileSync(c, 'x');
    for (let i = 0; i < 10; i += 1) assert.equal(store.session(SID).alias, null);
    const first = logs.length;
    assert.equal(first, names.length + 1, `uma rodada de log (${names.length} nomes + o resumo): ${logs.join(' | ')}`);
    clock.advance(ALIAS_RETRY_MS + 1);
    for (let i = 0; i < 10; i += 1) assert.equal(store.session(SID).alias, null);
    assert.equal(logs.length, first, 'nova tentativa depois do back-off, ainda falhando: sem log repetido');
    fs.unlinkSync(/** @type {string} */ (names[0]));
    assert.equal(store.session(SID).alias, null, 'ainda dentro do back-off');
    clock.advance(ALIAS_RETRY_MS + 1);
    assert.equal(store.session(SID).alias, names[0], 'volta depois do back-off');
    assert.match(String(logs.at(-1)), /restabelecido/);
  });
});

describe('sessão PARTILHADA por dois processos vivos (registro .owners/<key>@<pid>.share)', () => {
  const ME = process.pid;
  /** @param {string} label */
  function make(label) {
    const root = tempRoot(label);
    roots.push(root);
    const proc = fakeProc({ self: ME, boot: 'b', procs: { [ME]: '1', 777: '2' } });
    const store = new ScratchStore({ tmpRoot: root, baseDir: 'agent-scratch/dsh', proc, now: manualClock().now });
    return { root, store };
  }
  const live777 = JSON.stringify({ v: 1, pid: 777, start: '2', boot: 'b', createdAt: 0 });

  it('partilhador: registra-se ao usar a chave de outro dono vivo; ao sair, só o registro dele some', () => {
    const { store } = make('share-sharer');
    fs.mkdirSync(path.join(store.base, SID), { mode: 0o700 });
    fs.writeFileSync(store.markerPath(SID), live777);
    const { dir, alias } = store.session(SID);
    assert.equal(fs.readFileSync(store.markerPath(SID), 'utf8'), live777, 'marcador do dono vivo intacto');
    assert.equal(JSON.parse(fs.readFileSync(store.sharerPath(SID), 'utf8')).pid, ME);
    const report = detachOwnSync();
    assert.ok(report.skipped.includes(dir));
    assert.equal(fs.existsSync(store.sharerPath(SID)), false, 'registro do partilhador removido na saída dele');
    assert.equal(fs.existsSync(dir), true);
    assert.equal(fs.readlinkSync(/** @type {string} */ (alias)), `../${SID}`);
  });

  it('dono sai com um partilhador vivo: o marcador passa para ele; pasta, arquivos e apelido ficam', () => {
    const { store } = make('share-owner');
    const { dir, alias } = store.session(SID);
    fs.writeFileSync(path.join(dir, 'b-work.txt'), 'B');
    fs.writeFileSync(path.join(store.ownersDir, sharerName(SID, 777)), live777);
    const report = cleanupOwnSync();
    assert.ok(report.handedOver.includes(dir), JSON.stringify(report));
    assert.equal(fs.readFileSync(path.join(dir, 'b-work.txt'), 'utf8'), 'B');
    assert.equal(fs.readlinkSync(/** @type {string} */ (alias)), `../${SID}`);
    assert.equal(JSON.parse(fs.readFileSync(store.markerPath(SID), 'utf8')).pid, 777, 'o partilhador vivo é o novo dono');
  });

  it('registro de partilhador MORTO não segura nada: a saída do dono apaga como antes', () => {
    const { store } = make('share-dead');
    const { dir, alias } = store.session(SID);
    fs.writeFileSync(path.join(store.ownersDir, sharerName(SID, 555)), JSON.stringify({ v: 1, pid: 555, start: '9', boot: 'b', createdAt: 0 }));
    const report = cleanupOwnSync();
    assert.ok(report.removed.includes(dir), JSON.stringify(report));
    assert.equal(fs.existsSync(dir), false);
    assert.equal(fs.lstatSync(/** @type {string} */ (alias), { throwIfNoEntry: false }), undefined);
  });

  it('remove() não apaga uma pasta partilhada por processo vivo', async () => {
    const { store } = make('share-remove');
    const { dir } = store.session(SID);
    fs.writeFileSync(path.join(store.ownersDir, sharerName(SID, 777)), live777);
    assert.equal(await store.remove(SID, { wait: true }), false);
    assert.equal(fs.existsSync(dir), true);
  });

  it('processos REAIS: A (dono) sai normalmente enquanto B partilha — os arquivos e o apelido de B ficam; B herda e limpa ao sair', async () => {
    const root = tempRoot('share-procs');
    roots.push(root);
    const storeJs = fileURLToPath(new URL('../src/store.js', import.meta.url));
    const script = [
      `const { ScratchStore, installExitCleanup } = await import(${JSON.stringify(storeJs)});`,
      `const s = new ScratchStore({ tmpRoot: ${JSON.stringify(root)}, baseDir: 'agent-scratch/dsh' });`,
      'installExitCleanup();',
      `s.session(${JSON.stringify(SID)});`,
      "process.stdout.write('ready\\n');",
      'process.stdin.once("data", () => process.exit(0));',
    ].join('\n');
    const a = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'inherit'] });
    await new Promise((resolve) => a.stdout.once('data', resolve));
    const b = new ScratchStore({ tmpRoot: root, baseDir: 'agent-scratch/dsh' });
    const { dir, alias } = b.session(SID);
    assert.equal(JSON.parse(fs.readFileSync(b.markerPath(SID), 'utf8')).pid, a.pid, 'A é o dono');
    fs.writeFileSync(path.join(/** @type {string} */ (alias), 'b-work.txt'), 'B');
    a.stdin.write('x');
    await new Promise((resolve) => a.on('exit', resolve));
    assert.equal(fs.readFileSync(path.join(dir, 'b-work.txt'), 'utf8'), 'B', 'arquivo de B intacto');
    assert.equal(fs.realpathSync(/** @type {string} */ (alias)), dir, 'apelido de B intacto');
    const marker = JSON.parse(fs.readFileSync(b.markerPath(SID), 'utf8'));
    assert.equal(marker.pid, process.pid, 'o marcador passou para B');
    assert.equal(marker.start, parseStartTime(realProc.stat('self')));
    const report = detachOwnSync();
    assert.ok(report.detached.includes(dir), JSON.stringify(report));
    assert.equal(fs.existsSync(dir), false, 'B, agora dono, limpa ao sair');
    assert.equal(fs.lstatSync(/** @type {string} */ (alias), { throwIfNoEntry: false }), undefined);
    assert.equal(fs.existsSync(b.sharerPath(SID)), false);
    cleanupOwnSync();
  });
});
