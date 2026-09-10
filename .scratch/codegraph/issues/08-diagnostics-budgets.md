## Parent

#1

## What to build

Diagnostics and resource budgets completed per ADR-0003/0004: every enumerated diagnostic code in the spec (`partial`, `unsupported_language`, `indexing`, `truncated`, file-skip reasons: oversize > 1 MB, binary, decode failure, file-count stop at 50,000, first-build timeout 120 s) is produced by the corresponding condition and is project-overridable where budgets are concerned. Encoding handling: UTF-8 primary, BOM/common single-byte encodings auto-detected, binary/undecodable files skipped with diagnostics. Project-level include/exclude globs tune scan scope.

## Acceptance criteria

- [ ] Oversize file (> 1 MB) skipped with a diagnostic; project override raises/lowers the cap.
- [ ] Binary file skipped with a diagnostic; undecodable encoding skipped with a diagnostic.
- [ ] File-count stop (50,000 default) produces a diagnostic listing the count; project override works.
- [ ] First-build timeout (120 s default) produces `indexing` status; project override works.
- [ ] `partial` diagnostic present whenever any scan/parse deviation occurred; absent on a clean full scan.
- [ ] include/exclude globs: excluding a fixture directory removes its symbols; including a non-default language extension adds it (when supported).
- [ ] Diagnostics codes match the documented enumeration exactly (no ad-hoc strings).

## Blocked by

- Ticket 2 (#3, lazy index)
- Ticket 5 (#6, incremental refresh — timeout semantics land there first)
