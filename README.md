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
```

## 쓰기

Claude 세션에서 `/nod` 를 부르거나 "이 일들 nod 에 맡겨줘" 라고 말합니다. 세션이 일을 작업으로 나눠 맡기고, 결정이 생기면 바로 전해 줍니다.

터미널에서 직접 쓸 수도 있습니다.

```sh
nod add '로그인 버그 고치기' --repo ~/code/app --check 'bun test'   # 워커가 바로 시작
nod add '로그인 화면 문구 정리' --repo ~/code/app --after 1        # 작업 1이 끝나면 그 브랜치에서 이어서
nod add '결제 오류 원인 조사' --issue PROJ-12                      # 이슈에 딸린 작업
nod                  # 결정할 것
nod 3 '그렇게 해'     # 결정 3에 답하기 (같은 세션에 들어감)
nod tell 1 '테스트도 추가해 줘'   # 작업 1의 세션에 후속 지시
nod attach 1         # 작업 1의 화면 열기
nod ls               # 작업 상태 (이슈가 있는 작업은 이슈별로 묶어서)
```

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

검증에 되돌려졌거나 실패한 작업은 끝난 뒤 회고 워커가 돌아보고, 앞으로의 워커가 받을 규칙 한 줄을 결정으로 제안합니다. 받아들인 규칙은 `~/.nod/rules.md` 에 쌓이고 모든 워커에게 전해집니다. 이 파일은 직접 고쳐도 됩니다.

설계와 실측 기록은 [docs/design.md](docs/design.md) 에 있습니다.
