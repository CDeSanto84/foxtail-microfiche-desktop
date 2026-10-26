'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const {
  NEWSPAPER_SOURCES,
  SHELVES,
  buildSafeExternalNewspaperUrl,
  buildNewspaperSourceUrl,
  isAllowedNewspaperUrl,
  isAllowedNewspaperSourceUrl,
  isAllowedResearchUrl,
  listNewspaperSources,
  normalizeHandoffContext,
  recommendIssueSources,
} = require('../electron/engine-registry.cjs');

assert.equal(NEWSPAPER_SOURCES.length, 49, 'the reviewed v0.2.1 catalog must contain 49 sources');
assert.equal(SHELVES.length, 6, 'the catalog must retain all six research shelves');
assert.equal(new Set(NEWSPAPER_SOURCES.map((item) => item.id)).size, NEWSPAPER_SOURCES.length, 'source IDs must be unique');
assert.equal(NEWSPAPER_SOURCES.filter((item) => item.mode === 'federated').length, 3, 'exactly three sources are live adapters in v0.2.1');

for (const shelf of SHELVES) {
  assert(NEWSPAPER_SOURCES.some((item) => item.shelf === shelf), `${shelf} must not be empty`);
}

const probe = 'Hindenburg & Lakehurst / 1937';
for (const item of NEWSPAPER_SOURCES) {
  assert(SHELVES.includes(item.shelf), `${item.id} has an unknown shelf`);
  assert(['federated', 'handoff'].includes(item.mode), `${item.id} has an invalid mode`);
  assert(['standard', 'authenticated'].includes(item.providerView), `${item.id} has an invalid provider view`);
  assert(item.hosts.length > 0, `${item.id} needs an exact host allowlist`);
  const built = buildNewspaperSourceUrl(item.id, probe);
  const url = new URL(built.url);
  assert.equal(url.protocol, 'https:', `${item.id} must use HTTPS`);
  assert(item.hosts.includes(url.hostname), `${item.id} escaped its host allowlist`);
  assert.equal(built.copiedQuery, item.homeOnly, `${item.id} has the wrong handoff behavior`);
  if (!item.homeOnly) assert(built.url.includes('Hindenburg'), `${item.id} did not prepare the query`);
}

// Opening Newspapers.com without keywords is browsing, not a failed search.
for (const query of ['', '   ', '\t\n']) {
  const homepage = buildNewspaperSourceUrl('newspapers-com', { mode: 'articles', query });
  assert.equal(homepage.url, 'https://www.newspapers.com/');
  assert.equal(homepage.query, '');
  assert.equal(homepage.copiedQuery, false);
  assert.equal(homepage.providerView, 'authenticated');
}
assert.equal(buildNewspaperSourceUrl('newspapers-com', '').url, 'https://www.newspapers.com/');
assert.equal(new URL(buildNewspaperSourceUrl('newspapers-com', { mode: 'articles', query: probe }).url).searchParams.get('keyword'), probe);
assert.throws(() => buildNewspaperSourceUrl('newspapers-com', { mode: 'articles', query: {} }));
assert.throws(() => buildNewspaperSourceUrl('newspapers-com', { mode: 'articles', query: 'x'.repeat(501) }));
assert.throws(() => buildNewspaperSourceUrl('newspapers-com', { mode: 'exact', publication: '', issueDate: '' }));
assert.throws(() => buildNewspaperSourceUrl('internet-archive-newspapers', { mode: 'articles', query: '' }));
assert.throws(() => normalizeHandoffContext({ mode: 'articles', query: '' }));

const legacyHomeHandoff = buildNewspaperSourceUrl('google-news-archive', probe);
assert.equal(legacyHomeHandoff.clipboardText, probe, 'legacy string handoffs must retain clipboard text');

const publicCatalog = listNewspaperSources();
assert.equal(publicCatalog.sources.length, NEWSPAPER_SOURCES.length);
for (const item of publicCatalog.sources) {
  assert.equal('template' in item, false, 'URL templates must remain in the trusted main process');
  assert.equal('hosts' in item, false, 'host allowlists must remain in the trusted main process');
  assert.equal('allowedHosts' in item, false, 'resolved host policies must remain in the trusted main process');
}

const sourceById = new Map(NEWSPAPER_SOURCES.map((item) => [item.id, item]));
const officialInquirer = sourceById.get('philadelphia-inquirer-archive');
const libraryInquirer = sourceById.get('free-library-inquirer');
const newspapersCom = sourceById.get('newspapers-com');
assert(officialInquirer, 'the official Philadelphia Inquirer archive card must be present');
assert(libraryInquirer, 'the Free Library Inquirer archive card must be present');
assert(newspapersCom, 'the authenticated Newspapers.com provider card must be present');
assert.equal(officialInquirer.access, 'PAID');
assert.equal(libraryInquirer.access, 'LIBRARY');
assert.match(officialInquirer.description, /official archive page.+1860 to today.+paid archive subscription/i);
assert.match(libraryInquirer.description, /Free Library.+1860–2001.+Free Library card/i);
assert.equal(newspapersCom.providerView, 'authenticated');
assert(newspapersCom.features.includes('AUTHENTICATED VIEW'));

const exactContext = normalizeHandoffContext({
  mode: 'exact',
  query: 'The Philadelphia Inquirer',
  publication: 'The Philadelphia Inquirer',
  issueDate: '1984-03-10',
});
assert.equal(exactContext.mode, 'exact');
assert.equal(exactContext.query, 'The Philadelphia Inquirer · Mar 10, 1984');
assert.equal(exactContext.clipboardText, 'Publication: The Philadelphia Inquirer\nIssue date: Mar 10, 1984');

const libraryHandoff = buildNewspaperSourceUrl('free-library-inquirer', {
  mode: 'exact',
  query: '',
  publication: 'Philadelphia Inquirer',
  issueDate: '1984-03-10',
});
assert.equal(libraryHandoff.url, 'https://libwww.freelibrary.org/elecres/inquirerarchive.cfm');
assert.equal(libraryHandoff.copiedQuery, true);
assert.equal(libraryHandoff.copiedContext, true);
assert.equal(libraryHandoff.clipboardText, 'Publication: Philadelphia Inquirer\nIssue date: Mar 10, 1984');

const inquirer1984 = recommendIssueSources('The Philadelphia Inquirer', '1984-03-10');
assert.equal(inquirer1984.match, 'exact');
assert.deepEqual(
  inquirer1984.routes.map((item) => item.id),
  ['free-library-inquirer', 'philadelphia-inquirer-archive', 'newspapers-com'],
  '1984 must route to both verified Inquirer doors and the coverage-unconfirmed paid lead',
);
assert.deepEqual(
  inquirer1984.routes.map((item) => item.routeKind),
  ['coverage', 'coverage', 'lead'],
  'exact coverage and unconfirmed leads must be distinguished',
);

const inquirer2002 = recommendIssueSources('Philadelphia Inquirer', '2002-01-01');
assert.equal(inquirer2002.match, 'exact');
assert.deepEqual(
  inquirer2002.routes.map((item) => item.id),
  ['philadelphia-inquirer-archive', 'newspapers-com'],
  '2002 must exclude the Free Library 1860–2001 collection while retaining the paid lead',
);

const inquirerStart = recommendIssueSources('Philadelphia Inquirer', '1860-01-01');
assert.deepEqual(
  inquirerStart.routes.map((item) => item.id),
  ['free-library-inquirer', 'philadelphia-inquirer-archive', 'newspapers-com'],
  'the shared 1860 lower bound must be inclusive',
);
const libraryEnd = recommendIssueSources('Philadelphia Inquirer', '2001-12-31');
assert(libraryEnd.routes.some((item) => item.id === 'free-library-inquirer'), 'the Free Library 2001 upper bound must be inclusive');

const leapDay = recommendIssueSources('Philadelphia Inquirer', '1984-02-29');
assert.equal(leapDay.match, 'exact', 'valid leap days must be accepted');

const inquirer1859 = recommendIssueSources('Philadelphia Inquirer', '1859-12-31');
assert.equal(inquirer1859.match, 'fallback');
assert.equal(inquirer1859.routes.some((item) => item.id === 'philadelphia-inquirer-archive'), false);
assert.equal(inquirer1859.routes.some((item) => item.id === 'free-library-inquirer'), false);
assert(inquirer1859.routes.every((item) => item.routeKind === 'lead'));

const cincinnati = recommendIssueSources('The Cincinnati Enquirer', '1984-03-10');
assert.equal(cincinnati.match, 'fallback', 'partial title matches must not claim Philadelphia coverage');
assert.equal(cincinnati.routes.some((item) => item.id === 'philadelphia-inquirer-archive'), false);
assert.equal(cincinnati.routes.some((item) => item.id === 'free-library-inquirer'), false);

const inquirerAlias = recommendIssueSources('Inquirer', '1984-03-10');
assert.equal(inquirerAlias.match, 'exact', 'the explicit one-word alias should still work when entered exactly');

const paidInquirer = buildNewspaperSourceUrl('newspapers-com', {
  mode: 'exact',
  query: '',
  publication: 'The Philadelphia Inquirer',
  issueDate: '1984-03-10',
});
const paidInquirerUrl = new URL(paidInquirer.url);
assert.equal(paidInquirerUrl.origin, 'https://www.newspapers.com');
assert.equal(paidInquirerUrl.pathname, '/search/results/');
assert.equal(paidInquirerUrl.searchParams.get('date'), '1984-03-10');
assert.equal(paidInquirerUrl.searchParams.get('publication-ids'), '4352');
assert.equal(paidInquirerUrl.searchParams.has('keyword'), false);
assert.equal(paidInquirer.providerView, 'authenticated');

const genericPaidIssue = buildNewspaperSourceUrl('newspapers-com', {
  mode: 'exact',
  query: 'front page',
  publication: 'The Cincinnati Enquirer',
  issueDate: '1984-03-10',
});
const genericPaidUrl = new URL(genericPaidIssue.url);
assert.equal(genericPaidUrl.searchParams.get('date'), '1984-03-10');
assert.equal(genericPaidUrl.searchParams.has('publication-ids'), false);
assert.equal(genericPaidUrl.searchParams.get('keyword'), 'The Cincinnati Enquirer front page');
assert.equal(genericPaidUrl.pathname.startsWith('/api/'), false, 'the viewer must not call private JSON endpoints');
assert(isAllowedNewspaperSourceUrl('newspapers-com', genericPaidUrl.href));
assert.equal(isAllowedNewspaperSourceUrl('newspapers-com', 'https://archive.org/details/example'), false);
assert.equal(isAllowedNewspaperSourceUrl('internet-archive-newspapers', genericPaidUrl.href), false);
assert.equal(isAllowedNewspaperSourceUrl('newspapers-com', 'https://www.newspapers.com:8443/search/results/'), false);

const safeExternal = buildSafeExternalNewspaperUrl(
  'newspapers-com',
  'https://www.newspapers.com/search/results/?date=1984-03-10&token=secret&view=grid#account-code',
);
const safeExternalUrl = new URL(safeExternal);
assert.equal(safeExternalUrl.searchParams.get('date'), '1984-03-10');
assert.equal(safeExternalUrl.searchParams.get('view'), 'grid');
assert.equal(safeExternalUrl.searchParams.has('token'), false);
assert.equal(safeExternalUrl.hash, '');
assert.throws(
  () => buildSafeExternalNewspaperUrl('newspapers-com', 'https://archive.org/details/example'),
  /not safe to open externally/i,
);

for (const invalidDate of ['1984-02-30', '1984-13-01', '1984-00-01', '06/16/1984', '', null, 19840616]) {
  assert.throws(() => recommendIssueSources('Philadelphia Inquirer', invalidDate), /valid issue date/i);
}
assert.throws(() => recommendIssueSources('', '1984-06-16'), /publication title/i);
assert.throws(
  () => normalizeHandoffContext({ mode: 'exact', publication: 'Philadelphia Inquirer', issueDate: '1984-03-10', query: {} }),
  /queries must be text/i,
);
assert.throws(() => normalizeHandoffContext({ mode: 'surprise', query: 'test' }), /unknown newspaper research mode/i);
assert.throws(() => normalizeHandoffContext([]), /invalid handoff request/i);

assert(isAllowedResearchUrl('https://www.loc.gov/resource/sn83045462/1937-05-07/ed-1/?sp=1'));
assert(isAllowedResearchUrl('https://archive.org/details/example'));
assert(isAllowedResearchUrl('https://paperspast.natlib.govt.nz/newspapers/TEST19370507.2.1'));
assert(isAllowedResearchUrl('https://digitalnz.org/records/123'));
assert.equal(isAllowedResearchUrl('http://archive.org/details/example'), false);
assert.equal(isAllowedResearchUrl('https://archive.org.evil.example/details/example'), false);
assert.equal(isAllowedResearchUrl('https://attacker.example/?next=https://digitalnz.org/records/123'), false);
assert.equal(isAllowedResearchUrl('https://user:pass@archive.org/details/example'), false);
assert.equal(isAllowedResearchUrl('not a url'), false);
assert(isAllowedNewspaperUrl('https://www.inquirer.com/archives/'));
assert(isAllowedNewspaperUrl('https://libwww.freelibrary.org/elecres/inquirerarchive.cfm'));
assert.equal(isAllowedNewspaperUrl('https://www.inquirer.com.evil.example/archives/'), false);
assert.equal(isAllowedNewspaperUrl('http://www.inquirer.com/archives/'), false);
assert.equal(NEWSPAPER_SOURCES.some((item) => /newspaper navigator/i.test(item.name)), false, 'retired Newspaper Navigator must not be active');

const mainSource = readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
const preloadSource = readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8');
assert.equal(mainSource.includes('/api/title/query'), false, 'private Newspapers.com title enumeration must remain removed');
assert.equal(mainSource.includes('/api/search/query'), false, 'private Newspapers.com result enumeration must remain removed');
assert.equal(mainSource.includes('session.fetch'), false, 'the Newsstand viewer must use provider pages, not private JSON fetches');
assert.equal(mainSource.includes('microfiche-newspapers-view'), false, 'raw Newspapers.com page URL IPC must remain removed');
assert(mainSource.includes("'persist:foxtail-newspapers'"), 'the paid-provider sign-in and cache partition must remain persistent');
assert.match(mainSource, /fromPartition\(partition, \{ cache: true \}\)/u);
assert(mainSource.includes("NEWSSTAND_MEMORY_PARTITION_PREFIX = 'foxtail-newsstand-'"), 'non-paid sources need isolated ephemeral partitions');
assert(mainSource.includes("ipcMain.handle('microfiche-newsstand-deactivate'"), 'Close must destroy the remote view');
assert(mainSource.includes('destroyNewsstandView(win, { deactivate: true })'), 'deactivation must clear the active remote session');
assert(mainSource.includes('buildSafeExternalNewspaperUrl(activeNewsstandSession.sourceId, currentUrl)'), 'external handoff must remove credential-shaped URL data');
assert.match(mainSource, /contextIsolation: true[\s\S]+nodeIntegration: false[\s\S]+sandbox: true/u);
assert.match(mainSource, /setWindowOpenHandler[\s\S]+return \{ action: 'deny' \}/u, 'Newsstand pop-ups must never create a raw child window');
assert(mainSource.includes('isAllowedNewspaperSourceUrl(activeNewsstandSession.sourceId, url)'), 'navigation must remain scoped to the active source');
assert(mainSource.includes("NEWSSTAND_VIEW_STATE_CHANNEL = 'microfiche-newsstand-view-state'"));
for (const method of ['activateNewsstandSource', 'showNewsstandSource', 'hideNewsstandSource', 'deactivateNewsstandSource', 'controlNewsstandSource', 'onNewsstandViewState']) {
  assert(preloadSource.includes(method), `${method} must be exposed through the narrow preload bridge`);
}
for (const removedMethod of ['getNewspapersIssue', 'showNewspapersPage', 'hideNewspapersPage']) {
  assert.equal(preloadSource.includes(removedMethod), false, `${removedMethod} must remain removed from the renderer bridge`);
}

console.log(`Engine registry smoke passed: ${NEWSPAPER_SOURCES.length} sources across ${SHELVES.length} shelves.`);
