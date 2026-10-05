# dsh-session-scratch

Plugin do **DeepSeek Harness (DSH)** que dá a cada sessão de agente uma **pasta de temporários privada** e impede o uso de `/tmp` literal:

- **TMPDIR por sessão**: todo `bash -c` do agente roda com `TMPDIR`, `TMP`, `TEMP` (e `TMPPREFIX=<…>/zsh`) apontando para a pasta da sessão `<host-tmp>/agent-scratch/dsh/<id-da-sessão>/` (modo 0700) — pelo **apelido curto** `<host-tmp>/agent-scratch/dsh/.s/<hash8>` quando o caminho real é longo demais para sockets AF_UNIX (aqui: 81 bytes → 48). `mktemp`, Python `tempfile`/`multiprocessing`, Node `os.tmpdir()`, Go `os.MkdirTemp`, Chromium/Playwright e afins passam a cair ali sozinhos.
- **Regra no system prompt**: uma seção curta, estática e em pt-BR diz ao modelo para usar `"$TMPDIR"` e nunca `/tmp` literal.
- **Guarda de `/tmp` literal**: um comando de shell (ou `write`/`edit`) que usa `/tmp` é **negado** com um motivo que diz exatamente o que fazer (modo `deny`), ou recebe um aviso (modo `warn`).
- **Limpeza**: a pasta some quando o processo do DSH termina (saída natural, SIGTERM/SIGINT), quando fica ociosa (`idleDays`) e, depois de um crash/SIGKILL, pela varredura de outro processo do DSH (marcador de dono com pid + starttime do `/proc` + boot_id). A remoção nunca segue symlink, nunca cruza ponto de montagem e destrava subpastas read-only.

Sem build e sem dependências: ESM puro com `// @ts-check` + JSDoc e só builtins do Node em runtime — o plugin é carregado por **caminho absoluto** a partir do `~/.dsh/cordis.patch.yml`, onde imports `@deepseek-ai/*` não resolveriam.

## Contrato partilhado (com a `tmpdir-agent-skill` / Claude Code)

| Item | Valor |
|---|---|
| Raiz temporária do host | o `TMPDIR` do processo do harness (`os.tmpdir()`; aqui `/var/tmp/user-1000`). Se ele já for uma pasta de scratch herdada (`…/agent-scratch/<harness>/<id>`, ex.: `dsh` lançado do bash de um agente), sobe até o host-tmp: corta no primeiro segmento `agent-scratch` que tem filho (igual ao `host_tmp()` da skill) |
| Árvore de scratch | `<host-tmp>/agent-scratch/` — DSH em `dsh/<id-sanitizado>/`, Claude Code em `claude/<session-id>/` (pastas 0700). É o caminho **canônico**: os arquivos moram ali |
| `TMPDIR` exportado | o apelido curto `<árvore>/.s/<sha256(id)[:8]>` → `../<id>` (symlink relativo) quando o caminho canônico passa de **60 bytes** e o apelido é mais curto; senão o próprio caminho canônico. Mesmo esquema nos dois lados (`agent-scratch/claude/.s/<hash8>` no hook da skill); nome e limiar testados contra o `alias_path`/`needs_alias` dela |
| Marcador de escape | o texto `allow-literal-tmp` em qualquer lugar do comando (tipicamente `# allow-literal-tmp`); **só** quando o usuário pediu `/tmp` explicitamente |
| Detector (shell) | acerto = `/tmp` no início de um token de caminho: regex multiline `` (?:^\|[\s'"`=:;\|&(<>{,])/tmp(?=$\|[/\s'"`;\|&)<>},]) ``; ignora `/tmp/.X11-unix` e `/tmp/.ICE-unix`, testados sobre o token **normalizado** (`/tmp/.X11-unix/../x` acerta, `/tmp//.X11-unix` não) |
| Detector (arquivo) | caminho que resolve para `/tmp` ou para algo sob `/tmp/` (mesmos prefixos permitidos) |
| Ids | sanitizados para `^[A-Za-z0-9._-]+$`; `.`/`..` e ponto inicial rejeitados |
| Apagar | nunca fora de `<host-tmp>/agent-scratch/`; nunca seguindo symlink |

Acertam: `> /tmp/a`, `2>/tmp/e`, `mkdir -p /tmp/t2`, `cp x /tmp/`, `cd /tmp && ls`, `"/tmp/x"`, `--out=/tmp/o`, `tee /tmp/log`.
Não acertam: `/var/tmp/x`, `$TMPDIR/tmp/x`, `./tmp`, `~/tmp`, `/home/u/tmp`, `/tmpfoo`, `ls /tmp/.X11-unix`, `${TMPDIR:-/tmp}` e qualquer comando com `allow-literal-tmp`.

A paridade com o hook Python da skill é testada caso a caso (`test/parity.test.js`: ~3 000 comandos, caminhos de arquivo e a raiz do host). Única diferença conhecida, inofensiva: o `\s` do Python inclui `\x1c`–`\x1f`/`\x85` e o do JS inclui `\ufeff`; nenhum deles separa palavras no bash.

### Limites conhecidos do contrato (os dois lados iguais; mudar exige emenda nos dois)

- **Falsos negativos** (passam sem deny): `-v /tmp:/data` e `export PATH=/tmp:$PATH` (`:` não está no lookahead), `ls -d /tmp*`, `rm -f /tmp*.log`, `cp x /tmp$SUFFIX`, `cp x /tmp${SUFFIX}`, `cd /tmp\ dir` (`*`, `$`, `\` também não), `curl file:///tmp/x` e `sed 's#/tmp#…#'` (`/` e `#` não abrem acerto), `/private/tmp/x` (macOS).
- **Falsos positivos** (negados embora não gravem no `/tmp` local): `/tmp` só como texto ou padrão — `grep -rn "/tmp" src/`, `git log -S'/tmp'`, `sed -i 's|/tmp|$TMPDIR|g' run.sh`, mensagens de commit/PR, heredocs de documentação —, exclusões (`find / -path /tmp -prune`, `rsync --exclude=/tmp`) e caminhos remotos/de contêiner (`ssh host 'ls /tmp'`, `scp f host:/tmp/`, `docker exec web ls /tmp`, `kubectl exec … cat /tmp/x`, `docker run -v "$TMPDIR/out":/tmp/out`). Pelo contrato o marcador só vale com pedido explícito do usuário, então nesses casos o modelo tem de pedir. Emenda sugerida (JS + Python juntos): permitir o marcador também quando `/tmp` aparece só como texto ou é caminho remoto/de contêiner.
- **`TMPDIR` é um symlink** quando o apelido está em uso (os dois lados: `agent-scratch/dsh/.s/<hash8>` e `agent-scratch/claude/.s/<hash8>`). Ferramentas que recebem `"$TMPDIR"` como ponto de partida agem sobre o **link**, não sobre a pasta: `find "$TMPDIR" -name '*.png'` não acha nada, `du -sh "$TMPDIR"` mede o link, `tar -cf x.tar "$TMPDIR"`, `cp -r "$TMPDIR" dst` e `rsync -a "$TMPDIR" dst` copiam só o link relativo `../<id>` (pendurado no destino) e `ls -l "$TMPDIR"` mostra o link. Com a **barra no fim** (`"$TMPDIR/"`) todos descem na pasta; `cd "$TMPDIR"`, `ls "$TMPDIR"`, `mktemp`, `"$TMPDIR/x"` e afins funcionam normalmente. Até a 0.1.1 o `TMPDIR` era a pasta real e esses idiomas funcionavam. A regra do prompt (nos dois lados) avisa disso; `pwd -P`/`realpath` dão o caminho canônico longo (81 bytes aqui).
- **Workspace sob `/tmp`** (`git clone … /tmp/x && cd /tmp/x && dsh`): todo `write`/`edit` no workspace acerta (o caminho resolve para `/tmp/…`), assim como um `workdir` relativo; comandos de bash com caminho relativo não acertam. O motivo do deny diz para gravar pelo bash com caminho relativo nesse caso. Emenda sugerida: isentar o workspace da sessão quando ele mesmo está sob `/tmp`.

## Instalação

### Rota recomendada: patch de HOME (vale para web, headless e dwg-share)

```bash
cd /home/ondokai/Projects/dsh-session-scratch
node --test test/*.test.js                                  # 335 testes
node scripts/install-home-patch.mjs --dry-run               # mostra o ~/.dsh/cordis.patch.yml resultante
node scripts/install-home-patch.mjs --verify --dsh ~/.local/bin/dsh --profiles web,headless,dwg-share
node scripts/install-home-patch.mjs --check                 # 0 = bloco presente e atualizado
```

O instalador edita `~/.dsh/cordis.patch.yml` como texto, num bloco delimitado por marcadores, com **backup** antes de escrever. Um `[]` existente é substituído; uma lista em estilo bloco recebe o bloco no fim; outra forma (ou uma linha `session-scratch` fora do bloco) é recusada. O bloco reafirma a config **inteira** (a linha do Loader é whole-entry replace).

Um `dsh web` **já no ar** carrega o plugin na hora: o `dsh-hmr` (ativo por padrão em profile) observa o `~/.dsh/cordis.patch.yml` — inclusive a criação dele — e reconcilia o patch sem reiniciar. As sessões abertas passam a ter o TMPDIR da sessão a partir do próximo bash (o valor muda no meio da sessão; o plugin cria pasta e apelido sob demanda). Para trocar só numa janela controlada, pare o `dsh web` antes de instalar e suba de novo depois (as sessões abertas retomam). Conferência rápida:

```bash
dsh --profile web --dump-config | grep -n -A16 'id: session-scratch'
```

Numa sessão (nova ou já aberta): `echo "$TMPDIR" ${#TMPDIR}; readlink "$TMPDIR"; readlink -f "$TMPDIR"; mktemp` mostra o apelido `/var/tmp/user-1000/agent-scratch/dsh/.s/<hash8>` (48 bytes), que resolve para `/var/tmp/user-1000/agent-scratch/dsh/<id>`, e um `mktemp` sob ele; `echo oi > /tmp/x` é negado com o motivo em pt-BR.

### Alternativa: bundle por profile (nunca as duas rotas)

```bash
dsh plugin --profile web add link:/home/ondokai/Projects/dsh-session-scratch
```

O `package.json` declara `dsh.bundle.patch` → `cordis.patch.yml` (mesma id `session-scratch`). As duas rotas juntas fazem o Loader colapsar a id repetida em silêncio (vence a camada mais alta); o instalador avisa se detectar isso.

### Desinstalar

```bash
node scripts/install-home-patch.mjs --uninstall --verify --dsh ~/.local/bin/dsh   # deixa `[]` se nada sobrar
# reinicie o dsh web; depois, se quiser: rm -rf /var/tmp/user-1000/agent-scratch/dsh
```

## Configuração

| Chave | Default | O que faz |
|---|---|---|
| `baseDir` | `agent-scratch/dsh` | raiz das pastas, **relativa à raiz temporária do host**; só `agent-scratch/dsh` ou uma árvore irmã `agent-scratch/dsh-<x>` (a varredura trata pasta sem marcador DSH como órfã: `agent-scratch/claude` ou `agent-scratch/dsh/x` apagariam sessões alheias) |
| `exportTmpdir` | `true` | instala o hook `BASH_ENV` que exporta TMPDIR/TMP/TEMP |
| `promptRule` | `true` | seção global `session-scratch:tmp-rule` (ordem `TOOL_BASH + 5`, `interpolate: false`) |
| `guard` | `deny` | `deny` nega no `tools/pre-execute`; `warn` anexa aviso no `tools/post-execute`; `off` desliga |
| `guardTools` | `[bash]` | ferramentas de shell: inspeciona `arguments.command` e `arguments.workdir` |
| `fileTools` | `[write, edit]` | ferramentas de arquivo: inspeciona `arguments.file_path` (ou `path`, ex.: `str_replace_editor`) |
| `escapeMarker` | `allow-literal-tmp` | texto que libera `/tmp` num comando |
| `allowPrefixes` | `[/tmp/.X11-unix, /tmp/.ICE-unix]` | prefixos sob `/tmp` que nunca contam (sem `//`, `.` ou `..`) |
| `shareWithSubagents` | `true` | subagentes (`origin: subagent`) usam a pasta da sessão raiz |
| `idleDays` | `3` | pasta própria sem atividade há mais que isso é apagada (sessões web nunca "terminam") |
| `orphanGraceMinutes` | `30` | pasta de dono morto mais nova que isso fica (corrida de resume/takeover) |
| `sweepIntervalMinutes` | `30` | intervalo da varredura (também roda no arranque) |

Valor inválido ou chave desconhecida lança em `apply()`: a fibra fica FAILED, o DSH registra um aviso e segue **sem** o plugin.

## Como funciona

```
tools/pre-execute ──► guarda (/tmp literal? → deny com motivo pt-BR) + toque de atividade
        │ allow
        ▼
tool-bash ──► ctx.shellEnv.collect(exec) ──► resolve() deste plugin
        │        DSH_SCRATCH_CANONICAL_DIR=<host-tmp>/agent-scratch/dsh/<id>  (cria 0700 + marcador .owners/<id>.json)
        │        DSH_SCRATCH_DIR=<host-tmp>/agent-scratch/dsh/.s/<hash8>       (apelido → ../<id>; ou a canônica, se curta)
        │        DSH_SCRATCH_HOST_TMPDIR=<host-tmp>
        ▼
subprocess (scrubbedParentEnv relê process.env: BASH_ENV=hooks/bash-env.sh) ──► bash -c "<comando>"
        │
        └─ bash lê $BASH_ENV antes do comando: TMPDIR/TMP/TEMP = DSH_SCRATCH_DIR, TMPPREFIX = DSH_SCRATCH_DIR/zsh
           (só se TMPDIR vazio ou igual ao default do host → override explícito e bash aninhado preservados;
            o apelido só vale se resolve para a MESMA pasta, `-ef`; senão vai a canônica)
```

### Apelido curto (sockets AF_UNIX)

`sun_path` aceita 107 bytes. O Chromium (google-chrome-stable e o Chrome for Testing do Playwright) cria `TMPDIR/<org.chromium.Chromium|com.google.Chrome>.XXXXXX/SingletonSocket` (TMPDIR + ~46 bytes) e o `multiprocessing` do Python 3.14 (`forkserver`, o padrão) `TMPDIR/pymp-XXXXXXXX/listener-XXXXXXXX` (+32). A pasta canônica de uma sessão (`session-<uuid>`) tem 81 bytes aqui: o Chromium morria com `FATAL … Socket path too long` e o Python caía em silêncio para o `/tmp` literal (`/tmp/pymp-*`; de 76 a 79 bytes ele falha com `OSError: AF_UNIX path too long`). O TMPDIR exportado é então o symlink `<base>/.s/<hash8>` → `../<id>` (48 bytes aqui); os arquivos continuam na pasta canônica, onde o contrato, a varredura e a limpeza os procuram.

- **Nome**: `sha256(id)[:8]` (o mesmo da skill); só quando a canônica passa de 60 bytes e o apelido é mais curto.
- **Colisão**: um nome ocupado por outra coisa (apelido de outra sessão, mesmo pendurado; arquivo; pasta) **nunca é reapontado**: o plugin tenta 10, 12, 14 e 16 hex; esgotados, exporta o caminho canônico (funciona, sem a folga para sockets). Um apelido da sessão que já exista (de qualquer tamanho) é reaproveitado antes de criar outro.
- **Corrida**: publicação atômica e sem substituição — symlink temporário `.s/.tmp-<pid>-<hex>` + `link(2)` para o nome final (EEXIST se alguém chegou antes; um `rename(2)` substituiria em silêncio o apelido de outra sessão e o Node não expõe `RENAME_NOREPLACE`). Onde `link` de symlink não existe (EPERM/ENOTSUP…), `symlink(2)` direto no nome final, também atômico. O teste dispara 18 processos reais, 3 sessões forçadas ao mesmo hash: um apelido por sessão, cada um para a sua pasta, nenhum `.tmp-*` sobrando.
- **Verificação**: um apelido é "da sessão" só se é symlink do euid com o texto exato `../<id>` dentro de um `.s` real do euid (léxico, sem seguir o link); o plugin confere a cada chamada de bash (inclusive o apelido em cache: `.s` trocado por symlink o invalida) e o recria se sumiu. O hook ainda confere `[ "$DSH_SCRATCH_DIR" -ef "$DSH_SCRATCH_CANONICAL_DIR" ]` antes de exportar.
- **`.s` fixado na criação**: a identidade (dev/ino) do `.s` real é fixada no início e reconferida antes de cada candidato e depois de cada publicação; trocado no meio (por symlink ou por outra pasta), o apelido não é usado (o hook exporta a canônica). Sem `openat`/`linkat` no Node, sobra a janela de microssegundos entre a conferência e a syscall (mesma classe das conferências da base e do `.owners`).
- **Remoção refeita na hora**: antes de cada `unlink` de apelido (saída, remoção, varredura) a decisão é lida de novo, de forma **síncrona** e sem `await` no meio: `.s` real do euid, mesmo link (inode) com o texto `../<id>`, pasta canônica **ausente** e, na varredura, dono do marcador não vivo e nenhum partilhador vivo. Se a sessão for retomada por outro processo na janela final (a pasta reaparece logo depois do `unlink`), o apelido é **republicado** na hora.
- **Sem apelido possível** (todos os nomes ocupados, `.s` não confiável): o TMPDIR fica no caminho canônico; o plugin tenta de novo no máximo a cada 60 s e só registra no log a **transição** (perdeu / recuperou o apelido), nunca a cada chamada de bash.
- **`DSH_SCRATCH_DIR`** é o caminho que o plugin publica para a sessão (o apelido, ou a canônica se ela já é curta). Sempre que o hook troca o TMPDIR ele reafirma `DSH_SCRATCH_DIR` = TMPDIR — inclusive `/tmp` no fallback do sandbox `workspace-write`. Quando o hook **não** troca o TMPDIR (override explícito, bash aninhado, pasta da sessão inutilizável com o tmp do host gravável, sandbox `read-only`), `DSH_SCRATCH_DIR` fica como o plugin publicou e pode diferir do TMPDIR. A pasta real fica em **`DSH_SCRATCH_CANONICAL_DIR`** (é dela que o hook recria a folha).
- **Chrome for Testing** (`~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`) com `--dump-dom`: só termina com `--disable-field-trial-config` (o Playwright sempre passa esse flag); sem ele a config de field trials de teste embutida o deixa pendurado com **qualquer** TMPDIR — não tem relação com este plugin.

- O `BASH_ENV` é posto em `process.env` por um `ctx.effect` e restaurado no disposer (um `BASH_ENV` anterior é encadeado via `SESSION_SCRATCH_PREV_BASH_ENV`). Não dá para pô-lo num `.env`: é nome de bootstrap.
- `DSH_SCRATCH_HOST_TMPDIR` é o TMPDIR **cru** do processo do DSH (o que o bash herda), mesmo quando a raiz do host foi "desaninhada": é com ele que o hook distingue default herdado de override explícito.
- O hook recria só a **folha** (a pasta canônica da sessão) se ela sumiu — o apelido volta a valer na hora; a base e o `.s` são sempre do plugin, criados junto com o `.owners` que identifica a base de scratch. O hook nunca cria, troca nem apaga apelidos.
- No sandbox `workspace-write` (bwrap) `/var/tmp` é read-only e `/tmp` é um tmpfs privado **por comando**: o hook sonda a escrita e, se a pasta e o TMPDIR do host não são graváveis, usa `/tmp` (o privado) — nada ali persiste entre chamadas, e a regra do prompt diz isso ao modelo (write/edit vão para o workspace). Com `danger-full-access` (o default desta máquina) a pasta da sessão é usada.
- DSH sem `TMPDIR` (`os.tmpdir()` = `/tmp`): a árvore fica em `/tmp/agent-scratch/`, que então é **isenta** para `write`/`edit`/`workdir` (senão o remédio do deny — "use o caminho de `echo "$TMPDIR"`" — seria negado de novo). Mesma isenção do `_scratch_exempt` da skill; comandos de shell continuam sem isenção (lá o modelo usa `"$TMPDIR"`).
- Motivos do deny por tipo: comando (`shell`), `workdir` (o `workdir` não expande variáveis: o motivo manda omiti-lo e fazer `cd "$TMPDIR" && …` no comando) e arquivo. O marcador de escape vai **sozinho na primeira linha** do comando: no fim, colado ao terminador de um heredoc (`EOF # allow-literal-tmp`), ele quebraria o heredoc em silêncio.
- `resolve()` nunca lança (um throw falharia a chamada de bash); `agent/created` também não (falharia a criação do agente). Toda promise tem `.catch` (uma rejeição solta derruba o DSH).
- O detector roda síncrono no host a cada chamada de bash e é **linear** no tamanho do comando (um comando de 230 KB com milhares de `/tmp` num só token leva milissegundos).

## Quando a pasta some

| Situação | Mecanismo |
|---|---|
| Headless termina normalmente | listener de `exit` do processo: renomeia para `.trash-*` as pastas cujo marcador é deste processo e as apaga com orçamento de **1 s** conferido antes de cada operação de disco (uma árvore enorme não segura a saída; o resto fica como lixeira) |
| `dsh web` com Ctrl-C / `kill -TERM` | o listener de SIGTERM/SIGINT marca o shutdown; o disposer **renomeia** as pastas para `.trash-*` (O(1), dentro do teto de 5 s do DSH) e o `exit` apaga como acima |
| Sessão ACP fechada, subagente, reload do SessionController no web (reconcile de plugins, HMR, troca de serviço) | `agent/disposed` **não** apaga: no web ele dispara com a sessão ainda viva (retomada sob demanda) e apagar perderia o rascunho no meio da sessão. A pasta segue deste processo e sai pela saída do processo ou por `idleDays` |
| Sessão ociosa (`idleDays`) | varredura: dono = este processo, última atividade (mtime do marcador/pasta) mais velha que `idleDays` e **nenhum processo vivo usando a pasta** (ver "Em uso" abaixo) |
| Crash / SIGKILL / reboot | nada roda; a varredura de **outro** processo apaga quando o dono morreu (pid inexistente, starttime diferente ou boot_id diferente), passou `orphanGraceMinutes` e **nenhum processo vivo usa a pasta** — um Chromium ou servidor de dev que sobreviveu ao DSH, com o cwd lá dentro ou o `TMPDIR` = apelido, segura a pasta até terminar (`kept: in-use`); lixeiras `.trash-<pid>-*` de pid morto (ou que sobraram do orçamento da saída) saem na próxima varredura, salvo se em uso; as de outro processo **vivo** só depois da carência |
| Sessão **partilhada** por dois processos do DSH vivos (a mesma sessão aberta no web e num headless, por exemplo) | quem usa a chave sem ser o dono registra `.owners/<id>@<pid>.share` (mesmo formato do marcador) no primeiro bash. Quando o **dono** sai, se há partilhador vivo o marcador passa para ele: a pasta, os arquivos e o apelido **ficam**, e ele os apaga quando sair. Quando o partilhador sai, só o registro dele some. A varredura mantém (`live-sharer`) a pasta de dono morto com partilhador vivo e apaga registros `.share` de pid morto |
| HMR / mudança de config do plugin | **nada** é apagado (o processo segue vivo e dono das pastas) |
| Apelido `.s/<hash>` | sai junto com a pasta em todos os caminhos acima (desligado só depois que a pasta canônica saiu do lugar, e só se ainda é o `../<id>` desta sessão; decisão refeita de forma síncrona logo antes do `unlink`, com republicação se a sessão for retomada nesse instante). Pendurado por outro motivo (pasta apagada à mão, processo morto antes de desligá-lo): a varredura o desliga quando a pasta não existe, o dono do marcador não está vivo, nenhum partilhador vivo nem processo vivo o referencia e passou `orphanGraceMinutes`; restos `.tmp-*` de uma publicação interrompida também. Fica: apelido de dono vivo (o hook recria a pasta e ele volta a valer), apelido de pasta presente, apelido em uso, link de alvo alheio |
| A base ou o `.owners` somem com o DSH no ar (`rm -rf` manual; ou um tmpfiles com idade 3d num `/var/tmp` `noatime` sem a exclusão `x` do `.owners` que a regra da skill traz) | o próximo bash ou a próxima varredura recria a cadeia, com as mesmas verificações; o TMPDIR privado nunca cai em silêncio para o tmp compartilhado |

### Segurança da remoção

- Só dentro de `<host-tmp>/agent-scratch/`, e só depois de revalidar a cadeia `agent-scratch → base → .owners` (diretórios reais do euid, sem symlink) e a identidade (dev/ino) da base. Uma base trocada por symlink aborta tudo; trocada por outra pasta real só é adotada se for uma base de scratch (tem `.owners` real) — senão nada é criado nem apagado nela.
- Nunca segue symlink (links são desligados; só diretórios reais vistos por `lstat` são percorridos). Apelidos são desligados com `unlink` do próprio link — nunca seguidos nem usados como caminho de remoção —, depois de revalidar a cadeia, que `.s` é diretório real do euid e que o link (mesmo inode, mesmo texto) não mudou.
- **Em uso não se apaga** (paridade com o `in_use` da skill): antes de apagar uma pasta órfã ou ociosa, uma lixeira ou um apelido pendurado, a varredura lê do `/proc` — uma vez por passada e só se houver o que apagar (~80 ms aqui, assíncrono) — o cwd, os fds abertos e `TMPDIR`/`TMP`/`TEMP`/`TMPPREFIX` de cada processo do euid, e mantém o que for referenciado pela pasta canônica ou por **qualquer** nome de apelido dela (o environ de um sobrevivente traz `.s/<hash>`, o cwd traz o caminho real).
- Nunca cruza ponto de montagem: uma pasta com montagem dentro (sshfs/rclone/bind de `mktemp -d`, `.mount_*` de AppImage) não é renomeada nem apagada (fica registrada no log até ser desmontada); na caminhada, não desce em outro `st_dev` nem, no Linux, em outro `mnt_id` (bind mount do mesmo sistema de arquivos).
- Subpastas read-only **reais** do usuário (cache 0555 do Go, tarball 0500) são destravadas (u+rwx) pelo fd `O_PATH|O_NOFOLLOW`, nunca através de um symlink.

Rede de segurança fora do DSH (da skill): `~/.config/user-tmpfiles.d/agent-scratch.conf` + `systemd-tmpfiles-clean.timer`. Ela apaga por idade (3 dias) o conteúdo das duas árvores, mas deixa fora da idade (`x %T/agent-scratch/dsh*/.owners` e `x %T/agent-scratch/dsh*/.s`) os marcadores e os apelidos deste plugin: sem a primeira, o marcador de um processo vivo com a sessão 3 dias sem bash sumiria e a varredura de outro DSH trataria a pasta como órfã; sem a segunda, o apelido de uma sessão viva com mais de 3 dias sumiria (`/var/tmp` é `noatime`: seguir o link nunca renova a idade dele) — o plugin o recriaria no próximo bash, mas comandos já rodando com o TMPDIR antigo perderiam o caminho.

## Cobertura e lacunas

- **Coberto**: a ferramenta `bash` one-shot (foreground e background) nos presets standard, ptc e cordis, com e sem sandbox (no `workspace-write` o TMPDIR — e o `DSH_SCRATCH_DIR` — é o `/tmp` privado do bwrap, como antes; o apelido não entra. No `read-only` nada é gravável, nem esse `/tmp`: o hook não muda nada e o `mktemp` falha igual sem o plugin — cenário e2e `sandbox-readonly`); chamadas de bash do PTC (`run_code` sub-dispatch passa pelo mesmo pipeline); subagentes in-process (partilham a pasta da raiz); sessões retomadas (pasta recriada sob demanda).
- **Não coberto**:
  - o bash **persistente/PTY** (preset `minimal`, `@deepseek-ai/dsh-tool-bash-persistent`): shell interativo com `--norc`, sem shellEnv, logo sem TMPDIR por sessão. A guarda vale (a ferramenta também se chama `bash` e tem `command`), mas o preset `minimal` usa persona `complete: true`, que **descarta** a seção do prompt;
  - as ferramentas `terminal_open`/`terminal_send` (`@deepseek-ai/dsh-tool-terminal`, que nenhum preset padrão carrega): **sem** guarda — `terminal_send` leva o texto em `text` e `terminal_open` o diretório em `cwd`, campos que a guarda não lê;
  - uso direto de fs dentro do `run_code`;
  - subagentes ACP externos (claude-code, codex) e o DSH via SDK em outro processo: herdam só o TMPDIR do host (a skill/hook deles cuida);
  - hooks, MCP, LSP e git do próprio DSH (de propósito);
  - reescrever comandos é impossível (argumentos congelados, sem decisão `rewrite`): a guarda só nega ou avisa;
  - a saída do processo do DSH (exit/SIGTERM) não espera sobreviventes como o `SessionEnd` da skill espera: um servidor de dev largado com `&` perde a pasta quando o DSH sai. O `/proc` é consultado só pela varredura (pastas de dono morto ou ociosas), não na saída;
  - a primeira partilha de uma chave corre contra a saída do dono: se o dono sai no mesmo instante em que o outro processo grava o registro `.share` pela primeira vez, a pasta pode sair (o partilhador a recria no próximo bash, vazia).
- Peculiaridade do bash: com stdin **socket** e sem `SHLVL`, o bash lê `~/.bashrc` em vez do `BASH_ENV` (heurística de rshd/sshd). O DSH usa `/dev/null` como stdin da ferramenta bash, então não afeta; os testes reproduzem isso.

## Diagnóstico

Com `SESSION_SCRATCH_TRACE=/caminho/trace.jsonl` no ambiente do DSH, cada evento do ciclo de vida (apply, agent/created, guard/deny, sweep, signal, shutdown-detach, exit-cleanup…) vira uma linha JSON. Desligado por padrão.

## Testes

```bash
node --test test/*.test.js     # unitários + bash real do hook + paridade com o hook Python + montagens reais (unshare -Urm) + instalador
node scripts/e2e/run-e2e.mjs   # e2e contra o DSH instalado com o mock LLM scriptado do próprio repo do DSH
npm run typecheck              # tsc --checkJs strict usando o TypeScript do repo do DSH
```

O e2e usa `@deepseek-ai/dsh-llm-mock-server` (packages/test-support) como provider determinístico, um `DSH_HOME` temporário e o plugin por um overlay `--patch` temporário — nada em `~/.dsh` é tocado. Cenários (13): TMPDIR da sessão = apelido que resolve para a canônica (+ TMPPREFIX, `DSH_SCRATCH_CANONICAL_DIR`, `find "$TMPDIR"` vs `find "$TMPDIR/"`, regra no system prompt capturada na request ao provider, varredura de órfão com o apelido pendurado dele), deny de bash e de write, marcador de escape (na primeira linha), `dsh` lançado com o TMPDIR de uma sessão-mãe (sem aninhar), sandbox `workspace-write` (`DSH_SCRATCH_DIR` = TMPDIR = `/tmp` gravável) e `read-only` (nada gravável: o hook não muda nada, `mktemp` falha igual ao controle sem o plugin), SIGTERM e SIGKILL + varredura de órfão (com a pasta de um processo vivo preservada; pasta, marcador e apelido somem), e os de sockets AF_UNIX: `tmpdir-length` (TMPDIR ≤ 60 bytes; 48 aqui), `chrome` (`google-chrome-stable --headless=new … --user-data-dir="$(mktemp -d)" --dump-dom 'data:text/html,<p>ok</p>'` imprime `<p>ok</p>`), `chromium-playwright` (o mesmo com o Chrome for Testing de `~/.cache/ms-playwright`, + `--disable-field-trial-config`) e `forkserver` (`multiprocessing` `Pool(2)` com o socket dentro do TMPDIR). Os três últimos rodam também um CONTROLE com `TMPDIR` = caminho canônico: o Chromium ainda morre com `Socket path too long` e o Python ainda foge para `/tmp/pymp-*` — a prova de que é o apelido que conserta.

`test/alias.test.js` cobre o apelido isolado (esquema, colisão, corrida entre processos reais, queda para `symlink(2)`, `.s` trocado por symlink antes, no meio do laço e depois da publicação, remoção só do link, retomada antes do laço e na janela final com republicação) e integrado ao store (remove, takeover, saída do processo, apelido em cache com `.s` trocado, back-off sem log repetido) e a sessão partilhada (registro `.share`, passagem do marcador, partilhador morto, e dois processos REAIS: o dono sai e os arquivos e o apelido do outro ficam); `test/sweep.test.js` a varredura de apelidos (inclusive retomada no último `await`), pastas em uso por sobreviventes reais (`sleep` com cwd pelo apelido e com `TMPDIR` = apelido) e registros `.share`; `test/inuse.test.js` a leitura do `/proc`; `test/bash-env.test.js` o hook com apelido válido, pendurado, alheio e ausente, o fallback do sandbox (`DSH_SCRATCH_DIR` = TMPDIR), o `forkserver` real e os here-docs do zsh.

`test/remove.test.js` monta bind mounts e tmpfs **de verdade** dentro de um namespace de usuário+montagem sem privilégio (`unshare --user --map-root-user --mount`; pulado se indisponível) e prova que a saída do processo, a varredura e o `remove()` não apagam nada do outro lado. `test/parity.test.js` roda o mesmo corpus no hook Python da skill (pulado se ele ou o `python3` faltarem; `DSS_TMPDIR_HOOK` muda o caminho).

## Licença

MIT — ver [LICENSE](LICENSE).
