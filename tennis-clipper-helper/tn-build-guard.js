// ================================================================
// 🎾 Runs before `npm run build`: the Tennis Clipper is never built inside
// the CRICKET Clipper's folder or the VOLLEYBALL Clipper's. If this folder
// has either one's files, nothing is built (and nothing of theirs is
// touched) — the Tennis Clipper belongs in its own folder.
// ================================================================
const fs = require('fs');
const path = require('path');

const here = process.cwd();
const OTHERS = {
  CRICKET: ['ClipperHelper.exe', 'server.js', 'clipOrganizer.js', 'fmp4.js', 'clipper-launch.vbs', 'install-clipper-launcher.bat', 'config.json', 'clip-jobs.json'],
  VOLLEYBALL: ['VolleyballClipper.exe', 'volleyball-clipper-server.js', 'vb-organizer.js', 'vb-fmp4.js', 'volleyball-clipper-launch.vbs', 'install-volleyball-clipper-launcher.bat', 'volleyball-clipper-config.json', 'volleyball-clip-jobs.json'],
};
for (const [sport, names] of Object.entries(OTHERS)) {
  const found = names.filter((f) => fs.existsSync(path.join(here, f)));
  if (!found.length) continue;
  console.error('');
  console.error('  STOP - this folder has the ' + sport + ' Clipper (' + found.join(', ') + '):');
  console.error('    ' + here);
  console.error('  Nothing was built, and the ' + sport.toLowerCase() + ' Clipper is untouched.');
  console.error('  Put the Tennis Clipper files in their OWN folder');
  console.error('  (e.g. C:\\AllSportsLive\\TennisClipper), then run npm install and npm run build there.');
  console.error('');
  process.exit(1);
}
