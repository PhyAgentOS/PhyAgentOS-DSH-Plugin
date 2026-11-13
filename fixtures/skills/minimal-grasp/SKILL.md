# minimal-grasp

Fixture skill for the forge plugin tests.

## Workflow

1. Call `sim.get_robot_info` to read frames and limits.
2. Report the selected profile back to the user.

This document intentionally has no YAML frontmatter: forge bundles keep their
metadata in `skill.yaml`, and the forge provider synthesizes the catalog entry
from it.
