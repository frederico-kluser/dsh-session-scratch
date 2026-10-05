#!/usr/bin/env node
// @ts-check
/**
 * E2E contra o DSH REAL instalado (launcher ~/.local/bin/dsh → repo
 * deepseek-harness), com o provider de LLM SCRIPTADO do próprio repo
 * (`@deepseek-ai/dsh-llm-mock-server`, packages/test-support): cada cenário
 * sobe um mock OpenAI-compatible que responde [tool_call_success, success],
 * ou seja, o "modelo" chama UMA ferramenta determinística e depois encerra.
 *
 * Nada toca o ~/.dsh: DSH_HOME é um diretório temporário (só settings.yaml
 * com `llm-deepseek.protocol: chat-completions`, como o e2e do próprio DSH) e
 * o plugin entra por um overlay `--patch` temporário. O TMPDIR do processo é
 * o do host (os.tmpdir()), então as pastas de sessão nascem no lugar real
 * do contrato: <host-tmp>/agent-scratch/dsh/<id>.
 *
 * Prova:
 *  (a) no bash do agente, $TMPDIR == apelido curto <host-tmp>/agent-scratch/dsh/.s/<hash8>
 *      → ../<session-id> (a pasta canônica <host-tmp>/agent-scratch/dsh/<session-id>,
 *      81 bytes aqui, fica onde o contrato manda; TMP/TEMP, TMPPREFIX, mktemp,
 *      bash aninhado, modo 0700);
 *  (b) comando que grava em /tmp é negado com o motivo em pt-BR (bash e write);
 *  (c) a regra está no system prompt montado (corpo da 1ª request ao provider);
 *  (d) depois que o processo headless sai, a pasta da sessão sumiu;
 *  extra: o sweeper apaga um órfão plantado (dono morto) e preserva o de um
 *  dono vivo, e desliga o apelido pendurado do órfão; no modo workspace-write
 *  (bwrap) o hook cai para o /tmp privado (e DSH_SCRATCH_DIR acompanha); no
 *  read-only nada é gravável e o hook não muda nada (mktemp falha igual sem o plugin);
 *  sockets AF_UNIX (motivo do apelido): Chromium headless real (google-chrome-stable
 *  e o chromium do Playwright) imprime o DOM, o forkserver do Python sobe um
 *  Pool com o socket dentro do TMPDIR, e o TMPDIR tem ≤ 60 bytes — cada um com
 *  um CONTROLE no caminho canônico (Chromium morre, Python foge do TMPDIR).
 *
 * Uso: node scripts/e2e/run-e2e.mjs [--keep] [--dsh BIN] [--dsh-repo DIR] [--only a,b]
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { aliasCandidates, needsAlias } from '../../src/alias.js';
import { DEFAULTS } from '../../src/config.js';
import { parseStartTime, realProc } from '../../src/owner.js';
import { hostTmpdir, sanitizeId } from '../../src/paths.js';
import { PROMPT_RULE, fileDenyReason, shellDenyReason } from '../../src/text.js';

const args = process.argv.slice(2);
const opt = (/** @type {string} */ name, /** @type {string} */ fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? /** @type {string} */ (args[i + 1]) : fallback;
};
const KEEP = args.includes('--keep');
const DSH = opt('--dsh', path.join(os.homedir(), '.local', 'bin', 'dsh'));
const DSH_REPO = opt('--dsh-repo', '/home/ondokai/Projects/deepseek-harness');
const ONLY = opt('--only', '').split(',').filter(Boolean);
const PLUGIN = fileURLToPath(new URL('../../src/index.js', import.meta.url));
// Mesma raiz que o plugin calcula (sem aninhar se este processo herdou um TMPDIR de sessão).
const HOST_TMP = hostTmpdir();
const BASE = path.join(HOST_TMP, 'agent-scratch', 'dsh');
const API_KEY = 'dss-e2e-mock-key';
const RUN_ID = randomBytes(4).toString('hex');

const { startMockLlmServer } = /** @type {any} */ (await import(pathToFileURL(path.join(DSH_REPO, 'packages/test-support/llm-mock-server/lib/index.js')).href));

/** O e2e só desfaz o que criou: a base sai no fim se não existia antes (rmdir: só se vazia). */
const BASE_EXISTED = fs.existsSync(BASE);
const SCRATCH_ROOT_EXISTED = fs.existsSync(path.dirname(BASE));
const evidence = fs.realpathSync(fs.mkdtempSync(path.join(HOST_TMP, 'dss-e2e-')));
const home = path.join(evidence, 'dsh-home');
const ws = path.join(evidence, 'workspace');
fs.mkdirSync(home, { mode: 0o700 });
fs.mkdirSync(ws);
fs.writeFileSync(path.join(home, 'settings.yaml'), 'llm-deepseek:\n  protocol: chat-completions\n');
fs.writeFileSync(path.join(ws, 'README.md'), '# workspace do e2e do dsh-session-scratch\n');
const overlay = path.join(evidence, 'overlay.patch.yml');
fs.writeFileSync(overlay, [
  '# overlay TEMPORÁRIO do e2e: o plugin por caminho absoluto + config completa.',
  '# O título por LLM é desligado para não consumir o roteiro do mock.',
  '- id: session-title-llm',
  '  disabled: true',
  '- insert:',
  '    - id: session-scratch',
  `      name: ${JSON.stringify(PLUGIN)}`,
  '      config:',
  ...Object.entries(DEFAULTS).map(([k, v]) => `        ${k}: ${JSON.stringify(v)}`),
  '',
].join('\n'));

/** @type {{ name: string, ok: boolean, notes: string[] }[]} */
const results = [];
/** Filhos/servidores ainda vivos (fechados no fim mesmo se um cenário lançar). */
/** @type {Set<{ child: import('node:child_process').ChildProcess, server: any }>} */
const running = new Set();
/** @param {string} name */
const wanted = (name) => ONLY.length === 0 || ONLY.includes(name);

/**
 * Inicia um headless com o mock scriptado (`sequence`, default: chama
 * `toolName(toolArgs)` uma vez e encerra). Devolve o filho e um `finish()`
 * que espera a saída e junta a evidência.
 * @param {string} name
 * @param {{ toolName?: string, toolArgs?: Record<string, unknown>, permission?: string, sequence?: string[], env?: Record<string, string> }} spec
 */
async function startHeadless(name, spec) {
  const server = await startMockLlmServer({
    sequence: spec.sequence ?? ['tool_call_success', 'success'],
    apiKey: API_KEY,
    toolName: spec.toolName ?? 'bash',
    toolArguments: JSON.stringify(spec.toolArgs ?? { command: 'true', description: 'noop' }),
    successText: `fim do cenário ${name}`,
  });
  const traceFile = path.join(evidence, `${name}.trace.jsonl`);
  /** @type {Record<string, string>} */
  const env = { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: API_KEY, DEEPSEEK_BASE_URL: server.baseURL, DSH_PERMISSION_MODE: spec.permission ?? 'danger-full-access', DSH_TELEMETRY_DISABLED: '1', SESSION_SCRATCH_TRACE: traceFile, ...spec.env };
  delete env.BASH_ENV;
  delete env.DSH_TOOLS_MODE;
  delete env.SESSION_SCRATCH_PREV_BASH_ENV;
  const started = Date.now();
  const child = spawn(DSH, ['--profile', 'headless', '--patch', overlay, '--json', `cenário e2e ${name}`], { cwd: ws, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const handle = { child, server };
  running.add(handle);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  /** @type {Promise<{ code: number|null, signal: string|null }>} */
  const exited = new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 180_000);
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  const readTrace = () => (fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  /** Espera um evento do trace (polling). @param {string} event */
  const waitTrace = async (event, timeoutMs = 60_000) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const hit = readTrace().find((e) => e.event === event);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timeout esperando o evento ${event} no trace de ${name}`);
  };
  const finish = async () => {
    const exit = await exited;
    const requests = server.requests.map((/** @type {any} */ r) => r.body);
    await server.close();
    running.delete(handle);
    fs.writeFileSync(path.join(evidence, `${name}.events.jsonl`), stdout);
    fs.writeFileSync(path.join(evidence, `${name}.stderr.log`), stderr);
    fs.writeFileSync(path.join(evidence, `${name}.requests.json`), JSON.stringify(requests, null, 2));
    const events = stdout.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return { type: 'unparsed', raw: l }; } });
    const sessionId = events.find((e) => e.type === 'session')?.sessionId;
    const toolResult = events.find((e) => e.type === 'tool_result');
    return { exit, events, requests, sessionId, toolResult, stderr, trace: readTrace(), seconds: (Date.now() - started) / 1000 };
  };
  return { child, waitTrace, readTrace, finish };
}

/**
 * Roda um headless até o fim.
 * @param {string} name
 * @param {{ toolName?: string, toolArgs?: Record<string, unknown>, permission?: string, sequence?: string[], env?: Record<string, string> }} spec
 */
async function runHeadless(name, spec) {
  return (await startHeadless(name, spec)).finish();
}

/**
 * @param {string} name
 * @param {(notes: string[], check: (cond: unknown, msg: string) => void) => Promise<void>} body
 */
async function scenario(name, body) {
  if (!wanted(name)) return;
  /** @type {string[]} */
  const notes = [];
  let ok = true;
  const check = (/** @type {unknown} */ cond, /** @type {string} */ msg) => {
    notes.push(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
    if (!cond) ok = false;
  };
  try {
    await body(notes, check);
  } catch (error) {
    ok = false;
    notes.push(`ERRO ${error instanceof Error ? error.stack : String(error)}`);
  }
  results.push({ name, ok, notes });
}

/**
 * Caminho que o plugin exporta para a chave: o 1º apelido (`.s/<sha256[:8]>`)
 * quando a canônica passa de 60 bytes, senão a própria pasta.
 * @param {string} key
 */
function exportedFor(key) {
  return needsAlias(BASE, key) ? /** @type {string} */ (aliasCandidates(BASE, key)[0]) : path.join(BASE, key);
}

/** `true` se `p` existe como entrada (mesmo symlink pendurado). @param {string} p */
const lexists = (p) => fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined;

/** Ausência da pasta, do marcador, dos apelidos e de lixeiras da sessão. @param {string} key */
function sessionGone(key) {
  const dir = path.join(BASE, key);
  const marker = path.join(BASE, '.owners', `${key}.json`);
  const aliases = aliasCandidates(BASE, key).filter(lexists);
  return { dir, dirExists: fs.existsSync(dir), markerExists: fs.existsSync(marker), aliasExists: aliases.length > 0, aliases };
}

/** @param {string} s */
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── (a) TMPDIR + (c) regra no prompt + (d) limpeza na saída + sweeper ──────
await scenario('tmpdir', async (notes, check) => {
  // Planta, ANTES do boot, um órfão (dono morto) e uma pasta de dono vivo.
  fs.mkdirSync(path.join(BASE, '.owners'), { recursive: true, mode: 0o700 });
  const boot = realProc.bootId();
  const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  /** @param {string} key @param {object} marker */
  const plant = (key, marker) => {
    const dir = path.join(BASE, key);
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'leftover.txt'), 'x');
    const file = path.join(BASE, '.owners', `${key}.json`);
    fs.writeFileSync(file, JSON.stringify(marker));
    fs.utimesSync(file, old, old);
    fs.utimesSync(dir, old, old);
    return dir;
  };
  const orphan = plant(`e2e-orphan-${RUN_ID}`, { v: 1, pid: 2_147_000_000, start: '1', boot, createdAt: 0 });
  const live = plant(`e2e-live-${RUN_ID}`, { v: 1, pid: process.pid, start: parseStartTime(realProc.stat('self')), boot, createdAt: 0 });
  // Apelidos plantados (fora do nome de hash, que a varredura também cobre):
  // o do órfão fica pendurado quando a pasta sai; o do vivo aponta para pasta presente.
  fs.mkdirSync(path.join(BASE, '.s'), { recursive: true, mode: 0o700 });
  /** @param {string} name @param {string} key */
  const plantAlias = (name, key) => {
    const p = path.join(BASE, '.s', name);
    fs.symlinkSync(`../${key}`, p);
    fs.lutimesSync(p, old, old);
    return p;
  };
  const orphanAlias = plantAlias(`e2e-o-${RUN_ID}`, `e2e-orphan-${RUN_ID}`);
  const liveAlias = plantAlias(`e2e-l-${RUN_ID}`, `e2e-live-${RUN_ID}`);

  const command = [
    'printf "TMPDIR=%s\\nTMP=%s\\nTEMP=%s\\nTMPPREFIX=%s\\nSCRATCH=%s\\nCANON=%s\\nSID=%s\\n" "$TMPDIR" "$TMP" "$TEMP" "$TMPPREFIX" "$DSH_SCRATCH_DIR" "$DSH_SCRATCH_CANONICAL_DIR" "$DSH_SESSION_ID"',
    'f=$(mktemp) && printf "MKTEMP=%s\\nMKTEMP_REAL=%s\\n" "$f" "$(readlink -f "$f")"',
    'bash -c \'printf "NESTED=%s\\n" "$TMPDIR"\'',
    'printf "REAL=%s\\nLINK=%s\\n" "$(readlink -f "$TMPDIR")" "$(readlink "$TMPDIR")"',
    'stat -L -c "MODE=%a" "$TMPDIR"',
    // TMPDIR é symlink: find no link não desce; com a barra no fim (o que a regra do prompt manda) desce.
    'printf "FIND_LINK=%s\\nFIND_SLASH=%s\\n" "$(find "$TMPDIR" -name "tmp.*" | wc -l)" "$(find "$TMPDIR/" -name "tmp.*" | wc -l)"',
  ].join('; ');
  const r = await runHeadless('tmpdir', { toolName: 'bash', toolArgs: { command, description: 'Mostra o TMPDIR da sessão' } });
  notes.push(`exit=${JSON.stringify(r.exit)} em ${r.seconds.toFixed(1)}s; sessionId=${r.sessionId}`);
  check(r.exit.code === 0, 'headless saiu com 0');
  check(typeof r.sessionId === 'string', 'evento session com o id');
  const key = sanitizeId(String(r.sessionId));
  const canonical = path.join(BASE, key);
  const expected = exportedFor(key);
  const out = String(r.toolResult?.result ?? '');
  notes.push(`tool_result (${r.toolResult?.status}):\n${out.split('\n').map((l) => `    | ${l}`).join('\n')}`);
  notes.push(`canônica ${canonical} (${Buffer.byteLength(canonical)} bytes); exportado ${expected} (${Buffer.byteLength(expected)} bytes)`);
  check(expected !== canonical, '(a) a canônica passa de 60 bytes nesta máquina: o plugin exporta o apelido');
  check(out.includes(`TMPDIR=${expected}\n`), `(a) $TMPDIR == apelido ${expected}`);
  check(out.includes(`TMP=${expected}\n`) && out.includes(`TEMP=${expected}\n`), '(a) TMP e TEMP também');
  check(out.includes(`TMPPREFIX=${expected}/zsh\n`), '(a) TMPPREFIX=<apelido>/zsh (here-docs do zsh)');
  check(out.includes(`SCRATCH=${expected}\n`), '(a) DSH_SCRATCH_DIR = TMPDIR exportado');
  check(out.includes(`CANON=${canonical}\n`), '(a) DSH_SCRATCH_CANONICAL_DIR = pasta canônica do contrato');
  check(out.includes(`REAL=${canonical}\n`) && out.includes(`LINK=../${key}\n`), '(a) o apelido é o symlink ../<id> e resolve para a canônica');
  check(out.includes(`SID=${r.sessionId}\n`), '(a) DSH_SESSION_ID bate com o evento session');
  check(new RegExp(`MKTEMP=${reEscape(expected)}/tmp\\.`).test(out) && new RegExp(`MKTEMP_REAL=${reEscape(canonical)}/tmp\\.`).test(out), '(a) mktemp cai dentro da pasta da sessão (pelo apelido)');
  check(out.includes(`NESTED=${expected}\n`), '(a) bash aninhado herda o mesmo TMPDIR');
  check(out.includes('MODE=700'), '(a) pasta da sessão com modo 0700');
  check(/FIND_LINK=0\n/.test(out) && /FIND_SLASH=[1-9]\d*\n/.test(out), '(a) TMPDIR é symlink: `find "$TMPDIR"` não desce, `find "$TMPDIR/"` (o que a regra do prompt manda) acha o mktemp');
  const createdAlias = r.trace.find((e) => e.event === 'agent/created')?.detail?.alias;
  check(createdAlias === expected, `(a) agent/created já criou o apelido (${createdAlias})`);

  // (c) regra no system prompt que foi ao provider.
  const first = r.requests[0];
  const system = (first?.messages ?? []).filter((/** @type {any} */ m) => m.role === 'system').map((/** @type {any} */ m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
  const at = system.indexOf('Arquivos temporários:');
  notes.push(`system prompt da 1ª request: ${system.length} chars; regra no offset ${at}`);
  if (at >= 0) notes.push(`    | …${system.slice(Math.max(0, at - 90), at + 260).replace(/\n/g, '⏎')}…`);
  check(system.includes(PROMPT_RULE), '(c) regra completa presente no system prompt montado');
  const bashSection = system.indexOf('Check the [exit code: N] marker');
  check(bashSection >= 0 && at > bashSection, '(c) regra posicionada logo depois da seção do bash (TOOL_BASH+5)');
  const second = r.requests[1];
  check(JSON.stringify(second?.messages ?? []).includes(`TMPDIR=${expected}`), '(a) o modelo recebeu a saída com o TMPDIR (2ª request)');

  // (d) limpeza depois da saída — e QUAL caminho removeu (trace opt-in do plugin).
  notes.push(`trace do plugin (SESSION_SCRATCH_TRACE):\n${r.trace.map((e) => `    | ${e.event} ${JSON.stringify(e.detail)}`).join('\n')}`);
  const removedBy = r.trace.find((e) => (e.event === 'agent/disposed' && e.detail?.key === key && e.detail?.action === 'removed')
    || (e.event === 'exit-cleanup' && (e.detail?.removed ?? []).includes(path.join(BASE, key))));
  notes.push(`removida por: ${removedBy ? removedBy.event : '(nenhum evento registrou a remoção)'}`);
  const gone = sessionGone(key);
  check(!gone.dirExists, `(d) pasta da sessão removida após a saída (${gone.dir})`);
  check(!gone.markerExists, '(d) marcador .owners/<id>.json removido');
  check(!gone.aliasExists, `(d) apelido removido junto (${gone.aliases.join(',') || 'nenhum sobrou'})`);
  const trash = fs.readdirSync(BASE).filter((n) => n.startsWith('.trash-'));
  check(trash.length === 0, `(d) nenhuma lixeira pendente (${trash.join(',') || 'nenhuma'})`);

  // Sweeper do processo DSH (roda no arranque).
  check(!fs.existsSync(orphan), 'sweeper: órfão de dono morto (2 h, carência 30 min) apagado');
  check(fs.existsSync(live), 'sweeper: pasta de dono VIVO preservada');
  const sweep = r.trace.find((e) => e.event === 'sweep');
  notes.push(`sweep: ${JSON.stringify(sweep?.detail)}`);
  check(!lexists(orphanAlias), 'sweeper: apelido pendurado do órfão desligado');
  check(fs.lstatSync(liveAlias, { throwIfNoEntry: false })?.isSymbolicLink() === true && fs.existsSync(path.join(live, 'leftover.txt')), 'sweeper: apelido do vivo e o conteúdo dele intactos');
  fs.rmSync(liveAlias, { force: true });
  fs.rmSync(orphanAlias, { force: true });
  fs.rmSync(live, { recursive: true, force: true });
  fs.rmSync(path.join(BASE, '.owners', `e2e-live-${RUN_ID}.json`), { force: true });
  fs.rmSync(orphan, { recursive: true, force: true });
  fs.rmSync(path.join(BASE, '.owners', `e2e-orphan-${RUN_ID}.json`), { force: true });
});

// ── (b) bash com /tmp literal é negado ───────────────────────────────────
await scenario('deny-bash', async (notes, check) => {
  const probe = `/tmp/dss-e2e-probe-${RUN_ID}.txt`; // nunca é criado: a guarda nega antes
  const r = await runHeadless('deny-bash', { toolName: 'bash', toolArgs: { command: `echo hi > ${probe}`, description: 'Grava em /tmp' } });
  notes.push(`exit=${JSON.stringify(r.exit)}; sessionId=${r.sessionId}`);
  const out = String(r.toolResult?.result ?? '');
  notes.push(`tool_result (${r.toolResult?.status}): ${out}`);
  notes.push(`trace: ${r.trace.map((e) => `${e.event}${e.event === 'guard/deny' ? JSON.stringify(e.detail) : ''}`).join(' → ')}`);
  check(r.trace.some((e) => e.event === 'guard/deny' && e.detail?.kind === 'shell'), '(b) a guarda do plugin decidiu o deny (trace guard/deny)');
  check(r.toolResult?.status === 'error', '(b) resultado da ferramenta é erro (negado antes de executar)');
  check(out.includes(shellDenyReason(DEFAULTS.escapeMarker)), '(b) motivo em pt-BR exatamente o do plugin');
  check(!fs.existsSync(probe), `(b) ${probe} NÃO foi criado`);
  check(JSON.stringify(r.requests[1]?.messages ?? []).includes('Bloqueado: este comando usa o caminho literal /tmp.'), '(b) o modelo viu o motivo (2ª request)');
  check(r.sessionId !== undefined && !sessionGone(sanitizeId(String(r.sessionId))).dirExists && !sessionGone(sanitizeId(String(r.sessionId))).aliasExists, '(d) pasta da sessão e apelido removidos após a saída');
});

// ── (b) write com file_path em /tmp é negado ─────────────────────────────
await scenario('deny-write', async (notes, check) => {
  const probe = `/tmp/dss-e2e-write-${RUN_ID}.txt`;
  const r = await runHeadless('deny-write', { toolName: 'write', toolArgs: { file_path: probe, content: 'x' } });
  const out = String(r.toolResult?.result ?? '');
  notes.push(`tool_result (${r.toolResult?.status}): ${out}`);
  check(r.toolResult?.status === 'error', '(b) write negado');
  check(out.includes(fileDenyReason(DEFAULTS.escapeMarker)), '(b) motivo de arquivo em pt-BR');
  check(!fs.existsSync(probe), `(b) ${probe} NÃO foi criado`);
});

// ── marcador de escape libera (comando só de leitura) ────────────────────
await scenario('escape', async (notes, check) => {
  // Forma recomendada pelo motivo do deny: o marcador sozinho na PRIMEIRA linha.
  const r = await runHeadless('escape', { toolName: 'bash', toolArgs: { command: '# allow-literal-tmp\nls -d /tmp', description: 'Lista /tmp a pedido do usuário' } });
  const out = String(r.toolResult?.result ?? '');
  notes.push(`tool_result (${r.toolResult?.status}): ${out.trim()}`);
  check(r.toolResult?.status === 'completed' && out.includes('/tmp'), 'comando com # allow-literal-tmp passou pela guarda');
});

// ── `dsh` lançado do bash de outro agente: TMPDIR herdado = pasta de sessão ──
await scenario('nested-host', async (notes, check) => {
  // Pasta de sessão "mãe" (como a de um bash de agente), dentro da árvore do DSH.
  const parent = path.join(BASE, `e2e-parent-${RUN_ID}`);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(parent, 'sentinel.txt'), 'mãe');
  try {
    const command = 'printf "TMPDIR=%s\\nSCRATCH=%s\\nHOSTTMP=%s\\n" "$TMPDIR" "$DSH_SCRATCH_DIR" "$DSH_SCRATCH_HOST_TMPDIR"';
    const r = await runHeadless('nested-host', { toolName: 'bash', toolArgs: { command, description: 'TMPDIR com host aninhado' }, env: { TMPDIR: parent } });
    const out = String(r.toolResult?.result ?? '');
    notes.push(`TMPDIR do processo do DSH: ${parent}`);
    notes.push(`tool_result (${r.toolResult?.status}):\n${out.split('\n').map((l) => `    | ${l}`).join('\n')}`);
    const key = sanitizeId(String(r.sessionId));
    const expected = exportedFor(key);
    check(r.exit.code === 0, 'headless saiu com 0');
    check(out.includes(`TMPDIR=${expected}\n`), `pasta da sessão na raiz do host, sem aninhar (${expected})`);
    check(out.includes(`HOSTTMP=${parent}\n`), 'DSH_SCRATCH_HOST_TMPDIR = TMPDIR herdado (override detectado pelo hook)');
    check(!fs.existsSync(path.join(parent, 'agent-scratch')), 'nada criado dentro da pasta da sessão-mãe');
    check(fs.readFileSync(path.join(parent, 'sentinel.txt'), 'utf8') === 'mãe', 'pasta da sessão-mãe intacta');
    check(!sessionGone(key).dirExists && !sessionGone(key).aliasExists, '(d) pasta da sessão e apelido removidos após a saída');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

// ── workspace-write (bwrap): /var/tmp é read-only → hook cai para /tmp privado ──
await scenario('sandbox', async (notes, check) => {
  const command = 'printf "TMPDIR=%s\\nSCRATCH=%s\\n" "$TMPDIR" "$DSH_SCRATCH_DIR"; if [ -w "$TMPDIR" ]; then echo WRITABLE=yes; else echo WRITABLE=no; fi; if [ -w "$DSH_SCRATCH_DIR" ]; then echo SCRATCH_WRITABLE=yes; else echo SCRATCH_WRITABLE=no; fi; [ -w /var/tmp ] && echo VARTMP=rw || echo VARTMP=ro';
  const r = await runHeadless('sandbox', { toolName: 'bash', toolArgs: { command, description: 'TMPDIR no sandbox' }, permission: 'workspace-write' });
  const out = String(r.toolResult?.result ?? '');
  notes.push(`tool_result (${r.toolResult?.status}):\n${out.split('\n').map((l) => `    | ${l}`).join('\n')}`);
  const key = r.sessionId === undefined ? '' : sanitizeId(String(r.sessionId));
  const scratchShown = key !== '' && out.includes(`TMPDIR=${exportedFor(key)}\n`);
  check(out.includes('WRITABLE=yes'), 'TMPDIR utilizável dentro do sandbox');
  check(scratchShown || out.includes('TMPDIR=/tmp\n'), 'TMPDIR = pasta da sessão (se gravável) ou /tmp privado do bwrap');
  const tmpdirValue = /TMPDIR=(.*)\n/.exec(out)?.[1];
  check(tmpdirValue !== undefined && out.includes(`SCRATCH=${tmpdirValue}\n`) && out.includes('SCRATCH_WRITABLE=yes'), 'DSH_SCRATCH_DIR = TMPDIR também no fallback do sandbox (gravável, não o apelido read-only)');
  check(key !== '' && !sessionGone(key).dirExists && !sessionGone(key).aliasExists, '(d) pasta da sessão e apelido removidos após a saída');
});

// ── sandbox read-only: nada é gravável, nem o /tmp do bwrap → o hook não muda nada ──
//    (documenta o comportamento: igual a sem o plugin; o mktemp falha nos dois casos)
await scenario('sandbox-readonly', async (notes, check) => {
  const command = [
    '# allow-literal-tmp', // o cenário precisa sondar o /tmp do bwrap (a guarda do plugin negaria sem o marcador)
    'printf "TMPDIR=%s\\nHOSTTMP=%s\\nSCRATCH=%s\\nPREFIX=%s\\n" "$TMPDIR" "$DSH_SCRATCH_HOST_TMPDIR" "$DSH_SCRATCH_DIR" "${TMPPREFIX-unset}"',
    'if [ -w "$TMPDIR" ]; then echo WRITABLE=yes; else echo WRITABLE=no; fi; [ -w /tmp ] && echo SLASHTMP=rw || echo SLASHTMP=ro',
    'mktemp >/dev/null 2>&1; printf "MKTEMP_RC=%s\\n" "$?"',
    // Controle: o mesmo mktemp sem nada do plugin (sem BASH_ENV, sem DSH_SCRATCH_*).
    'env -u BASH_ENV -u DSH_SCRATCH_DIR -u DSH_SCRATCH_CANONICAL_DIR TMPDIR="$DSH_SCRATCH_HOST_TMPDIR" bash -c \'mktemp >/dev/null 2>&1; printf "CONTROL_RC=%s\\n" "$?"\'',
    'true',
  ].join('\n');
  const r = await runHeadless('sandbox-readonly', { toolName: 'bash', toolArgs: { command, description: 'TMPDIR no sandbox read-only' }, permission: 'read-only' });
  const out = String(r.toolResult?.result ?? '');
  notes.push(`tool_result (${r.toolResult?.status}):\n${out.split('\n').map((l) => `    | ${l}`).join('\n')}`);
  const key = r.sessionId === undefined ? '' : sanitizeId(String(r.sessionId));
  const host = /HOSTTMP=(.*)\n/.exec(out)?.[1];
  check(r.exit.code === 0, 'headless saiu com 0 (o bash rodou no sandbox read-only)');
  check(host !== undefined && out.includes(`TMPDIR=${host}\n`), 'TMPDIR fica o do host (o hook não troca: nem a pasta da sessão nem o /tmp são graváveis)');
  check(out.includes('WRITABLE=no') && out.includes('SLASHTMP=ro'), 'nada gravável dentro do sandbox read-only (nem /tmp)');
  check(key !== '' && out.includes(`SCRATCH=${exportedFor(key)}\n`), 'DSH_SCRATCH_DIR fica como o plugin publicou (o hook não trocou o TMPDIR)');
  const rc = /MKTEMP_RC=(\d+)/.exec(out)?.[1];
  const control = /CONTROL_RC=(\d+)/.exec(out)?.[1];
  check(rc !== undefined && rc !== '0' && rc === control, `mktemp falha igual com e sem o plugin (rc ${rc} vs controle ${control})`);
  check(key !== '' && !sessionGone(key).dirExists && !sessionGone(key).aliasExists, '(d) pasta da sessão e apelido removidos após a saída');
});

// ── SIGTERM no meio de uma request: flag de shutdown + limpeza ───────────
await scenario('sigterm', async (notes, check) => {
  const h = await startHeadless('sigterm', { sequence: ['stall'] });
  const created = await h.waitTrace('agent/created');
  const key = String(created.detail.key);
  const dir = path.join(BASE, key);
  check(fs.existsSync(dir), `pasta criada no agent/created enquanto a request está pendurada (${dir})`);
  h.child.kill('SIGTERM');
  const r = await h.finish();
  notes.push(`exit=${JSON.stringify(r.exit)} em ${r.seconds.toFixed(1)}s`);
  notes.push(`trace: ${r.trace.map((e) => e.event).join(' → ')}`);
  check(r.trace.some((e) => e.event === 'signal' && e.detail === 'SIGTERM'), 'listener de SIGTERM marcou o shutdown');
  const detached = r.trace.find((e) => e.event === 'shutdown-detach' && (e.detail?.detached ?? []).includes(dir));
  const exitClean = r.trace.find((e) => e.event === 'exit-cleanup');
  notes.push(`shutdown-detach: ${JSON.stringify(detached?.detail)}; exit-cleanup: ${JSON.stringify(exitClean?.detail)}`);
  check(detached !== undefined, 'disposer do shutdown tirou a pasta do lugar (rename rápido dentro do teto de 5 s)');
  check(exitClean !== undefined && exitClean.detail?.trashLeft === 0, 'exit apagou a lixeira (trashLeft=0)');
  const leftoverTrash = fs.readdirSync(BASE).filter((n) => n.startsWith('.trash-'));
  check(leftoverTrash.length === 0, `nenhuma lixeira sobrou (${leftoverTrash.join(',') || 'nenhuma'})`);
  check(!fs.existsSync(dir), '(d) pasta removida após SIGTERM');
  check(!sessionGone(key).aliasExists, '(d) apelido removido após SIGTERM');
});

// ── SIGKILL: nada roda; o sweeper de OUTRO processo recolhe o órfão ──────
//    e nunca apaga a pasta de um processo vivo.
await scenario('sigkill-orphan', async (notes, check) => {
  const a = await startHeadless('sigkill-a', { sequence: ['stall'] });
  const created = await a.waitTrace('agent/created');
  const key = String(created.detail.key);
  const dir = path.join(BASE, key);
  const marker = path.join(BASE, '.owners', `${key}.json`);
  fs.writeFileSync(path.join(dir, 'work.txt'), 'trabalho da sessão A');
  // Simula inatividade de 2 h (além da carência de 30 min) com o dono VIVO.
  const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(marker, old, old);
  fs.utimesSync(dir, old, old);
  const b = await runHeadless('sigkill-b', {});
  const sweepB = b.trace.find((e) => e.event === 'sweep');
  notes.push(`sweep do processo B (A vivo): ${JSON.stringify(sweepB?.detail)}`);
  check(sweepB?.detail?.kept?.[key] === 'live-other', 'B preserva a pasta de A (dono vivo: mesmo boot_id e starttime)');
  check(fs.existsSync(path.join(dir, 'work.txt')), 'conteúdo de A intacto');
  a.child.kill('SIGKILL');
  const ra = await a.finish();
  notes.push(`A morto: ${JSON.stringify(ra.exit)}; trace de A: ${ra.trace.map((e) => e.event).join(' → ')}`);
  check(fs.existsSync(dir), 'após SIGKILL a pasta de A fica (nada roda) — esperado');
  fs.utimesSync(marker, old, old);
  fs.utimesSync(dir, old, old);
  const c = await runHeadless('sigkill-c', {});
  const sweepC = c.trace.find((e) => e.event === 'sweep');
  notes.push(`sweep do processo C (A morto): ${JSON.stringify(sweepC?.detail)}`);
  check((sweepC?.detail?.deleted ?? []).includes(key), 'C apaga o órfão de A (pid morto, além da carência)');
  check(!fs.existsSync(dir) && !fs.existsSync(marker), 'pasta e marcador de A removidos');
  check(!sessionGone(key).aliasExists, 'apelido de A removido junto com o órfão');
});

// ── Sockets AF_UNIX: o motivo do apelido ──────────────────────────────────
/** Comprimento do TMPDIR exportado (o critério do apelido). */
await scenario('tmpdir-length', async (notes, check) => {
  const command = 'printf "TMPDIR=%s\\nLEN=%s\\nREAL=%s\\n" "$TMPDIR" "${#TMPDIR}" "$(readlink -f "$TMPDIR")"; [ "${#TMPDIR}" -le 60 ] && echo LEN_OK';
  const r = await runHeadless('tmpdir-length', { toolName: 'bash', toolArgs: { command, description: 'Comprimento do TMPDIR' } });
  const out = String(r.toolResult?.result ?? '');
  notes.push(`tool_result (${r.toolResult?.status}):\n${out.split('\n').map((l) => `    | ${l}`).join('\n')}`);
  const key = sanitizeId(String(r.sessionId));
  const canonical = path.join(BASE, key);
  const len = Number(/LEN=(\d+)/.exec(out)?.[1] ?? NaN);
  notes.push(`TMPDIR exportado: ${len} bytes; canônica: ${Buffer.byteLength(canonical)} bytes`);
  check(out.includes('LEN_OK') && len <= 60, `TMPDIR com ≤ 60 bytes (${len})`);
  check(len === Buffer.byteLength(exportedFor(key)), 'é o apelido calculado pelo plugin');
  check(out.includes(`REAL=${canonical}\n`), 'resolve para a pasta canônica');
  check(len + 46 <= 107 && len + 32 <= 107, 'cabe o socket do Chromium (+46) e do forkserver (+32) em sun_path (107)');
  check(!sessionGone(key).dirExists && !sessionGone(key).aliasExists, '(d) pasta e apelido removidos após a saída');
});

/**
 * Chromium headless de verdade com o TMPDIR da sessão, mais um CONTROLE com
 * TMPDIR = caminho canônico (que estoura o sun_path nesta máquina).
 * @param {string} name
 * @param {string} binExpr expressão de shell que resolve o binário
 * @param {string} [extra] flags extras (o Chrome for Testing do Playwright precisa de
 *   `--disable-field-trial-config`, que o próprio Playwright sempre passa: com a config
 *   de field trials de TESTE embutida — toolbar WebUI experimental — o `--dump-dom`
 *   nunca dispara e o processo fica pendurado, com qualquer TMPDIR)
 */
async function chromiumScenario(name, binExpr, extra = '') {
  await scenario(name, async (notes, check) => {
    const command = [
      `bin=${binExpr}`,
      'printf "BIN=%s\\nTMPDIR=%s\\n" "$bin" "$TMPDIR"',
      `"$bin" --headless=new --no-first-run --disable-gpu${extra} --user-data-dir="$(mktemp -d)" --dump-dom 'data:text/html,<p>ok</p>' 2>"$TMPDIR/chrome.err"; printf "\\nRC=%s\\n" "$?"`,
      'grep -m1 -o "FATAL.*" "$TMPDIR/chrome.err" | sed "s/^/ERR=/"',
      // Controle: o mesmo, com TMPDIR = caminho canônico (sem apelido).
      `TMPDIR="$DSH_SCRATCH_CANONICAL_DIR" timeout 60 "$bin" --headless=new --no-first-run --disable-gpu${extra} --user-data-dir="$(TMPDIR="$DSH_SCRATCH_CANONICAL_DIR" mktemp -d)" --dump-dom 'data:text/html,<p>ok</p>' >"$TMPDIR/control.out" 2>&1; printf "CONTROL_RC=%s\\n" "$?"`,
      'grep -m1 -o "Socket path too long" "$TMPDIR/control.out" | sed "s/^/CONTROL=/"',
      'ls -d "$TMPDIR"/*.Chrom* "$TMPDIR"/.org.chromium.* 2>/dev/null | head -n 3 | sed "s/^/LEFT=/"; true',
    ].join('\n');
    const r = await runHeadless(name, { toolName: 'bash', toolArgs: { command, description: `Chromium headless (${name})`, timeoutMs: 120_000 } });
    const out = String(r.toolResult?.result ?? '');
    notes.push(`tool_result (${r.toolResult?.status}):\n${out.split('\n').map((l) => `    | ${l}`).join('\n')}`);
    const key = sanitizeId(String(r.sessionId));
    const canonical = path.join(BASE, key);
    check(r.exit.code === 0, 'headless saiu com 0');
    check(out.includes(`TMPDIR=${exportedFor(key)}\n`), 'Chromium rodou com o TMPDIR = apelido da sessão');
    check(out.includes('<p>ok</p>') && /\nRC=0\n/.test(out), 'Chromium headless imprimiu <p>ok</p> e saiu com 0');
    check(!/^ERR=/m.test(out), 'sem FATAL no stderr do Chromium');
    if (Buffer.byteLength(canonical) + 46 > 107) {
      check(/CONTROL=Socket path too long/.test(out) && !/CONTROL_RC=0\n/.test(out), `controle: com o caminho canônico (${Buffer.byteLength(canonical)} bytes) o Chromium morre com "Socket path too long"`);
    } else {
      notes.push('controle não se aplica: a canônica cabe no sun_path nesta máquina');
    }
    check(!sessionGone(key).dirExists && !sessionGone(key).aliasExists, '(d) pasta (com o perfil do Chromium) e apelido removidos após a saída');
  });
}

const PLAYWRIGHT_GLOB = path.join(os.homedir(), '.cache', 'ms-playwright');
const playwrightChromes = fs.existsSync(PLAYWRIGHT_GLOB)
  ? fs.readdirSync(PLAYWRIGHT_GLOB).filter((n) => /^chromium-\d+$/.test(n)).map((n) => path.join(PLAYWRIGHT_GLOB, n, 'chrome-linux64', 'chrome')).filter((p) => fs.existsSync(p))
  : [];
if (wanted('chrome')) {
  if (fs.existsSync('/usr/bin/google-chrome-stable')) await chromiumScenario('chrome', 'google-chrome-stable');
  else results.push({ name: 'chrome', ok: true, notes: ['PULADO: google-chrome-stable ausente'] });
}
if (wanted('chromium-playwright')) {
  if (playwrightChromes.length > 0) {
    await chromiumScenario('chromium-playwright', '$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux64/chrome | sort -V | tail -n 1)', ' --disable-field-trial-config');
  } else {
    results.push({ name: 'chromium-playwright', ok: true, notes: ['PULADO: nenhum ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome'] });
  }
}

// multiprocessing forkserver (padrão do Python 3.14): socket em TMPDIR/pymp-XXXX/listener-XXXX.
await scenario('forkserver', async (notes, check) => {
  const command = [
    'cat > "$TMPDIR/pool.py" <<\'PY\'',
    'import multiprocessing as m, multiprocessing.util as u',
    'if __name__ == "__main__":',
    '    with m.get_context("forkserver").Pool(2) as p:',
    '        r = sum(p.map(abs, [-1, -2]))',
    '    print("POOL=%d" % r)',
    '    print("MPTMP=" + u.get_temp_dir())',
    'PY',
    'printf "TMPDIR=%s\\n" "$TMPDIR"',
    'python3 "$TMPDIR/pool.py"; printf "RC=%s\\n" "$?"',
    // Controle: TMPDIR = caminho canônico.
    'TMPDIR="$DSH_SCRATCH_CANONICAL_DIR" python3 "$TMPDIR/pool.py" 2>&1 | sed "s/^/CONTROL_/"',
  ].join('\n');
  const r = await runHeadless('forkserver', { toolName: 'bash', toolArgs: { command, description: 'multiprocessing forkserver', timeoutMs: 120_000 } });
  const out = String(r.toolResult?.result ?? '');
  notes.push(`tool_result (${r.toolResult?.status}):\n${out.split('\n').map((l) => `    | ${l}`).join('\n')}`);
  const key = sanitizeId(String(r.sessionId));
  const canonical = path.join(BASE, key);
  const tmpdir = exportedFor(key);
  check(r.exit.code === 0, 'headless saiu com 0');
  check(out.includes(`TMPDIR=${tmpdir}\n`), 'python3 rodou com o TMPDIR = apelido da sessão');
  check(out.includes('POOL=3\n') && out.includes('RC=0\n'), 'Pool(2) do forkserver funcionou (sum(map(abs)) = 3)');
  check(new RegExp(`MPTMP=${reEscape(tmpdir)}/pymp-`).test(out), 'o socket do forkserver ficou DENTRO do TMPDIR da sessão (sem fuga para o tmp compartilhado)');
  const control = /CONTROL_MPTMP=(.*)/.exec(out)?.[1] ?? /CONTROL_.*(OSError.*)/.exec(out)?.[1] ?? '(nada)';
  notes.push(`controle com TMPDIR = canônica (${Buffer.byteLength(canonical)} bytes): ${control}`);
  if (Buffer.byteLength(canonical) >= 76) {
    check(!control.startsWith(canonical), 'controle: com o caminho canônico o forkserver NÃO usa o TMPDIR (erro em 76–79 bytes, fuga para /tmp em ≥ 80)');
  }
  check(!sessionGone(key).dirExists && !sessionGone(key).aliasExists, '(d) pasta e apelido removidos após a saída');
});

// ── Relatório ─────────────────────────────────────────────────────────────
for (const { child, server } of running) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  try { await server.close(); } catch { /* já fechado */ }
}
let failed = 0;
for (const r of results) {
  process.stdout.write(`\n=== ${r.ok ? 'PASS' : 'FAIL'} cenário ${r.name}\n${r.notes.map((n) => `  ${n}`).join('\n')}\n`);
  if (!r.ok) failed += 1;
}
const leftovers = [
  ...(fs.existsSync(BASE) ? fs.readdirSync(BASE).filter((n) => n.includes(RUN_ID) || n.startsWith('.trash-')) : []),
  ...(fs.existsSync(path.join(BASE, '.s')) ? fs.readdirSync(path.join(BASE, '.s')).filter((n) => n.includes(RUN_ID) || n.startsWith('.tmp-')).map((n) => `.s/${n}`) : []),
];
process.stdout.write(`\nresumo: ${results.length - failed}/${results.length} cenários passaram; base ${BASE}; sobras deste run: ${leftovers.length === 0 ? 'nenhuma' : leftovers.join(', ')}\n`);
if (KEEP) process.stdout.write(`evidência mantida em ${evidence}\n`);
else fs.rmSync(evidence, { recursive: true, force: true });
if (!BASE_EXISTED) {
  for (const dir of [path.join(BASE, '.owners'), path.join(BASE, '.s'), BASE, ...(SCRATCH_ROOT_EXISTED ? [] : [path.dirname(BASE)])]) {
    try { fs.rmdirSync(dir); } catch { /* não vazia ou já ausente: fica */ }
  }
}
process.exitCode = failed === 0 && leftovers.length === 0 ? 0 : 1;
