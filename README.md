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
nod watch --issue PROJ-12,PROJ-13   # 이 이슈들의 결정만 열리는 대로 (루트 세션을 여럿 둘 때)
nod 3 '그렇게 해'     # 결정 3에 답하기 (같은 세션에 들어감)
nod tell 1 '테스트도 추가해 줘'   # 작업 1의 세션에 후속 지시
nod attach 1         # 작업 1의 화면 열기
nod ls               # 작업 상태 (이슈가 있는 작업은 이슈별로 묶어서)
nod link 1 https://example.com/org/app/pulls/7   # 작업 1의 결과가 간 곳(PR 등)
nod gc 1             # 작업 1을 다 처리함: 세션·worktree 와 머지된 브랜치를 지우고 ls 에서 뺌 (ls --all 엔 남음)
```

레포 작업의 worktree 는 `~/.nod/work/<레포 폴더 이름>/<브랜치>` 에 생깁니다(위 예는 `~/.nod/work/app/fix/login`). 폴더와 브랜치 이름만 봐도 무슨 일인지 알 수 있습니다.

작업이 `succeeded` 가 돼도 결과를 push·PR 로 내보내는 일은 따로 남습니다. 내보낸 뒤 `nod link` 로 주소를 남기면, `nod ls` 에서 링크가 없는 작업이 곧 아직 내보내지 않은 결과입니다. 머지까지 끝나면 `nod gc` 로 정리합니다.

`--issue` 로 이슈를 주면 `nod ls` 는 그 작업을 이슈 아래에 묶어 보여 주고, 결정 목록과 알림에도 이슈가 붙습니다. 한 이슈를 여러 작업으로 나눠도 같은 키를 주면 함께 보입니다.

정해진 때나 새 항목마다 할 일은 트리거로 맡깁니다. 트리거가 있는 동안 OS 스케줄러(macOS launchd, Linux crontab)가 매분 `nod tick` 을 돌립니다.

```sh
nod trigger add '0 9 * * MON-FRI' '어제 머지된 PR 을 요약해 줘' --repo ~/code/app
nod trigger add '*/10 * * * *' '이 이슈의 원인을 조사해 줘' \
  --source "gh issue list --assignee @me --json number,title --jq '.[] | \"\(.number)\t\(.title)\"'"
nod trigger ls
```

source 가 탭으로 앞에 붙인 키(위에서는 이슈 번호)는 그 항목으로 생긴 작업의 이슈가 됩니다.

`~/.nod/notify` 실행 파일을 두면 결정이 열리거나 작업이 끝날 때 nod 가 JSON 을 stdin 으로 넘겨 부릅니다. JSON 의 `task` 에는 작업 번호·지시·이슈(`issue`, 없으면 `null`)가 들어 있어, 할 일 앱으로 보낼 때 이슈별로 묶을 수 있습니다. 예를 들어 macOS 알림은 이렇게 받습니다.

```sh
#!/bin/sh
bun -e 'const e = await Bun.stdin.json(); const t = e.decision ? `결정 #${e.decision.id}` : e.event
Bun.spawnSync(["osascript", "-e", "on run a", "-e", "display notification (item 2 of a) with title (item 1 of a)", "-e", "end run", "nod", `${t}: ${e.task?.brief ?? e.error}`])'
```

워커가 끝났다고 보고하면 nod 가 검증 명령을 돌리고, 레포 작업이면 커밋했는지 확인한 뒤, 워커의 대화를 모르는 리뷰어에게 결과를 한 번 더 보게 합니다. 리뷰어는 지시와 그 뒤 사람이 한 말을 기준으로, 요청한 일을 했는지, 테스트나 검증 명령을 약하게 고쳐 통과시키지 않았는지, 보고가 결과와 맞는지를 봅니다. 셋 중 하나라도 걸리면 그 내용이 같은 세션으로 돌아가 워커가 계속 고칩니다.

검증에 되돌려졌거나 실패한 작업은 끝난 뒤 회고 워커가 돌아보고, 앞으로의 워커가 받을 규칙 한 줄을 결정으로 제안합니다. 받아들인 규칙은 `~/.nod/rules.md` 에 쌓이고 모든 워커에게 전해집니다. 이 파일은 직접 고쳐도 됩니다.

사람이 할 일을 GTD 방식으로 적어 두는 장부도 있습니다. 떠오른 일은 `nod in` 으로 받은 일함에 넣고, 나중에 상태·프로젝트·상황을 정합니다.

```sh
nod in '치과에 예약 전화하기'              # 받은 일함에 넣기
nod project add 건강 --outcome '치료 끝내기'
nod todo set t1 --status next --project 건강 --context @전화   # 다음 행동으로 정리
nod in '견적서 회신 받기'
nod todo set t2 --status waiting --waiting-on 민수           # 기다리는 일
nod todo                 # 받은 일함·다음 행동·대기
nod todo next --context @전화
nod project              # 진행 중인 프로젝트와 다음 행동 수 (없으면 알려 줌)
nod project p1           # 한 프로젝트: 열린 할 일과 바뀐 이력
nod todo t1              # 한 개 보기: 메모·링크·누가 무엇을 바꿨는지
nod todo done t1
nod add --todo t3        # 할 일을 nod 작업에 맡기기 (지시를 빼면 제목·메모가 지시)
nod todo waiting         # 사람이나 작업을 기다리는 할 일
```

맡긴 할 일은 작업을 기다리는 대기가 됩니다. 작업이 성공하면 끝나고, `nod drop` 으로 작업을 끝내면 다음 행동으로 돌아옵니다. 작업의 결과 한 줄과 링크는 `nod todo <할 일>` 에 나옵니다. 열린 결정은 `nod todo` 의 맨 위에 다음 행동으로 나오고, `nod <결정> <답>` 으로 답합니다.

할 일은 `t<번호>`, 프로젝트는 `p<번호>` 로 씁니다. 작업·결정의 번호와 섞이지 않게 맨 숫자는 받지 않습니다. 상황이 없는 할 일은 어디서나 할 수 있는 일로 보고 상황으로 거를 때도 보여 줍니다. 언젠가로 미룬 프로젝트의 할 일은 `--project` 나 `--all` 을 줄 때만 보입니다. 바뀐 내용은 누가 바꿨는지와 함께 남습니다. 터미널의 사람은 `human`, Claude 세션은 `claude:<세션>`, nod 워커는 `worker:<작업>` 이고, 맡긴 할 일을 작업에 따라 바꾼 것은 `nod` 입니다. `NOD_ACTOR` 를 주면 그 값을 씁니다.

브라우저로 보려면 `ui/` 의 화면 서버를 띄웁니다.

```sh
cd ui && bun install && bun run dev   # http://127.0.0.1:4800
```

첫 화면에는 열린 결정·작업·트리거·통계가, 작업 화면에는 시도 이력·결정·마지막 보고와 살아 있는 세션의 지금 화면이 나오고, 3초마다 새로 고칩니다. 워커 화면 아래 입력창은 `nod tell` 처럼 워커에게 말을 보내고, 결정이 열려 있으면 그 결정에 답합니다(`nod <결정> <답>`). 권한·레포 신뢰·규칙 결정은 Yes/No 버튼으로만 답합니다. 작업 끝내기(`drop`)와 정리(`gc`)는 CLI 에서 합니다. 워커의 보고와 화면이 보이고 워커에게 말을 보낼 수 있으므로 이 컴퓨터(127.0.0.1)에서만 엽니다.

설계와 실측 기록은 [docs/design.md](docs/design.md) 에 있습니다.
