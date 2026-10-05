# dsh-session-scratch — hook BASH_ENV (fonte única; sourced, não executado).
#
# O plugin aponta process.env.BASH_ENV do DSH para este arquivo, então TODO
# `bash -c` não interativo que o DSH dispara (e os bash aninhados) o lê antes
# do comando. Sem DSH_SCRATCH_DIR (variável que o shellEnv do DSH injeta só
# nas chamadas da ferramenta bash) ele não faz nada além de encadear um
# BASH_ENV anterior.
#
# Variáveis do plugin (shellEnv):
#   DSH_SCRATCH_CANONICAL_DIR  pasta real da sessão (<host>/agent-scratch/dsh/<id>)
#   DSH_SCRATCH_DIR            o que exportar: o apelido curto
#                              <host>/agent-scratch/dsh/.s/<hash> -> ../<id>
#                              (sockets AF_UNIX: Chromium usa TMPDIR + ~46 bytes,
#                              o forkserver do Python TMPDIR + 32; limite 107),
#                              ou a própria pasta quando o caminho já é curto
#   DSH_SCRATCH_HOST_TMPDIR    o TMPDIR cru do processo do DSH
#
# Regras:
# - TMPDIR/TMP/TEMP (e TMPPREFIX=<…>/zsh, onde o zsh grava here-docs) mudam só
#   quando TMPDIR está vazio ou ainda é o default do host — um override
#   explícito (`TMPDIR=/x bash -c ...`) e o valor já herdado por um bash
#   aninhado ficam;
# - a pasta CANÔNICA é recriada (0700) se sumiu, mas a BASE nunca: quem cria a
#   base é o plugin, junto com o .owners que a identifica como base de scratch;
# - o apelido só é exportado se é um symlink que resolve para a MESMA pasta
#   (mesmo dev/inode, `-ef`); senão exporta o caminho canônico (funciona, só
#   sem a folga para sockets). O hook nunca cria, troca nem apaga apelidos;
# - se a pasta não é gravável (sandbox workspace-write: /var/tmp é read-only e
#   /tmp é um tmpfs privado por comando), cai para /tmp SÓ quando o TMPDIR do
#   host também não é gravável e /tmp é; senão deixa o TMPDIR como estava
#   (sandbox read-only: nada é gravável, nem /tmp);
# - sempre que o hook troca o TMPDIR (pasta da sessão, ou o /tmp do sandbox),
#   DSH_SCRATCH_DIR passa a ser exatamente esse TMPDIR. Quando NÃO troca
#   (override explícito, bash aninhado, pasta inutilizável com o host
#   gravável, sandbox read-only), DSH_SCRATCH_DIR fica como o plugin publicou
#   (o caminho da sessão) e pode diferir do TMPDIR;
# - silencioso, idempotente e seguro sob `set -eu` (tudo em condição de if).
if [ -n "${DSH_SCRATCH_DIR-}" ]; then
  __dss_host="${DSH_SCRATCH_HOST_TMPDIR-}"
  __dss_cur="${TMPDIR-}"
  __dss_real="${DSH_SCRATCH_CANONICAL_DIR:-$DSH_SCRATCH_DIR}"
  if [ -z "$__dss_cur" ] || { [ -n "$__dss_host" ] && [ "${__dss_cur%/}" = "${__dss_host%/}" ]; }; then
    if { [ -d "$__dss_real" ] || (umask 077 && mkdir -- "$__dss_real"); } 2>/dev/null \
      && { : >>"$__dss_real/.w"; } 2>/dev/null; then
      __dss_use="$__dss_real"
      if [ "$DSH_SCRATCH_DIR" != "$__dss_real" ] && [ -L "$DSH_SCRATCH_DIR" ] && [ "$DSH_SCRATCH_DIR" -ef "$__dss_real" ]; then
        __dss_use="$DSH_SCRATCH_DIR"
      fi
      export TMPDIR="$__dss_use" TMP="$__dss_use" TEMP="$__dss_use" TMPPREFIX="$__dss_use/zsh" DSH_SCRATCH_DIR="$__dss_use"
    elif [ -n "$__dss_host" ] && [ ! -w "$__dss_host" ] && [ -d /tmp ] && [ -w /tmp ]; then
      export TMPDIR=/tmp TMP=/tmp TEMP=/tmp TMPPREFIX=/tmp/zsh DSH_SCRATCH_DIR=/tmp
    fi
  fi
  unset __dss_host __dss_cur __dss_real __dss_use
fi
if [ -n "${SESSION_SCRATCH_PREV_BASH_ENV-}" ] && [ "$SESSION_SCRATCH_PREV_BASH_ENV" != "${BASH_SOURCE-}" ] \
  && [ -r "$SESSION_SCRATCH_PREV_BASH_ENV" ]; then
  . "$SESSION_SCRATCH_PREV_BASH_ENV"
fi
