// @ts-check
/**
 * Testes REAIS do hooks/bash-env.sh: cada caso dispara `bash -c` com
 * BASH_ENV apontando para o hook, exatamente como o DSH faz.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { HOOK_PATH } from '../src/index.js';
import { rmrf, tempRoot } from './helpers.js';

const PRINT = 'printf "%s|%s|%s" "${TMPDIR-<unset>}" "${TMP-<unset>}" "${TEMP-<unset>}"';
const PRINT_ALL = 'printf "%s|%s|%s|%s|%s" "${TMPDIR-<unset>}" "${TMP-<unset>}" "${TEMP-<unset>}" "${TMPPREFIX-<unset>}" "${DSH_SCRATCH_DIR-<unset>}"';
const hasPython = spawnSync('python3', ['--version']).status === 0;
const hasZsh = spawnSync('zsh', ['-c', 'true']).status === 0;

/**
 * @param {string} command
 * @param {Record<string, string|undefined>} env
 * @param {string[]} [flags]
 * @param {string[]} [argv] $0 $1 … depois do comando
 */
function bash(command, env, flags = [], argv = []) {
  /** @type {Record<string, string>} */
  const clean = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/', BASH_ENV: HOOK_PATH };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete clean[k];
    else clean[k] = v;
  }
  // stdin = /dev/null como no DSH (bash-local usa stdio.stdin 'ignore'). Com
  // stdin socket (o 'pipe' do Node) e sem SHLVL o bash lê ~/.bashrc em vez do
  // BASH_ENV (heurística de rshd/sshd do bash) — ver README, lacunas.
  const r = spawnSync('bash', [...flags, '-c', command, ...argv], { env: clean, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('hooks/bash-env.sh (bash real)', () => {
  const root = tempRoot('bashenv');
  after(() => rmrf(root));
  const host = path.join(root, 'host-tmp');
  fs.mkdirSync(host);
  const scratch = path.join(host, 'agent-scratch', 'dsh', 'session-1');
  // A base é do plugin (criada junto com o .owners); o hook só recria a folha.
  fs.mkdirSync(path.dirname(scratch), { recursive: true, mode: 0o700 });

  it('sem DSH_SCRATCH_DIR: TMPDIR inalterado e nada criado', () => {
    const r = bash(PRINT, { TMPDIR: host, DSH_SCRATCH_HOST_TMPDIR: host });
    assert.deepEqual(r, { code: 0, out: `${host}|<unset>|<unset>`, err: '' });
    assert.deepEqual(fs.readdirSync(path.dirname(scratch)), [], 'nada criado na base');
  });

  it('com DSH_SCRATCH_DIR: TMPDIR/TMP/TEMP = pasta (criada 0700 se faltar)', () => {
    const r = bash(PRINT, { TMPDIR: host, DSH_SCRATCH_DIR: scratch, DSH_SCRATCH_HOST_TMPDIR: host });
    assert.deepEqual(r, { code: 0, out: `${scratch}|${scratch}|${scratch}`, err: '' });
    assert.equal(fs.statSync(scratch).mode & 0o777, 0o700);
  });

  it('base ausente: o hook NÃO cria a base (nem a pasta) e deixa o TMPDIR', () => {
    const orphanBase = path.join(host, 'agent-scratch', 'dsh-missing');
    const r = bash(PRINT, { TMPDIR: host, DSH_SCRATCH_DIR: path.join(orphanBase, 'session-2'), DSH_SCRATCH_HOST_TMPDIR: host });
    assert.deepEqual(r, { code: 0, out: `${host}|<unset>|<unset>`, err: '' });
    assert.equal(fs.existsSync(orphanBase), false);
  });

  it('mktemp e mktemp -d caem dentro da pasta da sessão', () => {
    const r = bash('f=$(mktemp) && d=$(mktemp -d) && printf "%s\\n%s" "$f" "$d"', { TMPDIR: host, DSH_SCRATCH_DIR: scratch, DSH_SCRATCH_HOST_TMPDIR: host });
    assert.equal(r.code, 0, r.err);
    for (const line of r.out.split('\n')) assert.ok(line.startsWith(`${scratch}/`), line);
  });

  it('TMPDIR ausente no processo também é trocado', () => {
    const r = bash(PRINT, { TMPDIR: undefined, DSH_SCRATCH_DIR: scratch, DSH_SCRATCH_HOST_TMPDIR: '/tmp' });
    assert.equal(r.out, `${scratch}|${scratch}|${scratch}`);
  });

  it('TMPDIR do host com barra final ainda conta como default', () => {
    const r = bash(PRINT, { TMPDIR: `${host}/`, DSH_SCRATCH_DIR: scratch, DSH_SCRATCH_HOST_TMPDIR: host });
    assert.equal(r.out, `${scratch}|${scratch}|${scratch}`);
  });

  it('bash aninhado mantém o mesmo valor', () => {
    const r = bash(`bash -c '${PRINT}'; echo; bash -c "bash -c 'echo \\$TMPDIR'"`, { TMPDIR: host, DSH_SCRATCH_DIR: scratch, DSH_SCRATCH_HOST_TMPDIR: host });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.out.trim().split('\n'), [`${scratch}|${scratch}|${scratch}`, scratch]);
  });

  it('override explícito do usuário é mantido', () => {
    const custom = path.join(root, 'custom');
    fs.mkdirSync(custom);
    const env = { TMPDIR: host, DSH_SCRATCH_DIR: scratch, DSH_SCRATCH_HOST_TMPDIR: host };
    assert.equal(bash(`TMPDIR=${custom} bash -c 'echo $TMPDIR'`, env).out.trim(), custom);
    assert.equal(bash('echo $TMPDIR', { ...env, TMPDIR: custom }).out.trim(), custom);
    assert.equal(bash(`TMPDIR=${custom} mktemp -u`, env).out.startsWith(`${custom}/`), true);
  });

  it('pasta não gravável e host gravável: TMPDIR fica como estava (sem erro)', () => {
    const locked = path.join(root, 'locked');
    fs.mkdirSync(locked, { mode: 0o500 });
    fs.chmodSync(locked, 0o500);
    const r = bash(PRINT, { TMPDIR: host, DSH_SCRATCH_DIR: path.join(locked, 'session-x'), DSH_SCRATCH_HOST_TMPDIR: host });
    assert.deepEqual(r, { code: 0, out: `${host}|<unset>|<unset>`, err: '' });
  });

  it('pasta existente mas read-only (sonda de escrita) também cai fora', () => {
    const ro = path.join(root, 'ro-session');
    fs.mkdirSync(ro, { mode: 0o500 });
    fs.chmodSync(ro, 0o500);
    const r = bash(PRINT, { TMPDIR: host, DSH_SCRATCH_DIR: ro, DSH_SCRATCH_HOST_TMPDIR: host });
    assert.deepEqual(r, { code: 0, out: `${host}|<unset>|<unset>`, err: '' });
  });

  it('sandbox (pasta e host não graváveis): cai para /tmp, o tmpfs privado do bwrap', () => {
    const roHost = path.join(root, 'ro-host');
    fs.mkdirSync(roHost, { mode: 0o500 });
    fs.chmodSync(roHost, 0o500);
    const r = bash(PRINT, { TMPDIR: roHost, DSH_SCRATCH_DIR: path.join(roHost, 'agent-scratch', 'dsh', 's'), DSH_SCRATCH_HOST_TMPDIR: roHost });
    assert.equal(r.code, 0);
    assert.equal(r.err, '');
    assert.equal(r.out, '/tmp|/tmp|/tmp');
  });

  it('sandbox com apelido: DSH_SCRATCH_DIR acompanha o TMPDIR (/tmp gravável), não o apelido read-only', () => {
    const roHost = path.join(root, 'ro-host-alias');
    const roBase = path.join(roHost, 'agent-scratch', 'dsh');
    fs.mkdirSync(path.join(roBase, '.s'), { recursive: true, mode: 0o700 });
    fs.symlinkSync('../session-ro', path.join(roBase, '.s', 'aaaa1111'));
    for (const d of [roBase, roHost]) fs.chmodSync(d, 0o500);
    const env = { TMPDIR: roHost, DSH_SCRATCH_DIR: path.join(roBase, '.s', 'aaaa1111'), DSH_SCRATCH_CANONICAL_DIR: path.join(roBase, 'session-ro'), DSH_SCRATCH_HOST_TMPDIR: roHost };
    assert.deepEqual(bash(PRINT_ALL, env), { code: 0, out: '/tmp|/tmp|/tmp|/tmp/zsh|/tmp', err: '' });
    assert.equal(bash(`bash -c '${PRINT_ALL}'`, env).out, '/tmp|/tmp|/tmp|/tmp/zsh|/tmp', 'bash aninhado no sandbox: igual');
    // Quando o hook NÃO troca o TMPDIR (pasta inutilizável, host gravável), DSH_SCRATCH_DIR fica
    // como o plugin publicou — documentado: só é igual ao TMPDIR quando o hook o trocou.
    const locked = path.join(root, 'locked-alias');
    fs.mkdirSync(locked, { mode: 0o500 });
    fs.chmodSync(locked, 0o500);
    const published = path.join(locked, '.s', 'bbbb2222');
    assert.deepEqual(bash(PRINT_ALL, { TMPDIR: host, DSH_SCRATCH_DIR: published, DSH_SCRATCH_CANONICAL_DIR: path.join(locked, 'x'), DSH_SCRATCH_HOST_TMPDIR: host }),
      { code: 0, out: `${host}|<unset>|<unset>|<unset>|${published}`, err: '' });
  });

  it('BASH_ENV anterior é encadeado (e o hook não se re-sourcea em laço)', () => {
    const prev = path.join(root, 'prev-env.sh');
    fs.writeFileSync(prev, 'export FROM_PREV=yes\n');
    const env = { TMPDIR: host, DSH_SCRATCH_DIR: scratch, DSH_SCRATCH_HOST_TMPDIR: host, SESSION_SCRATCH_PREV_BASH_ENV: prev };
    assert.equal(bash('echo "$FROM_PREV $TMPDIR"', env).out.trim(), `yes ${scratch}`);
    assert.equal(bash('echo "$FROM_PREV $TMPDIR"', { ...env, DSH_SCRATCH_DIR: undefined }).out.trim(), `yes ${host}`);
    const self = bash('echo ok', { ...env, SESSION_SCRATCH_PREV_BASH_ENV: HOOK_PATH });
    assert.deepEqual(self, { code: 0, out: 'ok\n', err: '' });
    const missing = bash('echo ok', { ...env, SESSION_SCRATCH_PREV_BASH_ENV: path.join(root, 'nope.sh') });
    assert.deepEqual(missing, { code: 0, out: 'ok\n', err: '' });
  });

  it('marcador de escape: na 1ª linha preserva o heredoc; colado ao terminador o corrompe (por isso o texto pede a 1ª linha)', () => {
    const out = path.join(root, 'heredoc.txt');
    const first = bash(`# allow-literal-tmp\ncat > '${out}' <<'EOF'\nlinha\nEOF\necho fim`, {});
    assert.equal(first.code, 0, first.err);
    assert.equal(first.out, 'fim\n');
    assert.equal(fs.readFileSync(out, 'utf8'), 'linha\n');
    const last = bash(`cat > '${out}' <<'EOF'\nlinha\nEOF # allow-literal-tmp`, {});
    assert.equal(last.code, 0, 'o bash nem falha');
    assert.equal(fs.readFileSync(out, 'utf8'), 'linha\nEOF # allow-literal-tmp\n', 'o terminador virou conteúdo');
  });

  describe('apelido curto (DSH_SCRATCH_DIR = .s/<hash> → ../<id>, DSH_SCRATCH_CANONICAL_DIR = pasta real)', () => {
    const base = path.dirname(scratch);
    const aliasDir = path.join(base, '.s');
    const alias = path.join(aliasDir, 'abcd1234');
    before(() => {
      fs.mkdirSync(aliasDir, { recursive: true, mode: 0o700 });
      fs.symlinkSync('../session-1', alias);
    });
    const env = { TMPDIR: host, DSH_SCRATCH_DIR: alias, DSH_SCRATCH_CANONICAL_DIR: scratch, DSH_SCRATCH_HOST_TMPDIR: host };

    it('exporta o apelido em TMPDIR/TMP/TEMP, TMPPREFIX=<apelido>/zsh e DSH_SCRATCH_DIR igual ao TMPDIR', () => {
      const r = bash(PRINT_ALL, env);
      assert.deepEqual(r, { code: 0, out: `${alias}|${alias}|${alias}|${alias}/zsh|${alias}`, err: '' });
      const made = bash('mktemp -d', env).out.trim();
      assert.ok(made.startsWith(`${alias}/`), made);
      assert.ok(fs.realpathSync(made).startsWith(`${scratch}/`), 'o arquivo mora na pasta canônica');
    });

    it('pasta canônica sumiu (apelido pendurado): o hook recria SÓ a folha e o apelido volta a valer', () => {
      rmrf(scratch);
      assert.equal(fs.existsSync(alias), false, 'pendurado');
      const r = bash(PRINT, env);
      assert.deepEqual(r, { code: 0, out: `${alias}|${alias}|${alias}`, err: '' });
      assert.equal(fs.statSync(scratch).mode & 0o777, 0o700);
    });

    it('apelido apontando para OUTRA pasta, ausente ou que é pasta real: exporta o caminho canônico', () => {
      const other = path.join(base, 'session-2');
      fs.mkdirSync(other, { mode: 0o700 });
      const wrong = path.join(aliasDir, 'ffff0000');
      fs.symlinkSync('../session-2', wrong);
      const realDir = path.join(aliasDir, 'eeee0000');
      fs.mkdirSync(realDir);
      for (const a of [wrong, path.join(aliasDir, 'missing0'), realDir]) {
        const r = bash(PRINT_ALL, { ...env, DSH_SCRATCH_DIR: a });
        assert.deepEqual(r, { code: 0, out: `${scratch}|${scratch}|${scratch}|${scratch}/zsh|${scratch}`, err: '' }, a);
      }
    });

    it('bash aninhado e override explícito continuam como antes', () => {
      assert.equal(bash(`bash -c 'echo "$TMPDIR"'`, env).out.trim(), alias);
      const custom = path.join(root, 'custom-alias');
      fs.mkdirSync(custom);
      assert.equal(bash('echo "$TMPDIR $DSH_SCRATCH_DIR"', { ...env, TMPDIR: custom }).out.trim(), `${custom} ${alias}`);
    });

    it('python3 multiprocessing forkserver usa o apelido (o socket AF_UNIX cabe; sem fuga para o tmp compartilhado)', { skip: !hasPython && 'python3 ausente' }, () => {
      const code = [
        'import multiprocessing as m, multiprocessing.util as u',
        'with m.get_context("forkserver").Pool(2) as p: print(sum(p.map(abs, [-1, -2])))',
        'print(u.get_temp_dir())',
      ].join('\n');
      // A raiz de teste é funda (o apelido dela passaria de 75 bytes): um apelido
      // curto próprio, com o mesmo papel do .s/<hash> da máquina real (48 bytes).
      const shortRoot = tempRoot('py');
      const shortAlias = path.join(shortRoot, 's');
      try {
        fs.symlinkSync(scratch, shortAlias);
        if (Buffer.byteLength(shortAlias) > 70) return; // TMPDIR do host longo demais para a prova
        const r = bash('exec python3 -c "$1"', { ...env, DSH_SCRATCH_DIR: shortAlias }, [], ['_', code]);
        assert.equal(r.code, 0, r.err);
        const [sum, mp] = r.out.trim().split('\n');
        assert.equal(sum, '3');
        assert.ok(String(mp).startsWith(`${shortAlias}/pymp-`), String(mp));
      } finally {
        rmrf(shortRoot);
      }
    });

    it('zsh grava here-docs em $TMPPREFIX (pasta da sessão, via apelido)', { skip: !hasZsh && 'zsh ausente' }, () => {
      const r = bash('exec zsh -fc \'print -r -- "$TMPPREFIX"; readlink /proc/self/fd/0 <<EOF\nx\nEOF\'', env);
      assert.equal(r.code, 0, r.err);
      const [prefix, heredoc] = r.out.trim().split('\n');
      assert.equal(prefix, `${alias}/zsh`);
      assert.ok(String(heredoc).startsWith(`${scratch}/zsh`), String(heredoc));
    });
  });

  it('seguro sob set -eu e não vaza variáveis internas', () => {
    for (const env of [
      { TMPDIR: host, DSH_SCRATCH_DIR: scratch, DSH_SCRATCH_HOST_TMPDIR: host },
      { TMPDIR: host, DSH_SCRATCH_DIR: path.join(root, 'locked', 'x'), DSH_SCRATCH_HOST_TMPDIR: host },
      { DSH_SCRATCH_DIR: scratch },
      { TMPDIR: host, DSH_SCRATCH_DIR: path.join(path.dirname(scratch), '.s', 'abcd1234'), DSH_SCRATCH_CANONICAL_DIR: scratch, DSH_SCRATCH_HOST_TMPDIR: host },
      {},
    ]) {
      const r = bash('echo "ok ${__dss_host-none} ${__dss_cur-none} ${__dss_real-none} ${__dss_use-none}"', env, ['-eu']);
      assert.deepEqual(r, { code: 0, out: 'ok none none none none\n', err: '' }, JSON.stringify(env));
    }
  });
});
