// ================================================================
// 🏐 Runs before `npm run build`: the Volleyball Clipper is never built
// inside the CRICKET Clipper's folder. If this folder has the Cricket
// Clipper's files, nothing is built (and nothing of cricket is touched) —
// the Volleyball Clipper belongs in its own folder.
// ================================================================
const fs = require('fs');
const path = require('path');

const here = process.cwd();
const CRICKET = ['ClipperHelper.exe', 'server.js', 'clipOrganizer.js', 'fmp4.js', 'clipper-launch.vbs', 'install-clipper-launcher.bat', 'config.json', 'clip-jobs.json'];
const found = CRICKET.filter((f) => fs.existsSync(path.join(here, f)));
if (found.length) {
  console.error('');
  console.error('  STOP - this folder has the CRICKET Clipper (' + found.join(', ') + '):');
  console.error('    ' + here);
  console.error('  Nothing was built, and the Cricket Clipper is untouched.');
  console.error('  Put the Volleyball Clipper files in their OWN folder');
  console.error('  (e.g. C:\\AllSportsLive\\VolleyballClipper), then run npm install and npm run build there.');
  console.error('');
  process.exit(1);
}
