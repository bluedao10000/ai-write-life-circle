# Writer Agent Web

## Demo mode

```sh
pnpm dev
```

The standalone web app starts on `http://127.0.0.1:5173` and uses the replaceable
Demo adapter.

## Local API mode

```sh
pnpm dev:local
```

This starts the local API and Vite together. The default project ID is `local`;
select another one with `VITE_WRITER_AGENT_PROJECT_ID=my-project pnpm dev:local`.
The API reads Harness chapters with stable `CH-*` IDs and stores application
drafts outside the Harness. It does not write Git commits or call an Agent.

For separate processes, run `pnpm dev:api` and `pnpm dev` with
`VITE_WRITER_AGENT_MODE=api`, `VITE_WRITER_AGENT_PROJECT_ID`, and
`WRITER_AGENT_API_TARGET` configured. The Vite development proxy sends `/v1`
requests to the loopback API target.

Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm test:e2e` from the
repository root to verify the frontend and its API integration.

## VNext (2026-10-15)

The studio opens on the manuscript with Write / Book / Think navigation and
on-demand chapter / annotation drawers. Explicit older layout choices are
restored; new users start with both drawers closed. The old writer-agent.v2
workspace and API draft keys remain compatible.

Resume reads the mounted chapter's final text paragraphs and a saved author
next-writing note. Quick Note (Ctrl/Cmd ;) uses the real Notes adapter in API
mode, and Book → Creative Notes can reopen/edit/archive notes after refresh.
Errors retain input; version conflicts never silently replace newer notes.

API mode calls only implemented endpoints and uses server capability flags.
Missing flags disable notes. Knowledge, annotations, thinking Agent and canon
changes show unavailable states. Demo mode keeps its own notes and mock Agent,
marks simulated output and does not write real project/Harness data.

The existing Markdown editor, recovery, immutable revision saves, 409 queue
cancellation and memory export are preserved. The read-only server comparison
uses exact Markdown; discarding the local copy requires explicit confirmation.
Source Markdown that cannot round-trip stays read-only.

Visual checks cover 1440/1024/768/390px, light/dark and focus. See
../../harness/architecture/frontend-architecture.md for the current boundary and remaining
runtime/production work. No full application pixel-perfect claim is made.
