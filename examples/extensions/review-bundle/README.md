# Review saved bundles with GitHub Viewed

This example opens an existing review-pr bundle at its recorded Git comparison.
It reads the authenticated user's GitHub Viewed state on opening and refresh.
Press `V` or click Viewed in a file header to fold/reveal a file and update GitHub.
Viewed controls visibility, not approval. Local toggles work without GitHub access.

## Load and open

Requires Hunk extension API 29, Git, and `gh` for synchronization. Authenticate
`gh` through your existing setup. The extension does not read credentials or
install dependencies. Without authenticated GitHub access the review still opens;
the status row reports that synchronization is unavailable.

From the repository checkout:

```sh
hunk --extension /path/to/hunk/examples/extensions/review-bundle \
  review-bundle /path/to/saved/bundle
```

Alternatively add the example folder to your existing user extension paths. A
launcher should pass the bundle directory, set cwd to the checkout, and guard its
expected comparison:

```sh
hunk review-bundle /path/to/saved/bundle \
  --expect-base <merge-base-oid> --expect-head <head-oid>
```

The optional guards must be supplied together. If the bundle changed since the
link was generated, opening fails rather than silently showing another comparison.
The command delegates to `diff <merge-base-oid> <head-oid> --vcs git
--exclude-untracked`. Hunk retains its ordinary **comparison** descriptor and exact
base/head OIDs; the PR identity stays in this extension.

An existing annotation sidecar must be passed explicitly. The extension does not
guess which bundle artifact contains notes:

```sh
hunk review-bundle /path/to/saved/bundle -- --agent-context /path/to/notes.json
```

After `--`, the command accepts `--agent-context`, `--mode`, `--theme`,
`--cursor-line` with values, and line-number, wrapping, and agent-note boolean
flags. It refuses revision, provider, pathspec, watch and arbitrary execution
options. It never assesses a PR, reruns review-prs, changes commits or branches,
or writes bundle notes, evidence, metadata or decisions.

## Bundle identity

`metadata.json` supplies `repository` (`owner/repo`), positive PR `number`, its
exact `https://github.com/owner/repo/pull/number` URL, and full commit OIDs.
The two existing producer shapes are accepted:

- `baseOid`, `headOid`, `mergeBaseOid`
- `base_oid`, `head_oid`, `merge_base_oid`

Conflicting dual fields or malformed supplied OIDs fail validation. The checkout's
GitHub origin must match the repository; all three revisions must be local commits
and Git must confirm their merge base. Bundle paths are explicit; there is no
bundle discovery or inference from the current branch.

## Refresh and failure behavior

Refresh rereads the same pinned Git comparison and pulls GitHub Viewed state.
`VIEWED` folds the file; `UNVIEWED` and `DISMISSED` reveal it. `DISMISSED` means the
file changed since it was viewed. No polling runs and no remote diff is downloaded.

If GitHub's current head or merge base differs, the status row reports a stale
bundle and remote writes are refused. Refresh the bundle through the existing
assessment workflow, then reopen the viewer. Local Viewed remains useful for the
pinned code even when synchronization is unavailable.

Mutations are serialized, superseded requests are discarded, and late reads
cannot overwrite a newer local toggle. GitHub provides only unconditional
path mutations, so the extension checks the comparison before and after each
write. A timeout, lost reply, revision race, or failed confirmation is reported
as **unknown/unsynced**, never successful. It does not retry mutations automatically.
A subsequent refresh reconciles the state GitHub currently reports. These checks
cannot make GitHub's API atomic or prove that cancelling a request undid its effect.

Every subprocess has a 15-second timeout and a 2-MiB output limit. Each complete
state read also has a 30-second deadline; file listing
has page/count limits and must be complete. Denied, malformed or oversized data
leaves local review available. Reloading into a different comparison revokes sync
authority. Replacing the extension registry requires reopening the bundle command.
