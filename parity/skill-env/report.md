# skill-env differential parity report

Generated: 2026-10-27T15:47:49.009Z

9/9 scenarios PARITY

| id | kind | pass |
| --- | --- | --- |
| collect/mixed-frontmatter-forms | collect_skill_vars | PASS |
| collect/duplicate-across-skills-dedupe | collect_skill_vars | PASS |
| collect/no-kernel-no-skills | collect_skill_vars | PASS |
| collect/explicit-skills-kernel-dir-override | collect_skill_vars | PASS |
| mounts/mixed-dir-and-non-dir | _compute_var_mounts | PASS |
| mounts/two-directories-sorted | _compute_var_mounts | PASS |
| mounts/duplicate-directory-not-deduped | _compute_var_mounts | PASS |
| mounts/empty | _compute_var_mounts | PASS |
| mounts/bare-name-no-equals | _compute_var_mounts | PASS |
