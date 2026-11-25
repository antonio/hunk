---
"hunkdiff": minor
---

Saved notes go away on their own once what they were about is gone: each time a review opens with saving on, Hunk forgets saved reviews whose worktree or clone was removed, whose files were deleted, or whose commit no branch, tag, bookmark, or head reaches any more. `hunk notes prune` without `--older-than` does the same on demand.
