// @ts-check
/**
 * Textos vistos pelo modelo (pt-BR), ESTÁTICOS: nada de timestamp, id de
 * sessão ou caminho expandido — a seção do system prompt é remontada a cada
 * passo e precisa ser byte-idêntica para o cache de prompt continuar quente.
 * O único parâmetro é o marcador de escape configurado (fixo por processo).
 *
 * O marcador vai SOZINHO NA PRIMEIRA LINHA do comando: no fim, colado ao
 * terminador de um heredoc (`EOF # allow-literal-tmp`), ele quebraria o
 * heredoc em silêncio; na primeira linha é seguro também com continuações de
 * linha e strings de várias linhas.
 * @module dsh-session-scratch/text
 */

/** Nome ÚNICO da seção do system prompt (camada global). */
export const SECTION_NAME = 'session-scratch:tmp-rule';

/** Regra injetada no system prompt (logo depois da seção do bash). */
export const PROMPT_RULE = [
  'Arquivos temporários: nunca use o caminho literal /tmp em comandos de shell nem em ferramentas de arquivo',
  '(nada de `> /tmp/...`, `mkdir /tmp/...`, `-o /tmp/...`, `cd /tmp`).',
  'Use "$TMPDIR": ele já aponta para o diretório de rascunho privado desta sessão (temporário: pode ser apagado quando o DSH encerra ou após dias sem uso).',
  'Exemplos: `out="$TMPDIR/saida.txt"`, `d=$(mktemp -d)` (mktemp respeita TMPDIR).',
  '"$TMPDIR" pode ser um symlink: em `find`, `du`, `tar`, `cp -r` e `ls -l` use "$TMPDIR/" (com barra no fim), senão eles tratam só o link.',
  'No shell, referencie sempre a variável; não cole o valor expandido. O `workdir` do bash não expande variáveis: use `cd "$TMPDIR" && ...`.',
  'Nas ferramentas write/edit, que não expandem variáveis, rode antes `echo "$TMPDIR"` no bash e use esse caminho absoluto;',
  'se ele mostrar só /tmp (sandbox), nada ali persiste entre comandos: use um caminho no workspace.',
  'O que precisa durar vai para o workspace. Use /tmp só se o usuário pedir explicitamente.',
].join(' ');

/**
 * @param {string} marker
 * @param {string} where
 */
function escapeClause(marker, where) {
  return `Só se o usuário pediu /tmp explicitamente, ${where} o comentário \`# ${marker}\` sozinho na primeira linha do comando.`;
}

/**
 * Motivo do bloqueio de um comando de shell (decisão `deny` do tools/pre-execute).
 * @param {string} marker marcador de escape configurado
 */
export function shellDenyReason(marker) {
  return [
    'Bloqueado: este comando usa o caminho literal /tmp.',
    'Use "$TMPDIR" (já é o diretório de rascunho privado desta sessão) ou mktemp / mktemp -d,',
    'por exemplo `> "$TMPDIR/saida.txt"` ou `d=$(mktemp -d)`, e execute de novo o comando corrigido.',
    escapeClause(marker, 'ponha'),
  ].join(' ');
}

/**
 * Motivo do bloqueio de uma chamada de bash cujo `workdir` fica em /tmp
 * (o comando em si pode nem citar /tmp).
 * @param {string} marker marcador de escape configurado
 */
export function workdirDenyReason(marker) {
  return [
    'Bloqueado: o workdir desta chamada fica em /tmp.',
    'Omita o workdir (ele não expande variáveis) e faça o cd dentro do comando:',
    '`cd "$TMPDIR" && ...` para rascunho, ou um cd relativo ao workspace; depois execute de novo.',
    escapeClause(marker, 'ponha'),
  ].join(' ');
}

/**
 * Motivo do bloqueio de uma ferramenta de arquivo (write/edit) em /tmp.
 * @param {string} marker marcador de escape configurado
 */
export function fileDenyReason(marker) {
  return [
    'Bloqueado: este caminho fica em /tmp.',
    'Para rascunho, rode `echo "$TMPDIR"` no bash e use esse caminho absoluto',
    '(se ele mostrar só /tmp, use um caminho no workspace) e repita a chamada corrigida.',
    'Se o próprio workspace desta sessão está sob /tmp, grave pelo bash com caminho relativo.',
    `Só se o usuário pediu /tmp explicitamente, grave pelo bash com o comentário \`# ${marker}\` sozinho na primeira linha do comando.`,
  ].join(' ');
}

/** Aviso anexado ao resultado no modo `warn` (o comando já rodou). */
export const WARN_TEXT = [
  'Aviso: este comando usou o caminho literal /tmp.',
  'Nos próximos comandos use "$TMPDIR" (diretório de rascunho privado desta sessão) ou mktemp -d;',
  '/tmp só com pedido explícito do usuário.',
].join(' ');

/** Aviso do modo `warn` para um `workdir` em /tmp. */
export const WARN_WORKDIR_TEXT = [
  'Aviso: o workdir desta chamada ficou em /tmp.',
  'Nas próximas, omita o workdir e use `cd "$TMPDIR" && ...` no comando;',
  '/tmp só com pedido explícito do usuário.',
].join(' ');

/** Aviso do modo `warn` para write/edit em /tmp. */
export const WARN_FILE_TEXT = [
  'Aviso: este caminho fica em /tmp.',
  'Nas próximas gravações use o caminho de `echo "$TMPDIR"` (rascunho privado desta sessão) ou o workspace;',
  '/tmp só com pedido explícito do usuário.',
].join(' ');

/** Descrições das variáveis DSH_* publicadas no shellEnv (enumeráveis pelo DSH). */
export const VAR_DESCRIPTIONS = Object.freeze({
  DSH_SCRATCH_DIR: 'Diretório de rascunho privado da sessão (o TMPDIR do bash; um apelido curto quando o caminho real é longo demais para sockets); temporário.',
  DSH_SCRATCH_CANONICAL_DIR: 'Caminho real do diretório de rascunho da sessão (para onde o apelido DSH_SCRATCH_DIR aponta); usado pelo hook BASH_ENV.',
  DSH_SCRATCH_HOST_TMPDIR: 'TMPDIR herdado do processo do DSH, usado pelo hook BASH_ENV para detectar override explícito.',
});
