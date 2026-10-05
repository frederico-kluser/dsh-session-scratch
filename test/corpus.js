// @ts-check
/**
 * Tabelas de casos do detector de /tmp literal, partilhadas entre o teste
 * unitário (detect.test.js) e o de paridade com o hook Python da skill
 * (parity.test.js). Não é arquivo de teste: só dados.
 */

/** Casos do CONTRATO partilhado com a skill (JS e Python devem concordar). */
export const CONTRACT_HITS = [
  '> /tmp/a',
  '2>/tmp/e',
  'mkdir -p /tmp/t2',
  'cp x /tmp/',
  'cd /tmp && ls',
  '"/tmp/x"',
  '--out=/tmp/o',
  'tee /tmp/log',
];
export const CONTRACT_MISSES = [
  '/var/tmp/x',
  '$TMPDIR/tmp/x',
  './tmp',
  '~/tmp',
  '/home/u/tmp',
  '/tmpfoo',
  'ls /tmp/.X11-unix',
  'echo hi > /tmp/x # allow-literal-tmp',
];

/** Casos extra. */
export const MORE_HITS = [
  '/tmp',
  'ls /tmp',
  "cat '/tmp/x'",
  'echo `ls /tmp`',
  'X=/tmp/y make',
  'a;/tmp/run.sh',
  'a|/tmp/run.sh',
  'a&/tmp/run.sh',
  '$(ls /tmp)',
  'cmd </tmp/in',
  'cmd >/tmp/out',
  'cp {/tmp,/var}/x .',
  'curl -o /tmp/f https://x',
  'TMPDIR=/tmp python3 x.py',
  'host:/tmp',
  'echo ok\n/tmp/script.sh',
  'ls /tmp/.X11-unix /tmp/other',
  'cd /tmp/.X11-unixfoo',
  'cp a /tmp/.ICE-unix/../x',
  // `..` depois de um prefixo permitido escapa dele (token normalizado; igual no Python).
  'ls /tmp/.X11-unix/../../etc/passwd',
  'cat /tmp/.X11-unix/a/../../x',
  'X=/tmp/.X11-unix/a:/tmp/b',
  'ls /tmp/.X11-unix:/tmp/.X11-unix',
];
export const MORE_MISSES = [
  '',
  'echo hello',
  '${TMPDIR:-/tmp}/x',
  'ls /tmp/.ICE-unix/abc',
  'ls /tmp/.X11-unix/X0',
  'mktemp -d',
  'echo "$TMPDIR/out.txt"',
  'ls /usr/tmp',
  'ls a/tmp/b',
  'cd tmp',
  '/tmp_x',
  '/tmp-x',
  '/tmp.x',
  'cat file#allow-literal-tmp > /tmp/x',
  // `//` e `/./` redundantes antes de um prefixo permitido não contam (normalizado; igual no Python).
  'ls /tmp//.X11-unix',
  'ls /tmp/./.X11-unix/X0',
  'ls /tmp/x/../.X11-unix/X0',
  'ls /tmp/.X11-unix/',
  // Limite CONHECIDO do contrato: `:` não está no lookahead, então `/tmp:` não acerta.
  'docker run -v /tmp:/data img',
];
