#!/bin/bash
# Group.add() returns the group, so `parent.add(mesh).rotation.x = …` transforms the PARENT. This bug has tilted the
# whole building once already; fail loudly if it ever comes back.
cd "$(dirname "$0")/.." && if grep -nE "\.add\([^;]*\)\)\.(rotation|scale|position)" web/*.js; then echo "^ chained transform on .add() result: transforms the parent"; exit 1; fi; echo "ok: no chained transforms on .add()"
