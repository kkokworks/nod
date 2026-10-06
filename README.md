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
nod                  # 결정할 것
nod 3 '그렇게 해'     # 결정 3에 답하기 (같은 세션에 들어감)
nod tell 1 '테스트도 추가해 줘'   # 작업 1의 세션에 후속 지시
nod attach 1         # 작업 1의 화면 열기
nod ls               # 작업 상태
```

설계와 실측 기록은 [docs/design.md](docs/design.md) 에 있습니다.
