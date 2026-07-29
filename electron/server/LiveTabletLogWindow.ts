import { BrowserWindow } from 'electron';
import { createPrompterIcon } from '../tray/PrompterIcon.js';

export class LiveTabletLogWindow {
  private window: BrowserWindow | null = null;
  constructor(private readonly preloadPath: () => string) {}

  show() {
    if (this.window && !this.window.isDestroyed()) { this.window.show(); this.window.focus(); return; }
    this.window = new BrowserWindow({
      width: 1120, height: 720, title: 'Prompter — Live Tablet Log', show: false,
      icon: createPrompterIcon(),
      webPreferences: { preload: this.preloadPath(), contextIsolation: true, nodeIntegration: false }
    });
    this.window.on('closed', () => { this.window = null; });
    this.window.once('ready-to-show', () => this.window?.show());
    void this.window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(LOG_HTML)}`);
  }

  close() { this.window?.close(); this.window = null; }
}

const LOG_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Live Tablet Log</title><style>
body{font-family:Segoe UI,sans-serif;margin:0;background:#111820;color:#e9f0f4}header{position:sticky;top:0;background:#17232d;padding:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}button,select,input{background:#253744;color:#fff;border:1px solid #507080;border-radius:4px;padding:6px}input{min-width:180px}#log{font:12px/1.45 Consolas,monospace;white-space:pre-wrap;padding:12px}.event{border-bottom:1px solid #263743;padding:5px}.error{color:#ff9e9e}.warn{color:#ffd28a}.debug{color:#a8bac5}.muted{color:#9aabb5}</style></head><body>
<header><strong>Live Tablet Log</strong><select id="level"><option value="">All levels</option><option>debug</option><option>info</option><option>warn</option><option>error</option></select><select id="category"><option value="">All components</option><option value="network">Network</option><option value="pair">Pairing</option><option value="auth">Authentication</option><option value="protocol">Protocol</option></select><input id="connection" placeholder="Connection ID filter"><button id="pause">Pause auto-scroll</button><button id="copyAll">Copy All</button><button id="copyVisible">Copy Visible</button><button id="clear">Clear View</button><button id="folder">Open Log Folder</button><button id="bundle">Save Diagnostic Bundle</button><span id="count" class="muted"></span></header><main id="log"></main><script>
const events=[];let paused=false;const log=document.querySelector('#log');const level=document.querySelector('#level');const category=document.querySelector('#category');const connection=document.querySelector('#connection');
const safe=v=>v==null?'':String(v);function line(e){const bits=[e.timestampLocal,'#'+e.sequence,e.level.toUpperCase(),'['+e.component+']',e.event,'—',e.message];if(e.connectionId)bits.push('conn='+e.connectionId);if(e.remoteAddress)bits.push('remote='+e.remoteAddress);if(e.protocolMessageType)bits.push('type='+e.protocolMessageType);if(e.closeCode!=null)bits.push('close='+e.closeCode+' '+safe(e.closeReason));if(e.errorMessage)bits.push(e.exceptionClass+': '+e.errorMessage);if(e.details&&Object.keys(e.details).length)bits.push(JSON.stringify(e.details));return bits.join(' ')}
function visible(){const l=level.value,c=category.value.toLowerCase(),q=connection.value.toLowerCase();return events.filter(e=>(!l||e.level===l)&&(!q||safe(e.connectionId).toLowerCase().includes(q))&&(!c||(e.component+' '+e.event).toLowerCase().includes(c)))}
function render(){log.textContent='';for(const e of visible()){const d=document.createElement('div');d.className='event '+e.level;d.textContent=line(e);log.appendChild(d)}document.querySelector('#count').textContent=visible().length+' visible / '+events.length+' total';if(!paused)scrollTo(0,document.body.scrollHeight)}
for(const x of [level,category,connection])x.addEventListener('input',render);document.querySelector('#pause').onclick=e=>{paused=!paused;e.target.textContent=paused?'Resume auto-scroll':'Pause auto-scroll'};
document.querySelector('#copyAll').onclick=()=>window.prompterApi.copyTabletLog(events);document.querySelector('#copyVisible').onclick=()=>window.prompterApi.copyTabletLog(visible());document.querySelector('#clear').onclick=()=>{events.length=0;window.prompterApi.clearTabletLogView();render()};document.querySelector('#folder').onclick=()=>window.prompterApi.openTabletLogFolder();document.querySelector('#bundle').onclick=()=>window.prompterApi.saveTabletDiagnosticBundle();
window.prompterApi.getTabletLogEvents().then(x=>{events.push(...x);render()});window.prompterApi.onTabletLogEvent(e=>{events.push(e);if(events.length>1000)events.shift();render()});</script></body></html>`;
