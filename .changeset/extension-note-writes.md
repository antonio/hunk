---
"hunkdiff": minor
---

Extensions can create, edit, and remove review notes with `ctx.review.notes` (extension API 34). Each write states whether it is the user's note or an agent's, follows the same rules as notes written in the terminal, and reports a refusal as `{ ok: false, code, message }`.
