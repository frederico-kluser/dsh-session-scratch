# Changelog

## 0.1.2 — 2026-10-04

Bloqueador antes da instalação: o TMPDIR exportado era longo demais para sockets AF_UNIX.

- **Apelido curto como TMPDIR** (`src/alias.js`, novo). A pasta canônica `<host-tmp>/agent-scratch/dsh/session-<uuid>` tem 81 bytes aqui; o Chromium (google-chrome-stable e o Chrome for Testing do Playwright) põe o `SingletonSocket` em TMPDIR + ~46 bytes e morria na hora com `FATAL … Socket path too long` (limite de `sun_path`: 107), e o `multiprocessing` do Python 3.14 (`forkserver`, TMPDIR + 32) caía em silêncio para o `/tmp` literal (de 76 a 79 bytes, `OSError`). Agora o TMPDIR/TMP/TEMP exportado é o symlink `<host-tmp>/agent-scratch/dsh/.s/<sha256(id)[:8]>` → `../<id>` (**48 bytes** aqui), o mesmo esquema do hook da tmpdir-agent-skill (`agent-scratch/claude/.s/<hash8>`): só quando a canônica passa de 60 bytes e o apelido é mais curto. Os arquivos continuam na pasta canônica do contrato.
- Criação atômica e **sem substituição** (symlink temporário + `link(2)`, EEXIST se ocupado; `symlink(2)` direto onde `link` de symlink não existe). Colisão nunca reaponta o apelido de outra sessão: tenta 10, 12, 14 e 16 hex; esgotados, exporta o caminho canônico. Um apelido da sessão que já exista é reaproveitado (estável). O plugin confere o apelido (léxico, sem segui-lo) a cada chamada de bash e o recria se sumiu.
- `shellEnv`: `DSH_SCRATCH_DIR` passa a ser o caminho exportado (apelido ou canônica) e a nova `DSH_SCRATCH_CANONICAL_DIR` traz a pasta real. O hook `BASH_ENV` recria a folha pela canônica, só exporta o apelido se ele resolve para a mesma pasta (`-ef`), reafirma `DSH_SCRATCH_DIR` = TMPDIR e exporta também `TMPPREFIX=<TMPDIR>/zsh` (here-docs do zsh, paridade com a skill; no fallback do sandbox, `/tmp/zsh`).
- Limpeza: o apelido sai junto com a pasta em todos os caminhos (saída do processo, SIGTERM, ociosidade, órfão) — `unlink` do próprio link, só depois que a pasta canônica saiu do lugar e só se o link ainda é `../<id>`. A varredura desliga apelidos pendurados (pasta ausente, dono não vivo, além de `orphanGraceMinutes`) e restos `.tmp-*`; preserva o de dono vivo, o de pasta presente e links alheios; `.s` trocado por symlink aborta a passada de apelidos. Relatório da varredura ganha `aliasesCleared`.
- Rede de segurança da skill: `x %T/agent-scratch/dsh*/.s` no `contrib/user-tmpfiles.d/agent-scratch.conf` (conferido com `systemd-tmpfiles --user --dry-run --clean`).
- Testes: 312 unitários (novo `test/alias.test.js` com corrida entre 18 processos reais; varredura de apelidos; hook com apelido válido/pendurado/alheio/ausente, `forkserver` real e here-docs do zsh; paridade do nome e do limiar do apelido com `alias_path`/`needs_alias` da skill). E2e: 12 cenários, com os novos `tmpdir-length`, `chrome`, `chromium-playwright` e `forkserver`, cada um dos três últimos com um controle no caminho canônico que ainda falha.
- Achado à parte (documentado, sem relação com o plugin): o Chrome for Testing do Playwright com `--dump-dom` fica pendurado com qualquer TMPDIR sem `--disable-field-trial-config` (flag que o próprio Playwright sempre passa).

Correções da revisão do apelido (ainda antes da instalação):

- **Remoção do apelido refeita na hora** (`unlinkStaleAlias`): a conferência "pasta canônica ausente" era feita uma vez antes do laço (saída/remoção) ou separada do `unlink` por vários `await` (varredura); uma retomada da sessão nessa janela perdia o apelido (o próximo comando exportava o caminho longo e o Chromium morria). Agora `.s`, link (inode e texto), pasta ausente, dono não vivo e partilhador são lidos de novo de forma síncrona imediatamente antes de cada `unlink`, e o apelido é republicado se a pasta reaparece logo depois.
- **`.s` fixado na criação**: dev/ino do `.s` reconferidos antes de cada candidato e depois da publicação; `isOwnAlias` (e o apelido em cache) exigem `.s` real do euid. Antes, um `.s` trocado por symlink no meio do laço recebia o link e o caminho dele era devolvido (e ficava em cache).
- **Sessão partilhada**: dois processos vivos do DSH na mesma sessão — a saída do dono renomeava a pasta para a lixeira (apagando os arquivos do outro) e desligava o apelido em uso por ele. Agora quem partilha registra `.owners/<id>@<pid>.share`; na saída do dono o marcador passa para o partilhador vivo e nada é apagado; `remove()` e a varredura mantêm (`live-sharer`); registros de pid morto saem na varredura.
- **Varredura respeita sobreviventes** (paridade com o `in_use` da skill, `src/inuse.js`): pasta órfã ou ociosa, lixeira e apelido pendurado em uso por um processo vivo do euid (cwd, fds, `TMPDIR`/`TMP`/`TEMP`/`TMPPREFIX` apontando para a canônica ou para qualquer apelido dela) ficam (`kept: in-use`). Antes, um Chromium que sobreviveu a um SIGKILL do DSH perdia o perfil 30 min depois.
- **Regra do prompt** (e a da skill, em paridade): `"$TMPDIR"` pode ser um symlink — em `find`, `du`, `tar`, `cp -r` e `ls -l` use `"$TMPDIR/"`. README documenta o efeito (até a 0.1.1 esses idiomas funcionavam).
- **Hook**: no fallback do sandbox `workspace-write` também `DSH_SCRATCH_DIR=/tmp` (antes ficava o apelido, read-only lá dentro); a documentação diz exatamente quando `DSH_SCRATCH_DIR` = TMPDIR.
- Sem apelido possível: nova tentativa no máximo a cada 60 s e log só na transição (antes, ~7 linhas de log a cada chamada de bash até o fim da sessão).
- E2e: novo cenário `sandbox-readonly` (nada gravável; o hook não muda nada; `mktemp` falha igual ao controle sem o plugin) e `find "$TMPDIR"` vs `find "$TMPDIR/"` no cenário `tmpdir`.
- Testes: 335 unitários (novo `test/inuse.test.js`; retomadas injetadas no último `await` e na janela final do `unlink`; `.s` trocado no meio do laço e depois da publicação; back-off; sessão partilhada com dois processos reais; sobreviventes reais segurando a pasta na varredura); e2e com 13 cenários.

## 0.1.1 — 2026-10-04

Correções da revisão independente (antes da primeira instalação).

- **Remoção nunca cruza ponto de montagem** (`src/remove.js`, novo): o `fs.rmSync` recursivo da saída descia num sshfs/bind montado dentro da pasta da sessão e apagava o conteúdo remoto. Agora uma pasta com montagem dentro não é renomeada nem apagada (mountinfo), e a caminhada não desce em outro `st_dev` nem em outro `mnt_id`. Testado com montagens reais em `unshare -Urm`.
- Remoção destrava subpastas read-only reais (cache 0555 do Go) pelo fd `O_PATH|O_NOFOLLOW`; antes a lixeira vazava para sempre.
- Saída do processo com orçamento de 1 s conferido antes de cada operação de disco (antes, um `npm install` no `$TMPDIR` segurava a saída por 13 s, sem Ctrl-C possível); o resto fica como `.trash-*` para a próxima varredura.
- Cadeia `agent-scratch → base → .owners` revalidada (lstat, euid, dev/ino da base) antes de toda operação destrutiva e de cada toque: base ou `.owners` trocados por symlink depois do arranque abortam a varredura em vez de apagar o alvo.
- Base e `.owners` que somem com o DSH no ar (tmpfiles, `rm -rf`) são recriados no próximo bash/varredura; antes o TMPDIR privado caía em silêncio para o tmp compartilhado até reiniciar o DSH. O hook passa a recriar só a pasta da sessão, nunca a base.
- Raiz do host sem aninhar: `dsh` lançado do bash de um agente (TMPDIR = pasta de sessão) não monta mais a árvore dentro da sessão-mãe (que seria apagada com ela). Mesma regra do `host_tmp()` da skill, com teste de paridade.
- `agent/disposed` não apaga mais a pasta: no web ele dispara em reload do SessionController com a sessão viva. A regra do prompt deixou de prometer "apagado quando a sessão termina".
- Detector linear: comandos longos com muitos `/tmp` num só token (`a=/tmp/x:/tmp/y:…`) travavam o event loop do host por minutos; agora milissegundos, com resultado idêntico (fuzz contra a implementação anterior).
- `baseDir` restrito a `agent-scratch/dsh` (ou `agent-scratch/dsh-<x>`): `agent-scratch/claude` faria a varredura apagar sessões vivas do Claude Code.
- Textos: marcador de escape sozinho na **primeira** linha (no fim quebrava heredocs); motivo próprio para `workdir` em `/tmp` (omitir o workdir, que não expande variáveis); aviso próprio para write/edit no modo `warn`; regra e motivos dizem o que fazer quando `$TMPDIR` é o `/tmp` do sandbox (não persiste) ou quando o workspace está sob `/tmp`.
- Host sem TMPDIR (árvore sob `/tmp`): a árvore de scratch fica isenta para write/edit/workdir, como no `_scratch_exempt` da skill.
- README: limites conhecidos do contrato (falsos negativos e positivos, workspace sob `/tmp`) com as emendas sugeridas; `terminal_*` corretamente listadas como **sem** guarda.
- Testes: 282 unitários (paridade JS⇄Python do detector e da raiz do host; montagens reais), e2e com o cenário `nested-host`.

## 0.1.0 — 2026-10-04

Primeira versão.

- Pasta de temporários privada por sessão em `<host-tmp>/agent-scratch/dsh/<id>/` (0700), publicada como `DSH_SCRATCH_DIR` pelo `ctx.shellEnv` e aplicada a TMPDIR/TMP/TEMP por um hook `BASH_ENV` (`hooks/bash-env.sh`): override explícito e bash aninhado preservados, fallback para o `/tmp` privado do bwrap no sandbox `workspace-write`, `BASH_ENV` anterior encadeado.
- Regra estática em pt-BR no system prompt (seção global `session-scratch:tmp-rule`, `TOOL_BASH + 5`, `interpolate: false`).
- Guarda de `/tmp` literal com o detector do contrato partilhado com a `tmpdir-agent-skill`: `deny` (motivo em pt-BR com a correção e o marcador `allow-literal-tmp`) ou `warn`; ferramentas reais do DSH (`bash` → `command`/`workdir`; `write`/`edit` → `file_path`).
- Limpeza: `exit` do processo, SIGTERM/SIGINT (rename rápido no disposer, rm no `exit`), `agent/disposed`, inatividade (`idleDays`) e varredura de órfãos por marcador (pid + starttime do `/proc` + boot_id), com rename para `.trash-*`, reverificação do marcador (corrida de takeover) e rm sem seguir symlink, só sob `<host-tmp>/agent-scratch/`.
- Subagentes in-process partilham a pasta da sessão raiz (`shareWithSubagents`).
- Config validada em `apply()` (chave desconhecida ou valor inválido lança).
- `scripts/install-home-patch.mjs`: instala/atualiza/remove o bloco no `~/.dsh/cordis.patch.yml` com `--dry-run`, `--check`, `--uninstall`, `--verify` (`dsh --dump-config` por profile) e backup.
- Diagnóstico opt-in `SESSION_SCRATCH_TRACE`.
- Testes: 210 unitários (`node --test`), incluindo bash real do hook e `--dump-config` dos profiles web/headless/dwg-share num `DSH_HOME` temporário; e2e (`scripts/e2e/run-e2e.mjs`) contra o DSH instalado com o mock LLM scriptado do repo do DSH.
