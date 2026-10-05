// @ts-check
/**
 * "Em uso por algum processo vivo?" — o `proc_refs`/`refs_hit` da
 * tmpdir-agent-skill. Um sobrevivente (Chromium, servidor de dev, `sleep`
 * largado em segundo plano) que continua usando a pasta da sessão depois que
 * o DSH dono morreu não tem marcador: só o /proc o denuncia. Como o TMPDIR
 * exportado é o APELIDO, o environ dele traz `.s/<hash>`, e o cwd e os fds
 * trazem o caminho real (que o kernel resolve): a conferência casa os dois.
 * @module dsh-session-scratch/inuse
 */

import fs from 'node:fs';
import path from 'node:path';

/** Variáveis do environ que contam como referência (as que o hook exporta). */
export const REF_ENV_KEYS = Object.freeze(['TMPDIR=', 'TMP=', 'TEMP=', 'TMPPREFIX=']);

/** Teto de leitura do environ de um processo (o da skill: 1 MiB). */
const ENVIRON_MAX = 1 << 20;

/**
 * @typedef {object} ProcRefsOptions
 * @property {number} [uid] só processos deste uid (default: o euid; -1 = todos)
 * @property {number[]} [exclude] pids ignorados (default: este processo)
 * @property {string} [procRoot] raiz do procfs (default `/proc`)
 */

/**
 * Caminhos em uso por processos vivos do euid: cwd, alvo de cada fd aberto e
 * os valores de TMPDIR/TMP/TEMP/TMPPREFIX do environ. Assíncrono (não trava
 * o event loop do DSH) e nunca lança: processo que some no meio, ou /proc
 * ilegível, só deixam de contribuir.
 * @param {ProcRefsOptions} [options]
 * @returns {Promise<string[]>}
 */
export async function procRefs(options = {}) {
  const uid = options.uid ?? process.getuid?.() ?? -1;
  const exclude = new Set(options.exclude ?? [process.pid]);
  const root = options.procRoot ?? '/proc';
  /** @type {string[]} */
  const refs = [];
  let names;
  try {
    names = await fs.promises.readdir(root);
  } catch {
    return refs;
  }
  // Um buffer só (o laço é sequencial): nada de 1 MiB alocado por processo.
  const buf = Buffer.allocUnsafe(ENVIRON_MAX);
  for (const name of names) {
    if (!/^\d+$/.test(name) || exclude.has(Number(name))) continue;
    const dir = path.join(root, name);
    try {
      const st = await fs.promises.stat(dir);
      if (uid >= 0 && st.uid !== uid) continue;
    } catch {
      continue;
    }
    try { refs.push(await fs.promises.readlink(path.join(dir, 'cwd'))); } catch { /* sumiu ou sem permissão */ }
    try {
      const handle = await fs.promises.open(path.join(dir, 'environ'), 'r');
      try {
        const { bytesRead } = await handle.read(buf, 0, ENVIRON_MAX, 0);
        for (const kv of buf.subarray(0, bytesRead).toString('utf8').split('\0')) {
          for (const k of REF_ENV_KEYS) if (kv.startsWith(k)) refs.push(kv.slice(k.length));
        }
      } finally {
        await handle.close();
      }
    } catch { /* sumiu ou sem permissão */ }
    let fds;
    try {
      fds = await fs.promises.readdir(path.join(dir, 'fd'));
    } catch {
      continue;
    }
    const targets = await Promise.all(fds.map((fd) => fs.promises.readlink(path.join(dir, 'fd', fd)).catch(() => null)));
    for (const t of targets) if (t !== null) refs.push(t);
  }
  return refs;
}

/**
 * `true` quando alguma referência É um dos caminhos ou fica DEBAIXO dele.
 * Um cwd de pasta já apagada vem com o sufixo ` (deleted)`, que não atrapalha
 * (a comparação é por prefixo `<caminho>/`).
 * @param {string[]} refs
 * @param {string[]} paths
 */
export function refsHit(refs, paths) {
  const ps = paths.filter((p) => p.length > 0).map((p) => (p.length > 1 ? p.replace(/\/+$/, '') : p));
  for (const r of refs) {
    for (const p of ps) {
      if (r === p || r.startsWith(`${p}/`)) return true;
    }
  }
  return false;
}

/**
 * Fotografia PREGUIÇOSA (no máximo uma leitura do /proc por varredura, e só
 * se alguma decisão precisar dela).
 * @param {() => Promise<string[]>} [read] leitor das referências (injetável nos testes)
 * @returns {(paths: string[]) => Promise<boolean>}
 */
export function lazyInUse(read = () => procRefs()) {
  /** @type {Promise<string[]>|null} */
  let snapshot = null;
  return async (paths) => {
    snapshot ??= read().catch(() => []);
    return refsHit(await snapshot, paths);
  };
}
