#!/usr/bin/env bash
# Inlines styles.css and app.js into a single self-contained dist/index.html
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist

python3 - <<'PY'
from pathlib import Path
html = Path('index.html').read_text()
css  = Path('styles.css').read_text()
js   = Path('app.js').read_text()

html = html.replace('<link rel="stylesheet" href="styles.css" />',
                    '<style>\n' + css + '\n</style>')
html = html.replace('<script src="app.js"></script>',
                    '<script>\n' + js + '\n</script>')

Path('dist/index.html').write_text(html)
print('wrote dist/index.html', len(html), 'bytes')
PY
