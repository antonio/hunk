# Selection note extension

Writes a reviewer note on the selected hunk from an extension command. The example shows `ctx.review.notes.create`: the note goes through the same rules as a note typed with `c`, and because the command writes it with `as: "user"`, the note is the user's own — they can edit it with `E`, reply with `R`, or delete it.

Run it directly from this checkout:

```bash
bun run packages/hunk/src/main.tsx -- diff --extension ./examples/extensions/selection-note
```

Select a hunk, run **Extensions → Note this hunk…** (`F8`), and type the note. The note lands on the hunk's first changed line.

Writes are synchronous and every refusal comes back as `{ ok: false, code, message }` — for example `blank-note`, `note-too-large`, or `unavailable` after the review reloaded — so the command reports it instead of failing. Write with `as: "agent"` instead when the note is the extension's own finding; agent notes stay hidden until the user shows agent notes, and the user cannot edit them.
