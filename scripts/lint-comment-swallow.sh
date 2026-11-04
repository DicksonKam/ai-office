#!/bin/bash
# A trailing `// note` that ends in a statement (`… this.x = new Set();`, `… tAL.set(1, 0, 2);`) swallowed that
# statement: it was meant to be code. This has silently broken the day board and a pose once each.
cd "$(dirname "$0")/.." && if grep -nE ';\s*//.*\b(this\.[A-Za-z_]+ = [^;]+|[A-Za-z_]+\.[A-Za-z_]+\([^;()]*\));\s*$' web/*.js server/*.js server/collectors/*.js server/links/*.js; then echo "^ a statement after // is a comment, not code"; exit 1; fi; echo "ok: no statements swallowed by comments"
