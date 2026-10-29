import { running, type Terminals, Tmux } from '../src/tmux'
import { FakeTerminals, OWNER } from './fake-terminals'

// Loaded first by every Bun process a fake terminal runs (BUN_OPTIONS, which FakeTerminals.start
// sets): `nod run` there and the hooks of its Claude Code make their terminals where nod's entry
// point does (Tmux.of in cli.ts), across a process boundary no argument crosses, so that gives them
// the fake ones, kept in the same files.
;(Tmux as { of: (home: string) => Terminals }).of = (home) => FakeTerminals.of(home)

// Each ends once the test run that started its session is gone: a run cut off before its afterAll
// (a timeout, a person stopping it) would leave them waiting on their keyboards for good.
const owner = Number(process.env[OWNER])
if (owner > 0) {
  setInterval(() => {
    if (!running(owner)) process.exit(1)
  }, 1000).unref()
}
