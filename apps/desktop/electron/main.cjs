'use strict';

const { app, BrowserWindow, WebContentsView, clipboard, dialog, ipcMain, protocol, session, shell } = require('electron');
const path = require('node:path');

// Match the installed launcher without changing userData or saved sessions.
if (process.platform === 'linux') app.setDesktopName('foxtail-microfiche.desktop');
const applicationIcon = path.join(__dirname, '..', 'assets', 'app-icon.png');
const { pathToFileURL } = require('node:url');
const {
  buildSafeExternalNewspaperUrl,
  buildNewspaperSourceUrl,
  isAllowedNewspaperSourceUrl,
  isAllowedNewspaperUrl,
  isAllowedResearchUrl,
  listNewspaperSources,
  recommendIssueSources,
} = require('./engine-registry.cjs');
const { createIssueReelStore, registerIssueReelScheme } = require('./issue-reels.cjs');

const ISSUE_REEL_SCHEME = 'microfiche-reel';
const ISSUE_REEL_PROGRESS_CHANNEL = 'microfiche-reel-progress';
const NEWSSTAND_VIEW_STATE_CHANNEL = 'microfiche-newsstand-view-state';
const MAX_REEL_PAGES = 500;
const NEWSPAPERS_PARTITION = 'persist:foxtail-newspapers';
const NEWSSTAND_MEMORY_PARTITION_PREFIX = 'foxtail-newsstand-';
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const REEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const PROGRESS_MESSAGES = Object.freeze({
  preparing: 'Preparing the local reel library…',
  validating: 'Checking the selected issue…',
  copying: 'Making a protected working copy…',
  rendering: 'Rendering issue pages…',
  normalizing: 'Preparing consistent page images…',
  extracting: 'Extracting searchable text…',
  indexing: 'Building the reel index…',
  finalizing: 'Saving the issue reel…',
  complete: 'Issue reel ready.',
});
const PUBLIC_IMPORT_ERRORS = Object.freeze({
  CORRUPT_DOCUMENT: 'That document could not be read as a newspaper issue.',
  CONVERSION_FAILED: 'That issue could not be converted safely. The original file was not changed.',
  ENCRYPTED_PDF: 'Encrypted PDFs cannot be imported. Save an unlocked copy and try again.',
  FILE_TOO_LARGE: 'That selection is larger than the Issue Reel import limit.',
  IMPORT_BUSY: 'Another issue is already being imported.',
  INVALID_METADATA: 'Add a publication and valid issue date before importing.',
  INVALID_SELECTION: 'Choose one PDF or an ordered group of JPEG or PNG page images.',
  IMPORT_FAILED: 'The issue reel could not be completed. The original file was not changed.',
  STORAGE_FULL: 'There is not enough free space to finish this issue reel.',
  TOO_MANY_PAGES: `Issue reels can contain at most ${MAX_REEL_PAGES} pages.`,
  UNSUPPORTED_FORMAT: 'Issue Reel accepts PDF, JPEG, and PNG files only.',
});

// Privileged custom schemes must be registered before Electron becomes ready.
registerIssueReelScheme(protocol);

const productionEntry = path.join(__dirname, '..', 'dist', 'index.html');
const productionUrl = pathToFileURL(productionEntry).href;
const devServerUrl = normalizeDevServerUrl(process.env.VITE_DEV_SERVER_URL);
const devServerOrigin = devServerUrl ? new URL(devServerUrl).origin : null;

let mainWindow = null;
let issueReelStore = null;
let ipcHandlersRegistered = false;
let importInFlight = false;
let newsstandView = null;
let newsstandViewPartition = null;
let newsstandViewSourceId = null;
let activeNewsstandSession = null;
let newsstandVisible = false;
const preparedNewsstandPartitions = new Set();

function normalizeDevServerUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const localHost = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    if (url.protocol !== 'http:' || !localHost || url.username || url.password || url.search || url.hash) {
      return null;
    }
    return `${url.origin}/`;
  } catch {
    return null;
  }
}

function isTrustedRendererUrl(value) {
  if (devServerOrigin) {
    try {
      return new URL(value).origin === devServerOrigin;
    } catch {
      return false;
    }
  }
  return value === productionUrl;
}

function assertTrusted(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  const frame = event.senderFrame;
  if (
    !mainWindow
    || mainWindow.isDestroyed()
    || win !== mainWindow
    || event.sender !== mainWindow.webContents
    || !frame
    || frame !== event.sender.mainFrame
    || !isTrustedRendererUrl(frame.url)
  ) {
    throw new Error('Microfiche rejected an untrusted renderer request.');
  }
  return win;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cleanMetadataText(value, label, maximum, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${label} is required.`);
    return undefined;
  }
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  const normalized = value.normalize('NFC').trim();
  if (!normalized || normalized.length > maximum || CONTROL_OR_BIDI.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function cleanIssueDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error('Issue date must use YYYY-MM-DD.');
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    year < 1000
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new Error('Issue date is not a real calendar date.');
  }
  return value;
}

function cleanSourceUrl(value) {
  const cleaned = cleanMetadataText(value, 'Source URL', 2048);
  if (cleaned === undefined) return undefined;
  if (!isAllowedNewspaperUrl(cleaned)) {
    throw new Error('Source URL must use a reviewed newspaper archive host.');
  }
  return new URL(cleaned).href;
}

function cleanStoredSourceUrl(value) {
  const cleaned = cleanMetadataText(value, 'Source URL', 2048);
  if (cleaned === undefined || !isAllowedNewspaperUrl(cleaned)) return undefined;
  return new URL(cleaned).href;
}

function sanitizeImportMetadata(value) {
  if (!isPlainObject(value)) throw new Error('Issue metadata must be a plain object.');
  const allowedKeys = new Set(['publication', 'issueDate', 'edition', 'location', 'sourceLabel', 'sourceUrl', 'rights']);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`Unexpected issue metadata field: ${key}`);
  }
  const metadata = {
    publication: cleanMetadataText(value.publication, 'Publication', 200, true),
    issueDate: cleanIssueDate(value.issueDate),
  };
  const optionalFields = [['edition', 120], ['location', 200], ['sourceLabel', 200], ['rights', 500]];
  for (const [key, limit] of optionalFields) {
    const cleaned = cleanMetadataText(value[key], key, limit);
    if (cleaned !== undefined) metadata[key] = cleaned;
  }
  const sourceUrl = cleanSourceUrl(value.sourceUrl);
  if (sourceUrl !== undefined) metadata.sourceUrl = sourceUrl;
  return Object.freeze(metadata);
}

function cleanPositiveInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Stored ${label} is invalid.`);
  }
  return value;
}

function cleanAssetUrl(value, label) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error(`Stored ${label} is invalid.`);
  try {
    const url = new URL(value);
    if (url.protocol !== `${ISSUE_REEL_SCHEME}:` || url.username || url.password || url.search || url.hash) {
      throw new Error(`Stored ${label} is invalid.`);
    }
    return url.href;
  } catch {
    throw new Error(`Stored ${label} is invalid.`);
  }
}

function sanitizeReelPage(value) {
  if (!isPlainObject(value)) throw new Error('Stored reel page is invalid.');
  const page = {
    number: cleanPositiveInteger(value.number, 'page number', MAX_REEL_PAGES),
    imageUrl: cleanAssetUrl(value.imageUrl, 'page URL'),
    thumbnailUrl: cleanAssetUrl(value.thumbnailUrl, 'thumbnail URL'),
  };
  if (typeof value.ocrText === 'string') page.ocrText = value.ocrText.slice(0, 500_000);
  if (['embedded', 'ocr', 'none'].includes(value.textSource)) page.textSource = value.textSource;
  if (typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/iu.test(value.sha256)) {
    page.sha256 = value.sha256.toLowerCase();
  }
  if (Number.isSafeInteger(value.width) && value.width > 0 && value.width <= 16_384) page.width = value.width;
  if (Number.isSafeInteger(value.height) && value.height > 0 && value.height <= 16_384) page.height = value.height;
  return Object.freeze(page);
}

function sanitizePublicReel(value, includePages) {
  if (!isPlainObject(value) || typeof value.id !== 'string' || !REEL_ID.test(value.id)) {
    throw new Error('Stored issue reel is invalid.');
  }
  const reel = {
    id: value.id.toLowerCase(),
    publication: cleanMetadataText(value.publication, 'publication', 200, true),
    issueDate: cleanIssueDate(value.issueDate),
    pageCount: cleanPositiveInteger(value.pageCount, 'page count', MAX_REEL_PAGES),
  };
  const optionalFields = [['edition', 120], ['location', 200], ['sourceLabel', 200], ['rights', 500]];
  for (const [key, limit] of optionalFields) {
    const cleaned = cleanMetadataText(value[key], key, limit);
    if (cleaned !== undefined) reel[key] = cleaned;
  }
  const sourceUrl = cleanStoredSourceUrl(value.sourceUrl);
  if (sourceUrl !== undefined) reel.sourceUrl = sourceUrl;
  if (typeof value.importedAt !== 'string' || Number.isNaN(Date.parse(value.importedAt))) {
    throw new Error('Stored import date is invalid.');
  }
  reel.importedAt = new Date(value.importedAt).toISOString();
  if (includePages) {
    if (!Array.isArray(value.pages) || value.pages.length !== reel.pageCount) {
      throw new Error('Stored reel page index is invalid.');
    }
    reel.pages = Object.freeze(value.pages.map(sanitizeReelPage));
  }
  return Object.freeze(reel);
}

function sanitizeProgress(value) {
  const candidate = isPlainObject(value) && typeof value.stage === 'string' ? value.stage.toLowerCase() : 'preparing';
  const stage = Object.hasOwn(PROGRESS_MESSAGES, candidate) ? candidate : 'preparing';
  const progress = { stage, message: PROGRESS_MESSAGES[stage] };
  if (isPlainObject(value) && Number.isSafeInteger(value.current) && value.current >= 0) {
    progress.current = Math.min(value.current, MAX_REEL_PAGES);
  }
  if (isPlainObject(value) && Number.isSafeInteger(value.total) && value.total >= 0) {
    progress.total = Math.min(value.total, MAX_REEL_PAGES);
  }
  return Object.freeze(progress);
}

function publicImportError(error) {
  if (error && typeof error.code === 'string' && Object.hasOwn(PUBLIC_IMPORT_ERRORS, error.code)) {
    return PUBLIC_IMPORT_ERRORS[error.code];
  }
  return 'The issue could not be imported. Your original file was not changed.';
}

function sendImportProgress(win, value) {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send(ISSUE_REEL_PROGRESS_CHANNEL, sanitizeProgress(value));
}

function denyRendererPermissions(targetSession) {
  targetSession.setPermissionCheckHandler(() => false);
  targetSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  if (typeof targetSession.setDevicePermissionHandler === 'function') {
    targetSession.setDevicePermissionHandler(() => false);
  }
}


function newsstandSessionPolicy(sourceId) {
  if (typeof sourceId !== 'string' || !/^[a-z0-9-]+$/u.test(sourceId)) {
    throw new Error('Microfiche rejected an invalid Newsstand source session.');
  }
  if (sourceId === 'newspapers-com') {
    return Object.freeze({
      partition: NEWSPAPERS_PARTITION,
      cacheMode: 'browser-managed-persistent',
    });
  }
  return Object.freeze({
    partition: `${NEWSSTAND_MEMORY_PARTITION_PREFIX}${sourceId}`,
    cacheMode: 'browser-managed-ephemeral',
  });
}

function getNewsstandSession(partition) {
  const targetSession = session.fromPartition(partition, { cache: true });
  if (!preparedNewsstandPartitions.has(partition)) {
    denyRendererPermissions(targetSession);
    preparedNewsstandPartitions.add(partition);
  }
  return targetSession;
}

function destroyNewsstandView(win, { deactivate = false } = {}) {
  const view = newsstandView;
  newsstandView = null;
  newsstandViewPartition = null;
  newsstandViewSourceId = null;
  newsstandVisible = false;
  if (deactivate) activeNewsstandSession = null;

  if (!view) return;
  const owner = win && !win.isDestroyed() ? win : mainWindow;
  if (owner && !owner.isDestroyed()) {
    try {
      owner.contentView.removeChildView(view);
    } catch {
      // The window may already have detached its content tree while closing.
    }
  }
  if (view.webContents && !view.webContents.isDestroyed()) {
    view.webContents.close();
  }
}

function cleanNewsstandViewBounds(value) {
  if (!isPlainObject(value)) throw new Error('Viewer bounds are invalid.');

  const bounds = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    if (!Number.isSafeInteger(value[key])) {
      throw new Error('Viewer bounds are invalid.');
    }
    bounds[key] = value[key];
  }

  if (
    bounds.x < 0
    || bounds.y < 0
    || bounds.width < 120
    || bounds.height < 120
    || bounds.width > 10_000
    || bounds.height > 10_000
  ) {
    throw new Error('Viewer bounds are outside the allowed range.');
  }

  return bounds;
}

function currentNewsstandDisplayUrl() {
  if (!activeNewsstandSession) return '';
  let current = activeNewsstandSession.targetUrl;
  if (
    newsstandView
    && newsstandView.webContents
    && !newsstandView.webContents.isDestroyed()
  ) {
    current = newsstandView.webContents.getURL() || current;
  }
  if (!isAllowedNewspaperSourceUrl(activeNewsstandSession.sourceId, current)) {
    current = activeNewsstandSession.targetUrl;
  }
  return new URL(current).origin;
}

function newsstandNavigationHistory(webContents) {
  return webContents.navigationHistory || webContents;
}

function allowedNewsstandHistoryTarget(history, offset) {
  if (
    !activeNewsstandSession
    || !history
    || typeof history.getActiveIndex !== 'function'
    || typeof history.getEntryAtIndex !== 'function'
  ) {
    return null;
  }
  try {
    const entry = history.getEntryAtIndex(history.getActiveIndex() + offset);
    if (
      !entry
      || typeof entry.url !== 'string'
      || !isAllowedNewspaperSourceUrl(activeNewsstandSession.sourceId, entry.url)
    ) {
      return null;
    }
    return entry.url;
  } catch {
    return null;
  }
}

function publicNewsstandState(additions = {}) {
  if (!activeNewsstandSession) {
    return Object.freeze({
      active: false,
      visible: false,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      ...additions,
    });
  }

  const usableView = (
    newsstandView
    && newsstandView.webContents
    && !newsstandView.webContents.isDestroyed()
  );
  const history = usableView ? newsstandNavigationHistory(newsstandView.webContents) : null;

  return Object.freeze({
    active: true,
    visible: newsstandVisible,
    sourceId: activeNewsstandSession.sourceId,
    sourceName: activeNewsstandSession.sourceName,
    access: activeNewsstandSession.access,
    displayUrl: currentNewsstandDisplayUrl(),
    mode: activeNewsstandSession.mode,
    cacheMode: activeNewsstandSession.cacheMode,
    loading: usableView ? newsstandView.webContents.isLoading() : false,
    canGoBack: Boolean(history && history.canGoBack() && allowedNewsstandHistoryTarget(history, -1)),
    canGoForward: Boolean(history && history.canGoForward() && allowedNewsstandHistoryTarget(history, 1)),
    ...additions,
  });
}

function publicNewsstandSession() {
  if (!activeNewsstandSession) throw new Error('Choose a Newsstand source first.');
  return Object.freeze({
    sourceId: activeNewsstandSession.sourceId,
    sourceName: activeNewsstandSession.sourceName,
    access: activeNewsstandSession.access,
    preparedQuery: activeNewsstandSession.preparedQuery,
    copiedQuery: activeNewsstandSession.copiedQuery,
    copiedContext: activeNewsstandSession.copiedContext,
    displayUrl: currentNewsstandDisplayUrl(),
    mode: activeNewsstandSession.mode,
    cacheMode: activeNewsstandSession.cacheMode,
  });
}

function sendNewsstandState(win, additions = {}) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send(NEWSSTAND_VIEW_STATE_CHANNEL, publicNewsstandState(additions));
}

function guardNewsstandNavigation(event, url, win) {
  if (
    activeNewsstandSession
    && isAllowedNewspaperSourceUrl(activeNewsstandSession.sourceId, url)
  ) {
    return;
  }
  event.preventDefault();
  sendNewsstandState(win, {
    blocked: true,
    message: 'Microfiche blocked a page outside this Newsstand source.',
  });
}

async function loadActiveNewsstandUrl(view, url, win) {
  if (
    view !== newsstandView
    || !view.webContents
    || view.webContents.isDestroyed()
    || !activeNewsstandSession
    || !isAllowedNewspaperSourceUrl(activeNewsstandSession.sourceId, url)
  ) {
    throw new Error('Microfiche blocked a page outside this Newsstand source.');
  }
  try {
    await view.webContents.loadURL(url);
  } catch {
    sendNewsstandState(win, {
      failed: true,
      message: 'This Newsstand source could not be loaded.',
    });
    throw new Error('This Newsstand source could not be loaded.');
  }
}

function ensureNewsstandView(win) {
  if (!activeNewsstandSession) throw new Error('Choose a Newsstand source first.');
  if (
    newsstandView
    && newsstandView.webContents
    && !newsstandView.webContents.isDestroyed()
    && newsstandViewPartition === activeNewsstandSession.partition
    && newsstandViewSourceId === activeNewsstandSession.sourceId
  ) {
    return newsstandView;
  }

  if (newsstandView) destroyNewsstandView(win);
  getNewsstandSession(activeNewsstandSession.partition);

  const view = new WebContentsView({
    webPreferences: {
      partition: activeNewsstandSession.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  newsstandView = view;
  newsstandViewPartition = activeNewsstandSession.partition;
  newsstandViewSourceId = activeNewsstandSession.sourceId;

  const webContents = view.webContents;
  view.setBackgroundColor('#090b0c');
  view.setVisible(false);
  webContents.setWindowOpenHandler(({ url }) => {
    if (
      newsstandView === view
      && activeNewsstandSession
      && isAllowedNewspaperSourceUrl(activeNewsstandSession.sourceId, url)
    ) {
      void loadActiveNewsstandUrl(view, url, win).catch(() => {});
    } else {
      sendNewsstandState(win, {
        blocked: true,
        message: 'Microfiche blocked a pop-up outside this Newsstand source.',
      });
    }
    return { action: 'deny' };
  });
  webContents.on('will-attach-webview', (event) => event.preventDefault());
  webContents.on('will-navigate', (event, url) => guardNewsstandNavigation(event, url, win));
  webContents.on('will-redirect', (event, url) => guardNewsstandNavigation(event, url, win));
  webContents.on('did-start-loading', () => sendNewsstandState(win));
  webContents.on('did-stop-loading', () => sendNewsstandState(win));
  webContents.on('did-navigate', () => sendNewsstandState(win));
  webContents.on('did-navigate-in-page', () => sendNewsstandState(win));
  webContents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    sendNewsstandState(win, {
      failed: true,
      message: 'This Newsstand source could not be loaded.',
    });
  });
  webContents.on('render-process-gone', () => {
    if (newsstandView !== view) return;
    newsstandVisible = false;
    sendNewsstandState(win, {
      failed: true,
      message: 'The Newsstand viewer stopped unexpectedly. Reopen the source to continue.',
    });
  });

  win.contentView.addChildView(view);

  return view;
}

async function activateNewsstandSource(win, sourceId, context) {
  const target = buildNewspaperSourceUrl(sourceId, context);
  const sessionPolicy = newsstandSessionPolicy(target.sourceId);
  if (target.copiedQuery) clipboard.writeText(target.clipboardText);

  // A source activation starts with a new WebContents/history boundary. The
  // provider partition survives according to its policy, but the old page does not.
  destroyNewsstandView(win, { deactivate: true });

  activeNewsstandSession = Object.freeze({
    sourceId: target.sourceId,
    sourceName: target.sourceName,
    access: target.access,
    preparedQuery: target.query,
    copiedQuery: target.copiedQuery,
    copiedContext: target.copiedContext,
    mode: target.mode,
    targetUrl: target.url,
    partition: sessionPolicy.partition,
    cacheMode: sessionPolicy.cacheMode,
  });

  const view = ensureNewsstandView(win);
  sendNewsstandState(win);
  void loadActiveNewsstandUrl(view, target.url, win).catch(() => {});
  return publicNewsstandSession();
}

async function controlNewsstandSource(win, action) {
  if (!['back', 'forward', 'reload', 'home', 'external'].includes(action)) {
    throw new Error('Unknown Newsstand viewer control.');
  }
  if (
    !activeNewsstandSession
    || !newsstandView
    || !newsstandView.webContents
    || newsstandView.webContents.isDestroyed()
  ) {
    throw new Error('Choose a Newsstand source first.');
  }

  const webContents = newsstandView.webContents;
  const history = newsstandNavigationHistory(webContents);

  if (action === 'back') {
    if (history.canGoBack()) {
      if (!allowedNewsstandHistoryTarget(history, -1)) {
        sendNewsstandState(win, {
          blocked: true,
          message: 'Microfiche blocked history from crossing into another Newsstand source.',
        });
        throw new Error('Microfiche blocked history from crossing into another Newsstand source.');
      }
      await Promise.resolve(history.goBack());
    }
  } else if (action === 'forward') {
    if (history.canGoForward()) {
      if (!allowedNewsstandHistoryTarget(history, 1)) {
        sendNewsstandState(win, {
          blocked: true,
          message: 'Microfiche blocked history from crossing into another Newsstand source.',
        });
        throw new Error('Microfiche blocked history from crossing into another Newsstand source.');
      }
      await Promise.resolve(history.goForward());
    }
  } else if (action === 'reload') {
    webContents.reload();
  } else if (action === 'home') {
    await loadActiveNewsstandUrl(newsstandView, activeNewsstandSession.targetUrl, win);
  } else {
    const currentUrl = webContents.getURL();
    const externalUrl = buildSafeExternalNewspaperUrl(activeNewsstandSession.sourceId, currentUrl);
    await shell.openExternal(externalUrl, { activate: true });
  }

  sendNewsstandState(win);
  return Object.freeze({ action, state: publicNewsstandState() });
}


function registerIpcHandlers() {
  if (ipcHandlersRegistered) return;
  ipcHandlersRegistered = true;

  ipcMain.handle('microfiche-engine-catalog', async (event) => {
    assertTrusted(event);
    return listNewspaperSources();
  });
  ipcMain.handle('microfiche-newsstand-activate', async (event, sourceId, context) => {
    const win = assertTrusted(event);
    return activateNewsstandSource(win, sourceId, context);
  });

  ipcMain.handle('microfiche-newsstand-show', async (event, boundsValue) => {
    const win = assertTrusted(event);
    if (!activeNewsstandSession) throw new Error('Choose a Newsstand source first.');
    const bounds = cleanNewsstandViewBounds(boundsValue);
    const view = ensureNewsstandView(win);
    view.setBounds(bounds);
    view.setVisible(true);
    newsstandVisible = true;
    win.contentView.addChildView(view);
    sendNewsstandState(win);
    return publicNewsstandState();
  });

  ipcMain.handle('microfiche-newsstand-hide', async (event) => {
    const win = assertTrusted(event);
    if (
      newsstandView
      && newsstandView.webContents
      && !newsstandView.webContents.isDestroyed()
    ) {
      newsstandView.setVisible(false);
    }
    newsstandVisible = false;
    sendNewsstandState(win);
    return publicNewsstandState();
  });

  ipcMain.handle('microfiche-newsstand-deactivate', async (event) => {
    const win = assertTrusted(event);
    destroyNewsstandView(win, { deactivate: true });
    sendNewsstandState(win);
    return publicNewsstandState();
  });

  ipcMain.handle('microfiche-newsstand-control', async (event, action) => {
    const win = assertTrusted(event);
    return controlNewsstandSource(win, action);
  });

  ipcMain.handle('microfiche-issue-routes', async (event, publication, issueDate) => {
    assertTrusted(event);
    return recommendIssueSources(publication, issueDate);
  });
  ipcMain.handle('microfiche-open-result', async (event, url) => {
    assertTrusted(event);
    if (!isAllowedResearchUrl(url) && !isAllowedNewspaperUrl(url)) throw new Error('Microfiche blocked an unapproved result URL.');
    await shell.openExternal(url, { activate: true });
    return { opened: true };
  });
  ipcMain.handle('microfiche-copy-text', async (event, value) => {
    assertTrusted(event);
    const safeText = cleanMetadataText(value, 'Clipboard text', 4096, true);
    clipboard.writeText(safeText);
    return { copied: true };
  });
  ipcMain.handle('microfiche-reel-list', async (event) => {
    assertTrusted(event);
    try {
      const reels = await issueReelStore.list();
      if (!Array.isArray(reels)) throw new Error('Invalid reel index.');
      return Object.freeze(reels.map((reel) => sanitizePublicReel(reel, false)));
    } catch {
      throw new Error('The local reel library could not be read.');
    }
  });
  ipcMain.handle('microfiche-reel-get', async (event, id) => {
    assertTrusted(event);
    if (typeof id !== 'string' || !REEL_ID.test(id)) throw new Error('That issue reel ID is invalid.');
    try {
      return sanitizePublicReel(await issueReelStore.get(id.toLowerCase()), true);
    } catch {
      throw new Error('That issue reel could not be opened.');
    }
  });
  ipcMain.handle('microfiche-reel-import', async (event, untrustedMetadata) => {
    const win = assertTrusted(event);
    const metadata = sanitizeImportMetadata(untrustedMetadata);
    if (importInFlight) throw new Error(PUBLIC_IMPORT_ERRORS.IMPORT_BUSY);
    importInFlight = true;
    try {
      const selection = await dialog.showOpenDialog(win, {
        title: 'Import a newspaper issue',
        buttonLabel: 'Build Issue Reel',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Issue files', extensions: ['pdf', 'jpg', 'jpeg', 'png'] },
          { name: 'PDF issues', extensions: ['pdf'] },
          { name: 'Page images', extensions: ['jpg', 'jpeg', 'png'] },
        ],
      });
      if (selection.canceled || selection.filePaths.length === 0) return Object.freeze({ canceled: true });

      sendImportProgress(win, { stage: 'preparing' });
      const imported = await issueReelStore.importFiles({
        metadata,
        filePaths: Object.freeze([...selection.filePaths]),
        onProgress: (progress) => sendImportProgress(win, progress),
      });
      const reel = imported && isPlainObject(imported) && imported.reel ? imported.reel : imported;
      return Object.freeze({ canceled: false, reel: sanitizePublicReel(reel, true) });
    } catch (error) {
      throw new Error(publicImportError(error));
    } finally {
      importInFlight = false;
    }
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1680,
    height: 980,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: '#090b0c',
    title: 'Foxtail Microfiche',
    icon: applicationIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  mainWindow = win;

  win.on('closed', () => {
    destroyNewsstandView(win, { deactivate: true });
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.on('will-navigate', (event, url) => {
    if (isTrustedRendererUrl(url)) return;
    event.preventDefault();
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  if (devServerUrl) win.loadURL(devServerUrl);
  else win.loadFile(productionEntry);
}

async function handleIssueReelRequest(request) {
  if (request.method !== 'GET') {
    return new Response(null, { status: 405, headers: { Allow: 'GET', 'Cache-Control': 'no-store' } });
  }
  try {
    return await issueReelStore.handleMediaRequest(request);
  } catch {
    return new Response(null, {
      status: 404,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
}

app.whenReady().then(async () => {
  denyRendererPermissions(session.defaultSession);
  issueReelStore = await createIssueReelStore({ userDataPath: app.getPath('userData') });
  await protocol.handle(ISSUE_REEL_SCHEME, handleIssueReelRequest);
  registerIpcHandlers();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error) => {
  console.error('Foxtail Microfiche could not initialize its local reel library.', error);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
