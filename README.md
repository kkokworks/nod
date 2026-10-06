# nod

여러 에이전트(Claude Code)를 동시에 돌려 일을 처리하고, 사람에게는 결정만 넘기는 오케스트레이터입니다. 사람은 고개만 끄덕이면(nod) 됩니다.

## 설치

[Bun](https://bun.sh) 과 로그인된 [Claude Code](https://claude.com/claude-code) CLI 가 필요합니다.

```sh
git clone https://github.com/kkokworks/nod && cd nod
bun install
bun link                                       # nod 명령 등록
ln -s "$PWD/skills/nod" ~/.claude/skills/nod   # Claude 세션에서 /nod
```

## 쓰기

Claude 세션에서 `/nod` 를 부르거나 "이 일들 nod 에 맡겨줘" 라고 말합니다. 세션이 일을 작업으로 나눠 넣고, 실행기를 뒤에서 돌리고, 결정이 생기면 바로 전해 줍니다.

터미널에서 직접 쓸 수도 있습니다.

```sh
nod add '로그인 버그 고치기' --repo ~/code/app --check 'bun test'
nod run              # 준비된 작업을 모두 동시에 실행
nod                  # 결정할 것
nod 3 '그렇게 해'     # 결정 3에 답하기
nod ls               # 작업 상태
```

설계와 실측 기록은 [docs/design.md](docs/design.md) 에 있습니다.
