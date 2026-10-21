---
name: setup
description: nod 할 일 장부를 처음 설정하거나(개인 설정, 캘린더, 하루 첫 세션 알림), 업무 도구를 켜고 끄고 더한다. "gtd 설정", "업무 도구 연결해 줘"라고 할 때 사용.
---

# 할 일 장부 설정

업무 도구를 켜고 끄고 더하는 일은 [sources/README.md](../../sources/README.md) 를 따릅니다. 처음 설정은 아래 순서입니다.

1. `nod` 명령이 동작하는지 봅니다(`nod todo`). 없으면 nod 레포에서 `bun link` 를 하라고 안내합니다.
2. 개인 설정 파일을 nod 홈(`~/.nod`, `$NOD_HOME` 이 있으면 그곳)에 둡니다. 레포에는 넣지 않습니다.
   - `config.json`: `{ "sources": [] }` 로 시작하고, 업무 도구를 켤 때마다 sources/README.md 대로 채웁니다.
   - `profile.md`: 역할, 영역과 목표, 지켜보는 일, 프로젝트(한 줄에 하나: 이름과 담는 일), 자주 쓰는 말. 사용자에게 물어 채웁니다.
3. 캘린더를 읽으려면 macOS 에서 사용자에게 `! sh <nod 레포>/calendar/build.sh` 다음 `! nod today` 를 부탁합니다. 처음 한 번 캘린더 권한을 허용하면 됩니다.
4. 하루 첫 세션 알림: 사용자 Claude Code 설정(`~/.claude/settings.json`)의 `hooks.SessionStart` 에 명령 `nod todo check --nudge` 를 더합니다. 하루 한 번, 놓치면 안 되는 것이 있을 때만 한 줄을 띄웁니다. 설정을 바꾸기 전에 무엇을 더할지 보여 주고 확인받습니다.
5. 주간 리뷰용 반복 할 일을 만들지 묻습니다([gtd:review](../review/SKILL.md)).
