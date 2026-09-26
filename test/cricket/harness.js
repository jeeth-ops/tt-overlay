const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

function boot(){
  let html = fs.readFileSync(path.join(__dirname,'..','..','cricket-panel.html'), 'utf8');
  // strip external scripts (socket.io / firebase CDNs) — we stub them instead
  html = html.replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://example.test/cricket-panel?room=TESTMATCH',
    virtualConsole: vc,
    beforeParse(w){
      w.io = () => ({ on(){}, emit(){}, connected: false, disconnect(){} });
      w.fetch = () => Promise.resolve({ ok:true, json: () => Promise.resolve({ success:false }) });
      w.firebase = undefined;
      w.alert = () => {};
      w.confirm = () => true;
      w.crypto = w.crypto || {};
      if(!w.crypto.randomUUID) w.crypto.randomUUID = () => 'uuid-' + Math.random().toString(36).slice(2);
    }
  });
  return { dom, w: dom.window, errors };
}

const { dom, w, errors } = boot();
w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
module.exports = { dom, w, errors };
