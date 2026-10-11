# Issue tracker: GitHub

Issues, specs, and wayfinder maps for this repo live as GitHub issues on the
repo's own GitHub Issues. Use the `gh` CLI for all operations; it infers the
repo from `git remote -v` when run inside a clone, and `gh api` fills in the
`{owner}` and `{repo}` placeholders the same way.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body-file <file>`. Write
  multi-line bodies to a file or a heredoc.
- **Read an issue**: `gh issue view <number> --comments`.
- **List issues**: `gh issue list --state open --json number,title,labels,assignees`
  with `--label` and `--state` filters as needed.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` /
  `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

- **Map**: one issue labelled `wayfinder:map`. Its body holds Destination,
  Notes, Decisions so far, Not yet specified, and Out of scope.
- **Ticket types**: each ticket carries one of `wayfinder:research`,
  `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.
- **Child tickets**: tickets are native GitHub sub-issues of the map. Attach
  one with the REST sub-issues endpoint, which takes the child's database id
  (not its number):

  ```sh
  child_id=$(gh api 'repos/{owner}/{repo}/issues/<child>' --jq .id)
  gh api -X POST 'repos/{owner}/{repo}/issues/<map>/sub_issues' \
    -F sub_issue_id="$child_id"
  ```

- **Blocking**: use GitHub's native issue dependencies. To record that
  `<blocked>` is blocked by `<blocker>`:

  ```sh
  blocker_id=$(gh api 'repos/{owner}/{repo}/issues/<blocker>' --jq .id)
  gh api -X POST 'repos/{owner}/{repo}/issues/<blocked>/dependencies/blocked_by' \
    -F issue_id="$blocker_id"
  ```

  List what blocks a ticket with
  `gh api 'repos/{owner}/{repo}/issues/<n>/dependencies/blocked_by'`.
- **Claim**: assign the ticket to the dev driving the map before any work:
  `gh issue edit <n> --add-assignee @me`. An open, unassigned ticket is
  unclaimed.
- **Frontier**: open sub-issues of the map that are unassigned and whose
  blockers are all closed. List the map's children with
  `gh api --paginate 'repos/{owner}/{repo}/issues/<map>/sub_issues'`, then
  check each open, unassigned child's `blocked_by` list.
- **Resolve**: post the answer as a resolution comment, close the ticket, and
  append a one-line pointer to the map's Decisions so far.
