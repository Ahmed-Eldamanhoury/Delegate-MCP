# Publishing Checklist — going from local repo to public GitHub repo

Distinct from [docs/RELEASE_CHECKLIST.md](../RELEASE_CHECKLIST.md) (the engineering/technical
certification checklist, already PASS on all 9 items) — this one covers the GitHub-specific
mechanics of the actual first push. **None of the commands below have been run.** No GitHub
credentials exist in this environment, and pushing/tagging is a user-authorized action.

## Prerequisites (do these on GitHub first)

- [ ] Create the repository at `https://github.com/Ahmed-Eldamanhoury/Delegate-MCP` (public,
      no README/LICENSE/.gitignore auto-generated — this repo already has all three).
- [ ] Decide whether to enable GitHub Discussions (not currently referenced anywhere in this
      repo's templates — skip unless you want it).
- [ ] Consider branch protection on `main` once pushed: require the `CI` check to pass before
      merging, at minimum.

## Push (run these locally, in order)

```
git branch -M main
git remote add origin https://github.com/Ahmed-Eldamanhoury/Delegate-MCP.git
git push -u origin main
```

## Tag and release

```
git tag -a v2.0.0 -m "v2.0.0 - first public release"
git push origin v2.0.0
```

Then open GitHub → Releases → "Draft a new release", pick tag `v2.0.0`, and paste the title/
description from [GITHUB_RELEASE_v2.0.0.md](GITHUB_RELEASE_v2.0.0.md).

## After the first push

- [ ] Apply the label set in [`.github/labels.yml`](../../.github/labels.yml) (manually, or via
      a tool like `github-label-sync`) — labels aren't created by pushing the file alone.
- [ ] Confirm the `CI` and `CodeQL` Actions workflows both ran successfully on the initial push.
- [ ] Confirm Dependabot picked up `.github/dependabot.yml` (check the repo's Insights →
      Dependency graph → Dependabot tab).
- [ ] Verify `LICENSE`/`SECURITY`/`CONTRIBUTING` badges/links render correctly on the repo's
      main page (GitHub auto-detects these from their standard root-level filenames).
