---
"hunkdiff": minor
---

Hunk can keep review notes across launches. Set `save_notes = true` in your user config, or pass `--save-notes`, and each review's notes — yours and agents' — come back the next time the same review opens, stored in your state directory (`~/.local/state/hunk/notes`). Saving is off by default, and a repository's config cannot turn it on.
