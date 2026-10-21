# nod — 에이전트 안내

이 문서는 목차입니다. 본문은 아래 파일에 있습니다. 작업을 시작하기 전에 규칙을 모두 읽고 따릅니다.

## 규칙

| 규칙 | 한 줄 |
|---|---|
| [public-repo](.claude/rules/public-repo.md) | 공개 레포입니다. 회사 내용·개인정보·민감정보를 코드·문서·커밋 메시지에 넣지 않고, 커밋 전에 확인합니다 |

Claude Code 는 `.claude/rules/` 를 자동으로 읽습니다. 다른 에이전트는 위 파일을 직접 읽습니다.

## 스킬

| 스킬 | 쓰는 때 |
|---|---|
| [nod](skills/nod/SKILL.md) | Claude 세션 안에서 여러 일을 nod 로 병렬로 맡기고, 사람에게는 결정만 받아 전할 때. `~/.claude/skills/nod` 에 링크해 `/nod` 로 씁니다 |
| [gtd](skills/gtd/ledger.md) | nod 할 일 장부로 GTD 를 할 때(받아 적기·모으기·받은 일함 비우기·오늘 집중·내일 준비·주간 리뷰). 할 일마다 스킬이 따로 있는 묶음(`skills/gtd/skills/<이름>`)이라 `~/.claude/skills/gtd` 에 링크하면 `/gtd:<이름>` 으로 씁니다 |
| [wide-research](skills/wide-research/SKILL.md) | 항목 여러 개를 같은 칸으로 조사해 비교표 한 장으로 모을 때. 항목마다 [wide-item](agents/wide-item.md) 서브 에이전트를 띄웁니다. nod 워커는 쓰지 않습니다 |

## 문서

| 문서 | 내용 |
|---|---|
| [README.md](README.md) | 설치와 사용법 |
| [docs/design.md](docs/design.md) | 설계, 결정 이유, 실측 기록 |

## 검증

커밋 전에 `bun test`, `bun run typecheck`, `bun run lint` 가 모두 통과해야 합니다. `ui/` 를 고쳤으면 `ui/` 에서 `bun run typecheck` 도 통과해야 합니다.

> 규칙·스킬을 더하면 이 표에도 한 줄을 더합니다.
