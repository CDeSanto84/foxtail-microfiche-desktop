const { contextBridge, ipcRenderer } = require('electron');

function localApiBase(value) {
  const fallback = 'http://127.0.0.1:8787/api/v1';
  if (!value) return fallback;
  try {
    const url = new URL(value);
    const localHost = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    if (url.protocol !== 'http:' || !localHost || url.username || url.password || url.search || url.hash) return fallback;
    if (url.pathname.replace(/\/+$/, '') !== '/api/v1') return fallback;
    return url.href.replace(/\/+$/, '');
  } catch {
    return fallback;
  }
}

contextBridge.exposeInMainWorld('foxtail', Object.freeze({
  apiBaseUrl: localApiBase(process.env.MICROFICHE_API_BASE_URL),
  platform: process.platform,
  getNewspaperSources: () => ipcRenderer.invoke('microfiche-engine-catalog'),
  getIssueRoutes: (publication, issueDate) => ipcRenderer.invoke('microfiche-issue-routes', publication, issueDate),
  activateNewsstandSource: (sourceId, context) => ipcRenderer.invoke('microfiche-newsstand-activate', sourceId, context),
  showNewsstandSource: (bounds) => ipcRenderer.invoke('microfiche-newsstand-show', bounds),
  hideNewsstandSource: () => ipcRenderer.invoke('microfiche-newsstand-hide'),
  deactivateNewsstandSource: () => ipcRenderer.invoke('microfiche-newsstand-deactivate'),
  controlNewsstandSource: (action) => ipcRenderer.invoke('microfiche-newsstand-control', action),
  onNewsstandViewState: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Newsstand state listener must be a function.');
    const wrapped = (_event, state) => listener(state);
    ipcRenderer.on('microfiche-newsstand-view-state', wrapped);
    return () => ipcRenderer.removeListener('microfiche-newsstand-view-state', wrapped);
  },
  openResearchUrl: (url) => ipcRenderer.invoke('microfiche-open-result', url),
  copyText: (value) => ipcRenderer.invoke('microfiche-copy-text', value),
  listIssueReels: () => ipcRenderer.invoke('microfiche-reel-list'),
  getIssueReel: (id) => ipcRenderer.invoke('microfiche-reel-get', id),
  importIssueReel: (metadata) => ipcRenderer.invoke('microfiche-reel-import', metadata),
  onIssueReelProgress: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Issue Reel progress listener must be a function.');
    const wrapped = (_event, progress) => listener(progress);
    ipcRenderer.on('microfiche-reel-progress', wrapped);
    return () => ipcRenderer.removeListener('microfiche-reel-progress', wrapped);
  },
}));
