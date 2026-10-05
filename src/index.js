// @ts-check
/**
 * dsh-session-scratch — pasta de temporários PRIVADA por sessão para o DSH.
 *
 * O que `apply` liga (tudo reversível pelo fiber do Cordis):
 * 1. regra no system prompt (seção global de nome único, texto estático,
 *    `interpolate: false`, logo depois da seção do bash);
 * 2. contribuidor `shellEnv` que publica, em toda chamada de bash, a pasta
 *    canônica da sessão (`DSH_SCRATCH_CANONICAL_DIR`: criada sob demanda,
 *    0700, com marcador de dono) e o caminho a exportar (`DSH_SCRATCH_DIR`:
 *    o apelido curto `.s/<hash>` → `../<key>` quando a pasta canônica passa
 *    de 60 bytes — sockets AF_UNIX do Chromium e do forkserver do Python —,
 *    senão a própria pasta);
 * 3. `process.env.BASH_ENV` → `hooks/bash-env.sh`, que exporta
 *    TMPDIR/TMP/TEMP = DSH_SCRATCH_DIR (e TMPPREFIX=<…>/zsh) em todo
 *    `bash -c` do agente;
 * 4. guarda de `/tmp` literal: `deny` no tools/pre-execute ou aviso no
 *    tools/post-execute;
 * 5. limpeza: saída real do processo (exit/SIGTERM/SIGINT), inatividade
 *    (`idleDays`) e varredura de órfãos por marcador (pid + starttime do
 *    /proc + boot_id). `agent/disposed` NÃO apaga: no `dsh web` ele também
 *    dispara em reload do SessionController (a sessão segue viva e é retomada
 *    sob demanda), e apagar ali perderia o rascunho no meio da sessão.
 *
 * Só builtins do Node em runtime: o plugin é carregado por caminho absoluto
 * (insert no ~/.dsh/cordis.patch.yml), onde imports `@deepseek-ai/*` não
 * resolvem. Nenhum caminho assíncrono fica sem `.catch` — uma rejeição solta
 * derruba o processo do DSH.
 * @module dsh-session-scratch
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from './config.js';
import { classifyToolCall, scratchExemptPrefixes } from './detect.js';
import { hostTmpdir, processTmpdir, rootSessionKey } from './paths.js';
import { ScratchStore, detachOwnSync, installExitCleanup, processState } from './store.js';
import { sweepOnce } from './sweep.js';
import {
  PROMPT_RULE,
  SECTION_NAME,
  VAR_DESCRIPTIONS,
  WARN_FILE_TEXT,
  WARN_TEXT,
  WARN_WORKDIR_TEXT,
  fileDenyReason,
  shellDenyReason,
  workdirDenyReason,
} from './text.js';

/** Nome Cordis do plugin. */
export const name = 'dsh-session-scratch';

/** Serviços obrigatórios (nunca `logger`: use ctx.logger). */
export const inject = ['systemPrompt', 'shellEnv', 'tools'];

/** Nome do contribuidor no shellEnv. */
export const CONTRIBUTOR_NAME = 'session-scratch';

/** Caminho absoluto do hook BASH_ENV. */
export const HOOK_PATH = fileURLToPath(new URL('../hooks/bash-env.sh', import.meta.url));

/** Variável que guarda um BASH_ENV anterior para o hook encadear (não é DSH_*, sobrevive ao scrub). */
export const PREV_BASH_ENV = 'SESSION_SCRATCH_PREV_BASH_ENV';

/**
 * Diagnóstico opt-in: com `SESSION_SCRATCH_TRACE=<arquivo>` no ambiente do
 * DSH, cada evento do ciclo de vida vira uma linha JSON nesse arquivo
 * (desligado por padrão; nunca lança).
 * @param {string|undefined} file
 * @returns {((event: string, detail?: unknown) => void) | null}
 */
export function makeTracer(file) {
  if (typeof file !== 'string' || file.length === 0) return null;
  return (event, detail) => {
    try {
      fs.appendFileSync(file, `${JSON.stringify({ t: new Date().toISOString(), pid: process.pid, event, detail })}\n`, { mode: 0o600 });
    } catch { /* diagnóstico nunca derruba nada */ }
  };
}

/**
 * @typedef {{ id: string, parentSession?: string, origin?: string, cwd?: string }} Header
 * @typedef {{ id?: string, session: { header: Header } }} AgentLike
 * @typedef {{ name: string, arguments: unknown, agent?: AgentLike }} ExecLike
 * @typedef {{ type: string, text?: string }} ContentBlock
 */

/**
 * @param {any} ctx contexto Cordis (tipado como any: sem import de @deepseek-ai/cordis em runtime)
 * @param {unknown} rawConfig config da linha do cordis.patch.yml
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);

  /** @param {'debug'|'info'|'warn'} level @param {string} message */
  const log = (level, message) => {
    try { ctx.logger?.[level]?.(`session-scratch: ${message}`); } catch { /* log nunca derruba nada */ }
  };

  // Raiz do host SEM aninhar (um `dsh` lançado do bash de um agente herda
  // TMPDIR=<…>/agent-scratch/<harness>/<id>); o bash, porém, herda o TMPDIR
  // cru do processo, que é o que o hook compara para achar override explícito.
  const tmpRoot = hostTmpdir();
  const inheritedTmp = processTmpdir();
  const store = new ScratchStore({ tmpRoot, baseDir: config.baseDir, log: (m) => log('warn', m) });
  const trace = makeTracer(process.env.SESSION_SCRATCH_TRACE);
  if (trace !== null) processState().trace = trace;
  installExitCleanup();

  /** id de sessão → chave da pasta (raiz da cadeia de subagentes). */
  /** @type {Map<string, string>} */
  const rootCache = new Map();

  /** @param {AgentLike} agent */
  const keyFor = (agent) => {
    const agents = ctx.get?.('agents');
    return rootSessionKey(agent.session.header, {
      share: config.shareWithSubagents,
      cache: rootCache,
      lookup: (id) => agents?.get?.(id)?.session?.header,
    });
  };

  /* 1. Regra no system prompt. */
  if (config.promptRule) {
    ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: ctx.systemPrompt.getSectionOrder('TOOL_BASH') + 5,
      text: PROMPT_RULE,
      interpolate: false,
    });
  }

  /* 2. DSH_SCRATCH_DIR (+ canônica) em cada chamada de bash. resolve() NUNCA lança. */
  ctx.shellEnv.register({
    name: CONTRIBUTOR_NAME,
    variables: {
      DSH_SCRATCH_DIR: { description: VAR_DESCRIPTIONS.DSH_SCRATCH_DIR },
      DSH_SCRATCH_CANONICAL_DIR: { description: VAR_DESCRIPTIONS.DSH_SCRATCH_CANONICAL_DIR },
      DSH_SCRATCH_HOST_TMPDIR: { description: VAR_DESCRIPTIONS.DSH_SCRATCH_HOST_TMPDIR },
    },
    /** @param {{ agent?: AgentLike }} execution */
    resolve(execution) {
      try {
        const agent = execution?.agent;
        if (agent === undefined || agent === null) return {};
        const { dir, alias } = store.session(keyFor(agent));
        return { DSH_SCRATCH_DIR: alias ?? dir, DSH_SCRATCH_CANONICAL_DIR: dir, DSH_SCRATCH_HOST_TMPDIR: inheritedTmp };
      } catch (error) {
        log('warn', `sem pasta de sessão para esta chamada: ${String(error)}`);
        return {};
      }
    },
  });

  /* 3. BASH_ENV do processo → hook (scrubbedParentEnv relê process.env a cada spawn). */
  if (config.exportTmpdir) {
    ctx.effect(() => {
      const prev = process.env.BASH_ENV;
      const prevChain = process.env[PREV_BASH_ENV];
      if (prev !== undefined && prev !== '' && prev !== HOOK_PATH) process.env[PREV_BASH_ENV] = prev;
      process.env.BASH_ENV = HOOK_PATH;
      return () => {
        if (process.env.BASH_ENV === HOOK_PATH) {
          if (prev === undefined) delete process.env.BASH_ENV;
          else process.env.BASH_ENV = prev;
        }
        if (prevChain === undefined) delete process.env[PREV_BASH_ENV];
        else process.env[PREV_BASH_ENV] = prevChain;
      };
    }, 'session-scratch: BASH_ENV');
  }

  /* Início de sessão: cria a pasta já (resume/HMR também passam por resolve()). */
  ctx.on('agent/created', (/** @type {{ agent: AgentLike }} */ payload) => {
    try {
      const agent = payload?.agent;
      if (agent?.session?.header === undefined) return undefined;
      const key = keyFor(agent);
      rootCache.set(agent.session.header.id, key);
      const { alias } = store.session(key, { force: true });
      trace?.('agent/created', { id: agent.session.header.id, key, alias, source: /** @type {any} */ (payload).source });
    } catch (error) {
      // Um throw aqui falharia a criação do agente: só registra.
      log('warn', `agent/created: ${String(error)}`);
    }
    return undefined;
  });

  /* Fim de agente: só esquece o cache. NÃO apaga a pasta — no web isto
   * também dispara em reload do SessionController (plugin reconcile, HMR,
   * troca de serviço injetado) com a sessão ainda viva. A pasta continua
   * deste processo: sai no `exit`, no SIGTERM/SIGINT ou após `idleDays`. */
  ctx.on('agent/disposed', (/** @type {{ agent: AgentLike }} */ payload) => {
    try {
      const header = payload?.agent?.session?.header;
      if (header === undefined) return;
      const key = rootCache.get(header.id) ?? null;
      rootCache.delete(header.id);
      trace?.('agent/disposed', { id: header.id, key, action: 'kept' });
    } catch (error) {
      log('warn', `agent/disposed: ${String(error)}`);
    }
  });

  /* 4. Guarda + toque de atividade. */
  // Host-tmp sob /tmp (DSH sem TMPDIR): a própria árvore de scratch fica
  // isenta para write/edit/workdir, senão o remédio do deny ("use o caminho
  // de `echo "$TMPDIR"`") seria negado de novo. Mesma regra da skill.
  const exemptPrefixes = scratchExemptPrefixes(store.scratchRoot);
  const policy = {
    guardTools: config.guardTools,
    fileTools: config.fileTools,
    allowPrefixes: config.allowPrefixes,
    escapeMarker: config.escapeMarker,
    exemptPrefixes,
  };
  /** Motivo (deny) e aviso (warn) por tipo de acerto; todos estáticos. */
  const reasons = {
    shell: shellDenyReason(config.escapeMarker),
    workdir: workdirDenyReason(config.escapeMarker),
    file: fileDenyReason(config.escapeMarker),
  };
  const warnings = { shell: WARN_TEXT, workdir: WARN_WORKDIR_TEXT, file: WARN_FILE_TEXT };

  /** @param {ExecLike} exec */
  const classify = (exec) => {
    try {
      return classifyToolCall(exec.name, exec.arguments, policy, exec.agent?.session?.header?.cwd);
    } catch {
      return null;
    }
  };

  ctx.on('tools/pre-execute', async (/** @type {ExecLike} */ exec, /** @type {() => Promise<unknown>} */ next) => {
    try {
      if (exec?.agent?.session?.header !== undefined) store.ensure(keyFor(exec.agent));
    } catch { /* toque é best effort */ }
    if (config.guard === 'deny') {
      const hit = classify(exec);
      if (hit !== null) {
        trace?.('guard/deny', { tool: exec.name, kind: hit });
        return { kind: 'deny', reason: reasons[hit] };
      }
    }
    return next();
  });

  if (config.guard === 'warn') {
    ctx.on('tools/post-execute', async (
      /** @type {ExecLike} */ exec,
      /** @type {{ content?: ContentBlock[] }} */ result,
      /** @type {() => Promise<Record<string, unknown>>} */ next,
    ) => {
      const decision = await next();
      try {
        if (decision?.kind !== 'accept') return decision;
        if (Object.hasOwn(decision, 'content') || Object.hasOwn(decision, 'value')) return decision;
        const hit = classify(exec);
        if (hit === null) return decision;
        return { ...decision, content: [...(result?.content ?? []), { type: 'text', text: warnings[hit] }] };
      } catch {
        return decision;
      }
    });
  }

  /* 5a. Varredura: no arranque e a cada sweepIntervalMinutes (timers unref). */
  const idleMs = config.idleDays * 24 * 60 * 60 * 1000;
  const graceMs = config.orphanGraceMinutes * 60 * 1000;
  let sweeping = false;
  const runSweep = () => {
    if (sweeping) return;
    sweeping = true;
    sweepOnce(store, { idleMs, graceMs, log: (m) => log('warn', m) })
      .then((report) => {
        trace?.('sweep', report);
        if (report.deleted.length > 0 || report.trashCleared.length > 0 || report.aliasesCleared.length > 0) {
          log('info', `varredura: ${report.deleted.length} pasta(s), ${report.trashCleared.length} lixeira(s) e ${report.aliasesCleared.length} apelido(s) pendurado(s) apagados`);
        }
      })
      .catch((error) => { log('warn', `varredura falhou: ${String(error)}`); })
      .finally(() => { sweeping = false; });
  };
  ctx.effect(() => {
    const first = setImmediate(runSweep);
    first.unref?.();
    const timer = setInterval(runSweep, config.sweepIntervalMinutes * 60 * 1000);
    timer.unref?.();
    return () => {
      clearImmediate(first);
      clearInterval(timer);
    };
  }, 'session-scratch: sweeper');

  /* 5b. Shutdown real: SIGTERM/SIGINT marcam o flag e o disposer tira as
   * pastas próprias do lugar (rename para .trash-*, rápido: o disposer roda
   * dentro do teto de 5 s do DSH); o rm pesado fica para o `exit`. HMR/reload
   * de config não apagam nada. Só escuta sinais que o host já trata (um
   * listener novo suprimiria a saída padrão do Node). O listener de `exit`
   * (installExitCleanup) cobre também a saída natural do headless. */
  ctx.effect(() => {
    const onSignal = (/** @type {string} */ sig) => { processState().shuttingDown = true; trace?.('signal', sig); };
    const signals = /** @type {const} */ (['SIGTERM', 'SIGINT']).filter((s) => process.listenerCount(s) > 0);
    for (const s of signals) process.on(s, onSignal);
    return () => {
      for (const s of signals) process.off(s, onSignal);
      if (processState().shuttingDown) {
        try { trace?.('shutdown-detach', detachOwnSync()); } catch { /* exit tenta de novo */ }
      } else {
        trace?.('dispose', { shuttingDown: false });
      }
    };
  }, 'session-scratch: shutdown');

  log('info', `base=${store.base} guard=${config.guard} exportTmpdir=${config.exportTmpdir} promptRule=${config.promptRule}`);
  trace?.('apply', { base: store.base, inheritedTmp, guard: config.guard, bashEnv: process.env.BASH_ENV ?? null });
}
