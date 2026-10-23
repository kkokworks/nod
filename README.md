# nod

여러 Claude Code 세션을 동시에 돌려 일을 처리하고, 사람에게는 결정만 넘기는 오케스트레이터입니다. 사람은 고개만 끄덕이면(nod) 됩니다.

작업마다 tmux 안에 실제 Claude Code 세션을 띄웁니다. 질문·검증 실패·후속 지시가 모두 같은 세션에 들어가서 워커가 맥락을 유지하고, 언제든 `nod attach` 로 들어가 볼 수 있습니다.

## 설치

[Bun](https://bun.sh), [tmux](https://github.com/tmux/tmux), 로그인된 [Claude Code](https://claude.com/claude-code) CLI 가 필요합니다.

```sh
git clone https://github.com/kkokworks/nod && cd nod
bun install
bun link                                       # nod 명령 등록
ln -s "$PWD/skills/nod" ~/.claude/skills/nod   # Claude 세션에서 /nod
ln -s "$PWD/skills/gtd" ~/.claude/skills/gtd   # 할 일 장부로 GTD: /gtd:capture, /gtd:review 등
ln -s "$PWD/skills/wide-research" ~/.claude/skills/wide-research   # 선택: 항목 여러 개 비교 조사
ln -s "$PWD/agents/wide-item.md" ~/.claude/agents/wide-item.md     # wide-research 가 쓰는 에이전트
```

## 쓰기

Claude 세션에서 `/nod` 를 부르거나 "이 일들 nod 에 맡겨줘" 라고 말합니다. 세션이 일을 작업으로 나눠 맡기고, 결정이 생기면 바로 전해 줍니다.

터미널에서 직접 쓸 수도 있습니다.

```sh
nod add '로그인 버그 고치기' --repo ~/code/app --branch fix/login --check 'bun test'   # 워커가 바로 시작
nod add '로그인 화면 문구 정리' --repo ~/code/app --branch fix/login-copy --after 1    # 작업 1이 끝나면 그 브랜치에서 이어서
nod add '결제 오류 원인 조사' --issue PROJ-12                      # 이슈에 딸린 작업
nod                  # 결정할 것
nod watch --mine     # 이 Claude 세션이 맡긴 작업의 결정만 열리는 대로 (루트 세션을 여럿 둘 때)
nod watch --issue PROJ-12,PROJ-13   # 이 이슈들의 결정만 열리는 대로
nod 3 '그렇게 해'     # 결정 3에 답하기 (같은 세션에 들어감)
nod tell 1 '테스트도 추가해 줘'   # 작업 1의 세션에 후속 지시
nod attach 1         # 작업 1의 화면 열기
nod ls               # 작업 상태 (이슈가 있는 작업은 이슈별로 묶어서)
nod link 1 https://example.com/org/app/pulls/7   # 작업 1의 결과가 간 곳(PR 등)
nod gc 1             # 작업 1을 다 처리함: 세션·worktree 와 머지된 브랜치를 지우고 ls 에서 뺌 (ls --all 엔 남음)
nod gc               # 완료 신호가 온 작업을 정리 (승인한 리뷰, 머지·닫힌 PR, 그만둔 작업, 7일 지난 작업 등)
nod resume 1         # 정리한 작업도 되살림: 같은 경로에 worktree 를 다시 만들고 대화 기록으로 이어 감
```

레포 작업의 worktree 는 `~/.nod/work/<레포 폴더 이름>/<브랜치>` 에 생깁니다(위 예는 `~/.nod/work/app/fix/login`). 폴더와 브랜치 이름만 봐도 무슨 일인지 알 수 있습니다.

작업이 `succeeded` 가 돼도 결과를 push·PR 로 내보내는 일은 따로 남습니다. 내보낸 뒤 `nod link` 로 주소를 남기면, `nod ls` 에서 링크가 없는 작업이 곧 아직 내보내지 않은 결과입니다. 머지까지 끝나면 `nod gc` 로 정리합니다. 이름 없이 부른 `nod gc` 와, 스케줄을 켰을 때 5분마다 도는 tick 은 완료 신호를 보고 스스로 정리합니다. 남의 PR 리뷰는 내가 승인했을 때, 내 PR 은 머지·닫혔을 때입니다. PR 상태는 `gh`(GitHub)·`tea`(Gitea·Forgejo)로 읽습니다. 레포 없는 작업은 끝난 지 7일이 지나야(회고 작업은 끝나면 바로), push 하지 않은 커밋이 있는 작업은 push 한 뒤에야 정리합니다. 어떤 `nod gc` 든 사람이 `nod attach` 로 붙어 있는 작업과, worktree 에만 있는 커밋(분리된 HEAD 에서 만든 커밋, worktree 의 서브모듈에만 있는 커밋·stash)이 있는 작업은 건너뛰고 이유를 보여 줍니다. 정리한 작업도 대화 기록은 남아서 `nod resume`·`nod tell` 로 되살릴 수 있습니다.

`--issue` 로 이슈를 주면 `nod ls` 는 그 작업을 이슈 아래에 묶어 보여 주고, 결정 목록과 알림에도 이슈가 붙습니다. 한 이슈를 여러 작업으로 나눠도 같은 키를 주면 함께 보입니다.

Claude 세션에서 `nod add` 를 하면 작업에 그 세션(루트 세션)의 ID 가 남습니다. `nod show` 와 웹 화면의 작업 상세에 `root: <세션 ID>` 로 보이고, `claude --resume <세션 ID>` 로 그 세션을 다시 열 수 있습니다. 루트 세션은 `nod ls --mine`·`nod watch --mine` 으로 자기가 맡긴 작업만 보고 그 결정만 받습니다. 회고 작업은 돌아보는 작업의 루트 세션을 물려받습니다. 셸·트리거에서 맡긴 작업에는 루트 세션이 없고, Claude 세션 밖에서 `--mine` 을 쓰면 오류로 멈춥니다.

정해진 때나 새 항목마다 할 일은 트리거로 맡깁니다. `nod schedule on` 으로 한 번 켜 두면 OS 스케줄러(macOS launchd, Linux crontab)가 매분 `nod tick` 을 돌립니다. 켠 셸의 `PATH`·`CLAUDE_CONFIG_DIR` 와, 워커가 받는 변수 가운데 비밀이 아닌 것(계정이 들지 않은 프록시·언어·`TMUX_TMPDIR` 등, 아래 「워커가 끊기지 않게」)을 `<홈>/schedule.json` 에 남겨 그 환경으로 돌기 때문에, 워커가 쓸 Claude 설정이 있는 터미널에서 켭니다(`nod account` 로 계정 규칙을 정했으면 트리거 워커는 그 규칙의 계정으로 뜹니다). 이름에 `KEY`·`TOKEN`·`SECRET`·`PASSWORD`·`HEADER` 가 든 변수와, `http://user:pass@proxy:8080`·`user:pass@proxy:8080` 처럼 주소에 계정이 든 값은 파일에 남기지 않으니, API 키와 그런 프록시·`ANTHROPIC_BASE_URL` 은 Claude Code 설정의 `env` 에 둡니다. 부팅마다 바뀌는 `SSH_AUTH_SOCK` 도 남기지 않습니다. 스케줄러의 환경에 있으면 그 값을 워커가 받습니다. 트리거 워커가 스케줄러의 것과 다른, 경로가 바뀌지 않는 SSH 에이전트를 써야 하면(Linux crontab 의 환경에는 `SSH_AUTH_SOCK` 가 아예 없습니다) 그것도 Claude Code 설정의 `env` 에 둡니다. 웹 화면(`desktop/launchd/ui.sh`)도 같습니다. 예전 버전으로 켰다면 `nod schedule on`(웹 화면은 `ui.sh install`)을 다시 해야 파일에 남은 값이 지워집니다.

```sh
nod schedule on
nod trigger add '0 9 * * MON-FRI' '어제 머지된 PR 을 요약해 줘' --repo ~/code/app --branch pr-digest
nod trigger add '*/10 * * * *' '이 이슈의 원인을 조사해 줘' \
  --source "gh issue list --assignee @me --json number,title --jq '.[] | \"\(.number)\t\(.title)\"'"
nod trigger ls
```

source 가 탭으로 앞에 붙인 키(위에서는 이슈 번호)는 그 항목으로 생긴 작업의 이슈가 됩니다.

## 워커가 끊기지 않게

워커의 tmux 칸에서는 Claude Code 를 지켜보는 `nod run` 이 돕니다. Claude Code 가 끝나면(계정 전환, `/exit`, 충돌) nod 가 일부러 끈 것(gc·drop)이 아닌 한 **같은 칸에서 같은 대화**(세션 ID)로 다시 띄웁니다. 첫 지시는 다시 보내지 않습니다. 답하던 도중에 끝났으면 다시 띄운 뒤 결정(`interrupted`)으로 올려, 이어 갈지 사람이 정합니다. 그 차례의 일이 일부 됐을 수 있어서 저절로 다시 시키지 않습니다. 띄우자마자 세 번 거듭 끝나면(로그인이 없는 등) 다시 띄우기를 멈추고 마지막 화면과 함께 알립니다. 재부팅이나 tmux 종료로 칸까지 사라지면, 답하던 작업은 tick 이 결정으로 올리고 쉬던 작업은 다음 `nod tell` 때 다시 뜹니다.

워커는 nod 를 부른 셸의 환경 변수 가운데 정해 둔 것만 받습니다. 사용자(`HOME`·`USER`·`LOGNAME`, 로그인 키체인에 필요), `SHELL`·`TMPDIR`·`TZ`·`LANG`·`LC_*`, git·gh 설정 폴더(`XDG_*_HOME`), `SSH_AUTH_SOCK`, 프록시(`HTTP(S)_PROXY`·`NO_PROXY`·`ALL_PROXY`)와 인증서(`NODE_EXTRA_CA_CERTS`·`SSL_CERT_FILE`·`SSL_CERT_DIR`), `ANTHROPIC_*`, nod 의 tmux 소켓 폴더(`TMUX_TMPDIR`) 입니다. 터미널이나 에이전트 호스트가 칸마다 넣는 식별 변수는 넘기지 않습니다. tmux 서버가 그런 변수를 가진 채 떠 있어도 마찬가지입니다. 워커에 다른 변수가 필요하면 Claude Code 설정 폴더의 `settings.json` 에 `env` 로 둡니다. Bedrock·Vertex 처럼 셸 변수(`CLAUDE_CODE_USE_BEDROCK`·`AWS_*`·`CLOUD_ML_REGION` 등)로 고르는 설정도 여기로 옮겨야 워커가 로그인합니다.

계정을 바꾸는 도구를 쓴다면, 지금 계정(Claude 설정 폴더)을 nod 가 읽을 곳을 한 번 정해 둡니다. 정해 두면 워커·트리거 워커·다시 띄우는 워커가 모두 그때의 계정으로 뜹니다.

```sh
nod account                                   # 지금 규칙과 지금 계정 보기
nod account file ~/.config/switcher/current   # 파일에 적힌 경로 (앞뒤 공백 제거, 비어 있으면 Claude Code 기본 폴더)
nod account command 'switcher current'        # 명령이 출력한 경로 (명령은 따옴표로 묶어 인자 하나로)
nod account env                               # 기본: 워커를 띄우는 셸의 CLAUDE_CONFIG_DIR
nod restart                                   # 모든 워커의 Claude Code 를 같은 칸·같은 대화로 다시 띄우기
nod restart 3 t5                              # 이 작업들만
```

규칙이 파일이나 명령이면, nod 명령이 돌 때와 tick 이 매분 돌 때 워커가 뜬 계정(`nod show` 의 `account`)과 지금 계정을 비교합니다. 다르면 쉬는 워커는 Claude Code 만 끄고 칸 안에서 지금 계정으로 다시 띄우고, 답하는 중인 워커는 그 차례가 끝난 뒤 다시 띄웁니다. 사용량 한도 같은 API 오류로 멈춘 차례는 한도가 풀릴 때까지 끝나지 않으므로 기다리지 않고 바로 다시 띄워, 새 계정에서 이어서 하게 합니다. 계정이 바뀐 뒤 처음 보내는 `nod tell`·답은 다시 띄운 Claude Code 의 첫 메시지로 들어갑니다. 사람이 `nod attach` 로 붙어 있으면 끄지 않고 `<홈>/notify` 에 `restart_held` 로 한 번 알린 뒤, 사람이 나간 다음에 다시 띄웁니다. 바깥 도구가 계정을 바꾼 바로 그때 알리려면 `nod restart` 를 부르게 합니다. 기본 규칙(`env`)에서는 워커마다 자기를 띄운 셸의 계정이라 비교하지 않고, `nod restart` 만 다시 띄웁니다.

계정을 바꿔 가며 쓰려면 계정 폴더들이 대화 기록 폴더(`projects/`)를 함께 써야 합니다. 그래야 다른 계정으로 다시 띄운 Claude Code 가 같은 대화를 이어 갑니다. 대화가 옛 계정 폴더에만 있으면 nod 는 첫 지시를 다시 보내지 않고, 그 이유를 담아 다시 띄우기를 멈춥니다. 레포 작업을 다른 계정으로 다시 띄울 때 Claude Code 가 그 레포를 신뢰할지 다시 물으면, 이 작업이 이미 그 레포에서 돈 적이 있으므로(사람이 처음에 신뢰함) nod 가 그대로 받습니다. 명령 규칙은 부르는 곳마다 환경이 다르니(워커 훅, tick, 셸) 환경 변수에 기대지 않는 명령을 씁니다.

`~/.nod/notify` 실행 파일을 두면 결정이 열리거나 작업이 끝날 때 nod 가 JSON 을 stdin 으로 넘겨 부릅니다. JSON 의 `task` 에는 작업 번호·지시·이슈(`issue`, 없으면 `null`)가 들어 있어, 할 일 앱으로 보낼 때 이슈별로 묶을 수 있습니다. 10초 안에 끝나야 하며, 넘으면 그 스크립트가 띄운 프로세스까지 끝냅니다. 오래 걸리는 전송은 백그라운드로 넘기고(`curl … &`) 바로 끝내면, nod 는 0.5초 넘게 기다리지 않고 그 전송도 끝내지 않습니다. 알림이 실패하거나 아예 실행되지 않아도(실행 권한이나 `#!` 줄이 없음) nod 는 stderr 에 적기만 하고 하던 일을 계속합니다. 예를 들어 macOS 알림은 이렇게 받습니다.

```sh
#!/bin/sh
bun -e 'const e = await Bun.stdin.json(); const t = e.decision ? `결정 #${e.decision.id}` : e.event
Bun.spawnSync(["osascript", "-e", "on run a", "-e", "display notification (item 2 of a) with title (item 1 of a)", "-e", "end run", "nod", `${t}: ${e.task?.brief ?? e.error}`])'
```

레포 작업의 워커는 끝났다고 보고하기 전에, 지시와 그 뒤 사람이 한 말, 브랜치의 diff 만 받은 서브 에이전트에게 자기 변경을 리뷰받습니다. 서브 에이전트는 요청한 것이 정말 됐는지, 새 테스트가 고치기 전 코드에서 실패하는지, 변경이 새로 만든 정확성 버그가 있는지를 보고, 워커는 재현 시나리오가 있는 발견을 고친 뒤 발견과 처리를 보고에 적습니다. 브랜치의 시작 커밋은 nod 가 첫 메시지에 넣어 줍니다.

워커가 끝났다고 보고하면 nod 가 검증 명령을 돌리고, 레포 작업이면 커밋했는지 확인한 뒤, 워커의 대화를 모르는 리뷰어에게 결과를 한 번 더 보게 합니다. 리뷰어는 지시와 그 뒤 사람이 한 말을 기준으로, 요청한 일을 했는지, 테스트나 검증 명령을 약하게 고쳐 통과시키지 않았는지, 보고가 결과와 맞는지를 봅니다. 셋 중 하나라도 걸리면 그 내용이 같은 세션으로 돌아가 워커가 계속 고칩니다. 서브 에이전트는 워커가 띄우니 워커가 테스트를 약하게 고친 것까지 막지는 못하므로, 이 독립 리뷰가 마지막 관문으로 남습니다.

검증에 되돌려졌거나 실패한 작업은 끝난 뒤 회고 워커가 돌아보고, 앞으로의 워커가 받을 규칙 한 줄을 결정으로 제안합니다. 받아들인 규칙은 장부에 그 회고와 함께 쌓이고, 켜진 규칙이 모든 워커에게 전해집니다. 규칙은 명령으로 보고 고칩니다. 바꿀 때마다 누가 언제 바꿨는지 남습니다.

```sh
nod rule ls                       # 번호, 켜짐(on)·꺼짐(off), 만든 회고(r<n>), 규칙
nod rule add '커밋 전에 테스트를 돌린다'   # 직접 쓴 규칙 더하기
nod rule edit 2 '커밋 전에 bun test 를 돌린다'
nod rule off 2                    # 워커에게 그만 주기(지우기는 없음)
nod rule on 2
nod show r3                       # 회고 r3 과 그 회고가 넣은 규칙의 지금 상태(켜짐·꺼짐, 고쳐졌는지)
```

예전에 규칙을 두던 `~/.nod/rules.md` 는 장부를 처음 열 때 한 번 옮겨지고 `rules.md.imported` 로 이름이 바뀝니다. 그 뒤로 nod 는 이 파일을 읽지 않습니다.

사람이 할 일을 GTD 방식으로 적어 두는 장부도 있습니다. 떠오른 일은 `nod in` 으로 받은 일함에 넣고, 나중에 상태·프로젝트·상황을 정합니다.

```sh
nod in '치과에 예약 전화하기'              # 받은 일함에 넣기
nod project add 건강 --outcome '치료 끝내기'
nod todo set t1 --status next --project 건강 --context @전화   # 다음 행동으로 정리
nod in '견적서 회신 받기'
nod todo set t2 --status waiting --waiting-on 민수           # 기다리는 일
nod todo set t2 --watch 'test -f ~/Downloads/견적서.pdf'     # 생기면 다음 행동으로(5분마다 확인)
nod todo set t3 --status waiting --watch '<답이 오면 0 으로 끝나며 받은 내용을 출력하는 명령>' --back-to t3
                         # 통과하면 t3 을 맡았던 작업의 세션이 그 출력을 받아 이어서 처리
nod todo                 # 받은 일함·다음 행동·대기
nod todo next --context @전화
nod project              # 진행 중인 프로젝트와 다음 행동 수 (없으면 알려 줌)
nod project p1           # 한 프로젝트: 열린 할 일과 바뀐 이력
nod todo t1              # 한 개 보기: 메모·링크·누가 무엇을 바꿨는지
nod todo done t1
nod add --todo t3        # 할 일을 nod 작업에 맡기기 (지시를 빼면 제목·메모가 지시)
nod todo waiting         # 사람이나 작업을 기다리는 할 일
nod todo set t4 --due 2026-11-03 --on 'tomorrow 15:00'   # 마감과 예정(그날·그 시각에 할 일)
nod todo set t5 --start 2026-12-01                       # 그날까지 목록에서 숨기기
nod todo set t6 --due 'today 17:00' --repeat weekly      # 끝내면 다음 주 것이 생김
nod todo set t7 --focus today                            # 오늘 집중
nod today                # 오늘: 캘린더 일정, 지난 것, 예정, 마감, 집중
nod today tomorrow       # 내일 준비
```

`nod todo check` 는 장부를 믿어도 되는지 보여 줍니다. 받은 일함의 가장 오래된 날, 지난 것, 다음 행동이 없는 프로젝트, 오래 기록이 없는 대기, 마지막 주간 리뷰입니다. `nod todo --json` 은 할 일을 링크와 함께 JSON 한 줄씩 내보냅니다. 이 장부로 GTD 를 하는 절차(받아 적기·모으기·받은 일함 비우기·오늘 집중·내일 준비·주간 리뷰)는 gtd 스킬 묶음(`skills/gtd`, `/gtd:capture` 등)에 있고, 업무 도구 연결부는 `skills/gtd/sources/` 입니다. 켠 도구와 도구별 값은 `~/.nod/config.json` 에 둡니다.

`nod today` 의 일정은 macOS 캘린더 앱에서 읽기만 합니다. 처음 한 번 `sh calendar/build.sh` 로 읽기 앱을 `~/.nod` 에 빌드하고, 터미널에서 `nod today` 를 돌려 캘린더 권한을 허용합니다. 구글·iCloud 캘린더도 캘린더 앱에 계정을 붙이면 함께 읽힙니다.

맡긴 할 일은 작업을 기다리는 대기가 됩니다. 작업이 성공하면 끝나고, `nod drop` 으로 작업을 끝내면 다음 행동으로 돌아옵니다. 작업의 결과 한 줄과 링크는 `nod todo <할 일>` 에 나옵니다. 열린 결정은 `nod todo` 의 맨 위에 다음 행동으로 나오고, `nod <결정> <답>` 으로 답합니다.

할 일은 `t<번호>`, 프로젝트는 `p<번호>` 로 씁니다. 작업·결정의 번호와 섞이지 않게 맨 숫자는 받지 않습니다. 상황이 없는 할 일은 어디서나 할 수 있는 일로 보고 상황으로 거를 때도 보여 줍니다. 언젠가로 미룬 프로젝트의 할 일은 `--project` 나 `--all` 을 줄 때만 보입니다. 바뀐 내용은 누가 바꿨는지와 함께 남습니다. 터미널의 사람은 `human`, Claude 세션은 `claude:<세션>`, nod 워커는 `worker:<작업>` 이고, 맡긴 할 일을 작업에 따라 바꾼 것은 `nod` 입니다. `NOD_ACTOR` 를 주면 그 값을 씁니다.

브라우저로 보려면 `ui/` 의 화면 서버를 띄웁니다.

```sh
cd ui && bun install && bun run dev   # http://127.0.0.1:4800
```

첫 화면에는 열린 결정·작업·트리거·통계가, 작업 화면에는 시도 이력·결정·마지막 보고와 살아 있는 세션의 지금 화면이 나오고, 5초마다 새로 고칩니다. 워커 화면 아래 입력창은 `nod tell` 처럼 워커에게 말을 보내고, 결정이 열려 있으면 그 결정에 답합니다(`nod <결정> <답>`). 쓰는 동안 결정이 열리거나 닫히면 보내지 않고 알리고, 한 번 더 보내면 지금 열린 쪽으로 갑니다. 다른 작업 화면으로 옮기면 쓰던 글은 버려지고 그 작업으로 가지 않습니다. 권한·레포 신뢰·규칙 결정은 Yes/No 버튼으로만 답하고, 버튼으로 답해도 쓰던 글은 지워지지 않습니다. 열린 결정이 바뀐 직후 1초 동안은 버튼을 눌러도 답하지 않고 새 결정이 열렸다고 알립니다. 작업 끝내기(`drop`)와 정리(`gc`)는 CLI 에서 합니다. 워커의 보고와 화면이 보이고 워커에게 말을 보낼 수 있으므로 이 컴퓨터(127.0.0.1)에서만 엽니다. 같은 컴퓨터의 다른 페이지가 화면을 읽지 못하게 CORS 는 꺼 두고, 보고·질문 속 이미지는 불러오지 않고 링크로 보여 줍니다.

할 일 장부도 화면에서 씁니다. **Focus** 는 아침에 여는 화면으로, 손볼 것(`nod todo check` 가운데 0 이 아닌 것)과 오늘 일정 아래에 오늘 집중(별로 여섯 개까지 고르기)·오늘 것·다음 행동(상황별로 거르기)·시작 전인 것을 보여 주고, 맨 아래에 참고를 접어 둡니다. 손볼 것을 누르면 그것을 다루는 화면으로 갑니다. **Inbox** 는 받아 적기 입력창과 받은 일함을 보여 줍니다. 사이드바의 접히는 **Lists** 묶음에는 Mindwtr 처럼 **Projects**(프로젝트마다 열린 할 일과 다음 행동 수), **Someday/Maybe**, **Waiting For**, **Done** 이 있습니다. Done 은 끝낸 할 일·버린 할 일·정리한(gc) 작업을 최근 것부터 100개씩 보여 주고, 끝의 「Show more」로 100개씩 더 불러옵니다. 사이드바의 정리한 작업은 최근 20개만 보이고, 나머지는 Done 에서 찾습니다. 줄마다 동그라미로 끝내고 상태 메뉴로 옮기며, 옮긴 직후 몇 초 동안 되돌릴 수 있습니다. 할 일을 누르면 모든 칸을 바꾸는 화면이 열립니다. 고치는 동안 장부가 바뀌면(작업·CLI·메모 한 줄 더하기) 손대지 않은 칸은 새 값을 보이고, 고친 칸은 쓴 그대로 두고 바뀌었다고 알립니다. 메모를 고치는 중에 한 줄 더하면, 그 줄은 고치던 메모 아래에도 붙습니다. 저장은 고친 칸만 보냅니다. 화면에서 바꾼 것은 누가가 `human:ui` 로 남습니다.

사이드바 아래쪽의 **Settings** 는 워커가 받는 규칙을 켜진 것·꺼진 것 모두 보여 줍니다. 줄마다 번호, 켜짐·꺼짐, 만든 회고(`r<n>`, 그 회고 작업 화면으로 가는 링크), 회고의 제안에서 고쳐졌는지(edited), 마지막으로 바꾼 시각이 나오고, 꺼진 규칙은 흐리게 보입니다. 보기만 하는 화면이라 규칙을 바꾸는 것은 `nod rule` 로 합니다.

할 일 목록은 키보드로도 다룹니다. `⌘⇧0` 이나 Tab 으로 목록에 들어가 `↑` `↓`(또는 `j` `k`)로 줄을 옮기고, `x` 로 끝내고, `s` 로 상태 메뉴를 열고, `Enter` 로 할 일을 펼칩니다. 한 글자 키는 할 일 줄에 포커스가 있을 때만 받고, 글자가 아니라 키보드의 자리로 맞추므로 한글 입력 상태에서도 동작합니다. 읽던 줄이 새로 고침(CLI·워커의 변경)으로 빠져 포커스가 옆 줄로 옮겨지면, 1초 동안은 `x`·`s` 를 받지 않습니다. 빠진 줄에 누르려던 키가 옆 할 일을 끝내지 않게 하려는 것입니다. `?` 는 단축키 도움말을 열고 `Esc` 는 메뉴와 도움말을 닫습니다. 페이지 이동과 받아 적기는 브라우저 단축키와 겹쳐서 키를 두지 않았습니다.

## 데스크톱 앱 (macOS)

`desktop/` 의 앱은 화면 서버를 창에 띄우고, 메뉴 막대 아이콘과 전역 단축키로 어디서든 nod 를 불러오거나 떠오른 일을 받아 적게 해 줍니다. 화면 서버는 앱이 띄우지 않고, 로그인할 때 launchd 가 띄웁니다.

먼저 화면 서버를 로그인 에이전트로 둡니다. `ui/` 를 빌드하고 `~/Library/LaunchAgents/io.github.kkokworks.nod.ui.plist` 를 설치해 바로 띄웁니다. 개발 서버가 아니라 빌드한 서버(`bun run build` 뒤 `bun run start`)를 띄우므로, 레포를 받아 오거나 브랜치를 바꾼 뒤에는 같은 명령을 다시 돌려 빌드합니다. 실행한 셸의 `PATH`(bun·tmux·git·claude)와, 있으면 `NOD_HOME`·`CLAUDE_CONFIG_DIR` 로 돕니다. 데스크톱 앱의 받아 적기도 이 에이전트의 환경으로 `nod in` 을 돌립니다. 로그는 `~/Library/Logs/nod-ui.log` 입니다. 4800 포트를 개발 서버가 쓰고 있으면 뜨지 못하니 개발 서버를 끄고 설치합니다.

```sh
sh desktop/launchd/ui.sh install     # 빌드하고 에이전트를 설치·재시작
sh desktop/launchd/ui.sh uninstall   # 에이전트를 멈추고 지움
```

앱을 빌드하려면 Xcode Command Line Tools(`xcode-select --install`)와 [Rust](https://rustup.rs) 툴체인이 필요합니다.

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust
cd desktop && bun install && bun run build
cp -R src-tauri/target/release/bundle/macos/nod.app /Applications/
```

전역 단축키는 앱이 떠 있어야 동작합니다. 로그인할 때 앱도 띄우려면 시스템 설정 › 일반 › 로그인 항목의 「로그인 시 열기」에 nod.app 을 더합니다.

창을 닫으면(⌘W) 숨기기만 하고 앱은 메뉴 막대 아이콘으로 남습니다. 아이콘 메뉴에는 열기·받아 적기·종료가 있습니다. 서버가 떠 있지 않으면 창에 그렇다고 알리고, 서버가 뜨면 저절로 넘어갑니다. 화면 서버(`127.0.0.1:4800`) 밖으로 나가는 링크(PR, 이 컴퓨터의 다른 포트 등)는 브라우저에서 열립니다.

| 키 | 하는 일 |
|---|---|
| ⌘1~6 | 메인 창을 Focus · Inbox · Projects · Someday/Maybe · Waiting For · Done 으로 (메뉴 막대의 「이동」) |
| ⌘N | 받아 적기 창 열기 |
| ⌘W | 창 닫기(숨기기) |
| ⌘R | 메인 창 다시 읽기 (메뉴 막대의 「보기」). 서버가 꺼졌으면 안내 페이지로 |
| ⌃⌥⌘O | 어디서든: nod 창 불러오기, 앞에 있으면 숨기기 |
| ⌃⌥⌘N | 어디서든: 받아 적기 창 열기 |

받아 적기 창에 쓰고 Enter 를 누르면 `nod in` 으로 Inbox 에 넣고 닫힙니다(누가는 `human:desktop`). Esc 는 그냥 닫습니다. 다른 앱에서 연 창이면 보내거나 닫은 뒤 그 앱으로 돌아갑니다. 실패하면 쓴 글을 그대로 두고 오류를 보여 줍니다.

`nod in` 은 화면 서버와 같은 환경으로 돕니다. 위의 `ui.sh install` 이 설치한 에이전트(plist)에서 `PATH` 와, 있으면 `NOD_HOME`·`CLAUDE_CONFIG_DIR` 를 받아 쓰므로, 받아 적은 일은 화면 서버가 보는 장부에 들어갑니다. 그래서 받아 적기 전에 에이전트를 설치해 두어야 하고(없으면 창에 그렇게 알립니다), 설치한 셸의 `PATH` 에 `bun link` 로 등록한 `nod` 가 있어야 합니다. 셸의 환경을 바꿨으면 `ui.sh install` 을 다시 돌립니다. 앱은 받아 적을 때마다 에이전트를 읽으므로 다시 켜지 않아도 됩니다.

전역 단축키 두 개는 `~/Library/Application Support/io.github.kkokworks.nod/shortcuts.json` 에서 바꿉니다. 없는 키는 기본값을 쓰고, 앱을 다시 켜면 반영됩니다. 키는 `Ctrl`·`Alt`(⌥)·`Shift`·`Cmd` 와 키 이름(`O`, `Space`, `F1` 등)을 `+` 로 잇습니다. 파일을 읽지 못하거나 값이 글자가 아니어서 기본값을 쓸 때, 그리고 다른 앱이 이미 쓰는 키라 등록하지 못할 때는 메뉴 막대 아이콘 메뉴에 ⚠︎ 줄로 알려 줍니다.

```json
{ "window": "Ctrl+Alt+Cmd+O", "capture": "Ctrl+Alt+Cmd+N" }
```

설계와 실측 기록은 [docs/design.md](docs/design.md) 에 있습니다.
