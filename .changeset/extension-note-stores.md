---
"hunkdiff": minor
---

Extensions can keep review notes across launches with `hunk.registerNoteStore`. Hunk restores a review's saved notes with their authorship, places each by its line text (unchanged stays active, moved once follows, otherwise stale, file absent orphaned), and saves the complete set whenever it changes.
