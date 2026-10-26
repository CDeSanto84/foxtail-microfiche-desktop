'use strict';

function source(definition) {
  return Object.freeze({
    mode: 'handoff',
    access: 'FREE',
    era: 'HISTORIC',
    features: [],
    aliases: [],
    issueBrowse: false,
    coverageStart: null,
    coverageEnd: null,
    homeOnly: false,
    providerView: 'standard',
    ...definition,
    features: Object.freeze([...(definition.features || [])]),
    aliases: Object.freeze([...(definition.aliases || [])]),
    hosts: Object.freeze([...(definition.hosts || [])]),
  });
}

const SHELVES = Object.freeze([
  "Today's Wire",
  'The Morgue',
  'Local Desk',
  'World Desk',
  'OCR Cabinet',
  'Library Card',
]);

const NEWSPAPER_SOURCES = Object.freeze([
  source({ id: 'google-news', name: 'Google News', shelf: "Today's Wire", era: 'CURRENT', description: 'Broad current-news discovery across publishers.', features: ['DIRECT SEARCH', 'NEWS'], template: 'https://news.google.com/search?q={query}', hosts: ['news.google.com'] }),
  source({ id: 'bing-news', name: 'Bing News', shelf: "Today's Wire", era: 'CURRENT', description: 'Alternative current-news index with source and locality context.', features: ['DIRECT SEARCH', 'NEWS'], template: 'https://www.bing.com/news/search?q={query}', hosts: ['www.bing.com'] }),
  source({ id: 'gdelt-doc', name: 'GDELT DOC 2.0', shelf: "Today's Wire", era: 'CURRENT', description: 'Recent global reporting and cross-language discovery.', features: ['PUBLIC API', 'GLOBAL'], template: 'https://api.gdeltproject.org/api/v2/doc/doc?query={query}&mode=artlist&format=html&maxrecords=75&sort=hybridrel', hosts: ['api.gdeltproject.org'] }),
  source({ id: 'fact-check-explorer', name: 'Fact Check Explorer', shelf: "Today's Wire", era: 'CURRENT', description: 'Published ClaimReview records and fact-check discovery.', features: ['DIRECT SEARCH', 'CLAIMS'], template: 'https://toolbox.google.com/factcheck/explorer/search/{query};hl=en', hosts: ['toolbox.google.com'] }),

  source({ id: 'loc-chronicling-america', adapterSlug: 'loc-chronicling-america', mode: 'federated', name: 'Chronicling America', shelf: 'The Morgue', description: 'Library of Congress historic American newspaper pages.', features: ['LIVE API', 'OCR', 'PAGE IMAGE'], template: 'https://www.loc.gov/collections/chronicling-america/?q={query}', hosts: ['www.loc.gov'] }),
  source({ id: 'loc-newspaper-directory', name: 'U.S. Newspaper Directory', shelf: 'The Morgue', description: 'Find titles, publication history, and library holdings since 1690.', features: ['HOLDINGS', 'METADATA'], template: 'https://www.loc.gov/collections/directory-of-us-newspapers-in-american-libraries/?q={query}', hosts: ['www.loc.gov'] }),
  source({ id: 'internet-archive-newspapers', adapterSlug: 'internet-archive-newspapers', mode: 'federated', name: 'Internet Archive Newspapers', shelf: 'The Morgue', region: 'Global', description: 'Scans, OCR, microfilm, and miscellaneous newspaper runs.', features: ['LIVE API', 'SCANS', 'OCR'], template: 'https://archive.org/advancedsearch.php?q={query}', hosts: ['archive.org'] }),
  source({ id: 'google-news-archive', name: 'Google News Archive', shelf: 'The Morgue', access: 'LEGACY', description: 'Legacy browse-only newspaper collection; the scanning project is discontinued.', features: ['BROWSE', 'PAGE IMAGE'], homeOnly: true, template: 'https://news.google.com/newspapers', hosts: ['news.google.com'] }),
  source({ id: 'fulton-search', name: 'Fulton Search', shelf: 'The Morgue', description: 'Valuable New York-heavy newspaper index; availability can be intermittent.', features: ['OCR', 'HANDOFF'], homeOnly: true, template: 'https://fultonsearch.org/', hosts: ['fultonsearch.org'] }),

  source({ id: 'florida-newspapers', name: 'Florida Digital Newspaper Library', shelf: 'Local Desk', region: 'Florida', description: 'Historic and born-digital Florida newspaper collections.', features: ['OCR', 'PAGE IMAGE'], homeOnly: true, template: 'https://ufdc.ufl.edu/collections/fdnl', hosts: ['ufdc.ufl.edu'] }),
  source({ id: 'georgia-newspapers', name: 'Georgia Historic Newspapers', shelf: 'Local Desk', region: 'Georgia', description: 'Statewide Georgia newspapers with community and special-interest collections.', features: ['OCR', 'PAGE IMAGE'], homeOnly: true, template: 'https://gahistoricnewspapers.galileo.usg.edu/', hosts: ['gahistoricnewspapers.galileo.usg.edu'] }),
  source({ id: 'texas-newspapers', name: 'Texas Digital Newspaper Program', shelf: 'Local Desk', region: 'Texas', description: 'Extensive city, county, and multilingual Texas coverage.', features: ['OCR', 'PAGE IMAGE'], homeOnly: true, template: 'https://texashistory.unt.edu/explore/collections/TDNP/', hosts: ['texashistory.unt.edu'] }),
  source({ id: 'north-carolina-newspapers', name: 'North Carolina Newspapers', shelf: 'Local Desk', region: 'North Carolina', description: 'Free statewide heritage newspaper collection.', features: ['OCR', 'PAGE IMAGE'], homeOnly: true, template: 'https://www.digitalnc.org/newspapers/', hosts: ['www.digitalnc.org'] }),
  source({ id: 'california-newspapers', name: 'California Digital Newspaper Collection', shelf: 'Local Desk', region: 'California', description: 'Digitized historic newspapers from across California.', features: ['OCR', 'PAGE IMAGE'], homeOnly: true, template: 'https://cdnc.ucr.edu/', hosts: ['cdnc.ucr.edu'] }),
  source({ id: 'new-york-newspapers', name: 'NYS Historic Newspapers', shelf: 'Local Desk', region: 'New York', description: 'Regional and local newspapers from New York State.', features: ['OCR', 'PAGE IMAGE'], homeOnly: true, template: 'https://nyshistoricnewspapers.org/', hosts: ['nyshistoricnewspapers.org'] }),
  source({ id: 'colorado-newspapers', name: 'Colorado Historic Newspapers', shelf: 'Local Desk', region: 'Colorado', description: 'Free statewide Colorado newspaper collection.', features: ['OCR', 'PAGE IMAGE'], homeOnly: true, template: 'https://www.coloradohistoricnewspapers.org/', hosts: ['www.coloradohistoricnewspapers.org'] }),

  source({ id: 'digitalnz-papers-past', adapterSlug: 'digitalnz-papers-past', mode: 'federated', name: 'DigitalNZ · Papers Past', shelf: 'World Desk', region: 'New Zealand & Pacific', description: 'New Zealand and Pacific newspaper articles through DigitalNZ.', features: ['LIVE API', 'OCR', 'ARTICLES'], template: 'https://paperspast.natlib.govt.nz/newspapers?query={query}', hosts: ['paperspast.natlib.govt.nz'] }),
  source({ id: 'europeana-newspapers', name: 'Europeana Newspapers', shelf: 'World Desk', region: 'Europe', description: 'Europe-wide newspaper discovery with institution-level rights.', features: ['OCR', 'METADATA'], template: 'https://www.europeana.eu/en/search?query={query}&theme=newspapers', hosts: ['www.europeana.eu'] }),
  source({ id: 'trove-newspapers', name: 'Trove Newspapers & Gazettes', shelf: 'World Desk', region: 'Australia', description: 'Australian national newspaper archive and community corrections.', features: ['OCR', 'PAGE IMAGE'], template: 'https://trove.nla.gov.au/search/category/newspapers?keyword={query}', hosts: ['trove.nla.gov.au'] }),
  source({ id: 'papers-past', name: 'Papers Past', shelf: 'World Desk', region: 'New Zealand & Pacific', description: 'New Zealand and Pacific newspapers by title, region, date, and language.', features: ['OCR', 'PAGE IMAGE'], template: 'https://paperspast.natlib.govt.nz/newspapers?query={query}', hosts: ['paperspast.natlib.govt.nz'] }),
  source({ id: 'welsh-newspapers', name: 'Welsh Newspapers', shelf: 'World Desk', region: 'Wales', description: 'Welsh and English-language historic newspapers.', features: ['OCR', 'PAGE IMAGE'], homeOnly: true, template: 'https://newspapers.library.wales/', hosts: ['newspapers.library.wales'] }),
  source({ id: 'gallica-press', name: 'Gallica Press', shelf: 'World Desk', region: 'France', description: 'BnF national, local, and regional French press.', features: ['OCR', 'PAGE IMAGE'], homeOnly: true, template: 'https://gallica.bnf.fr/selections/fr/html/presse-et-revues/presse-locale-et-regionale', hosts: ['gallica.bnf.fr'] }),
  source({ id: 'delpher', name: 'Delpher', shelf: 'World Desk', region: 'Netherlands', description: 'Major Dutch newspaper, book, and periodical search.', features: ['OCR', 'PAGE IMAGE'], template: 'https://www.delpher.nl/nl/kranten/results?query={query}', hosts: ['www.delpher.nl'] }),
  source({ id: 'german-newspaper-portal', name: 'German Newspaper Portal', shelf: 'World Desk', region: 'Germany', description: 'Historic German newspapers through Deutsche Digitale Bibliothek.', features: ['OCR', 'PAGE IMAGE'], template: 'https://www.deutsche-digitale-bibliothek.de/newspaper?query={query}', hosts: ['www.deutsche-digitale-bibliothek.de'] }),
  source({ id: 'bne-hemeroteca', name: 'BNE Hemeroteca Digital', shelf: 'World Desk', region: 'Spain', description: 'Spanish National Library historic press archive.', features: ['OCR', 'PAGE IMAGE'], homeOnly: true, template: 'https://hemerotecadigital.bne.es/', hosts: ['hemerotecadigital.bne.es'] }),
  source({ id: 'brazil-hemeroteca', name: 'Brazilian Digital Newspaper Library', shelf: 'World Desk', region: 'Brazil', description: 'Biblioteca Nacional title, period, locality, and phrase search.', features: ['OCR', 'PAGE IMAGE'], homeOnly: true, template: 'https://memoria.bn.gov.br/hdb/DefaultNew.aspx', hosts: ['memoria.bn.gov.br'] }),
  source({ id: 'newspapersg', name: 'NewspaperSG', shelf: 'World Desk', region: 'Singapore & Malaya', access: 'MIXED', description: 'Singapore and Malaya newspapers with mixed open and library access.', features: ['OCR', 'PAGE IMAGE'], homeOnly: true, template: 'https://eresources.nlb.gov.sg/newspapers/', hosts: ['eresources.nlb.gov.sg'] }),
  source({ id: 'global-press-archive', name: 'Global Press Archive', shelf: 'World Desk', region: 'Global', access: 'MIXED', description: 'Non-Western and international collections with mixed open/institutional access.', features: ['OCR', 'PAGE IMAGE'], homeOnly: true, template: 'https://www.eastview.com/resources/gpa/', hosts: ['www.eastview.com'] }),
  source({ id: 'british-newspaper-archive', name: 'British Newspaper Archive', shelf: 'World Desk', region: 'United Kingdom', access: 'PAID', description: 'Search is free; most page access requires a subscription or library.', features: ['OCR', 'PAGE IMAGE'], template: 'https://www.britishnewspaperarchive.co.uk/search/results?basicsearch={query}', hosts: ['www.britishnewspaperarchive.co.uk'] }),
  source({ id: 'historical-jewish-press', name: 'Historical Jewish Press', shelf: 'World Desk', region: 'Global', description: 'National Library of Israel multilingual historic newspaper collection.', features: ['OCR', 'PAGE IMAGE'], homeOnly: true, template: 'https://www.nli.org.il/en/newspapers', hosts: ['www.nli.org.il'] }),
  source({ id: 'anno', name: 'ANNO', shelf: 'World Desk', region: 'Austria', description: 'Austrian National Library historic newspapers and periodicals.', features: ['OCR', 'PAGE IMAGE'], homeOnly: true, template: 'https://anno.onb.ac.at/', hosts: ['anno.onb.ac.at'] }),

  source({ id: 'hathitrust', name: 'HathiTrust Full Text', shelf: 'OCR Cabinet', region: 'Global', description: 'Search digitized text; view and download rights vary by item.', features: ['FULL TEXT', 'CATALOG'], template: 'https://babel.hathitrust.org/cgi/ls?q1={query}&field1=ocr&a=srchls', hosts: ['babel.hathitrust.org'] }),
  source({ id: 'worldcat', name: 'WorldCat', shelf: 'OCR Cabinet', region: 'Global', description: 'Locate newspaper microfilm, physical holdings, and related works.', features: ['HOLDINGS', 'CATALOG'], template: 'https://search.worldcat.org/search?q={query}', hosts: ['search.worldcat.org'] }),
  source({ id: 'dpla', name: 'Digital Public Library of America', shelf: 'OCR Cabinet', region: 'United States', description: 'U.S. archive aggregator linking to contributing institutions.', features: ['METADATA', 'COLLECTIONS'], template: 'https://dp.la/search?q={query}', hosts: ['dp.la'] }),
  source({ id: 'google-books', name: 'Google Books', shelf: 'OCR Cabinet', region: 'Global', access: 'MIXED', description: 'Search books, bound periodicals, directories, and newspaper-adjacent material.', features: ['FULL TEXT', 'SCANS'], template: 'https://books.google.com/books?q={query}', hosts: ['books.google.com'] }),
  source({ id: 'internet-archive-general', name: 'Internet Archive', shelf: 'OCR Cabinet', region: 'Global', description: 'Directories, yearbooks, pamphlets, books, and microfilm adjacent to newspaper research.', features: ['OCR', 'SCANS'], template: 'https://archive.org/search?query={query}', hosts: ['archive.org'] }),
  source({ id: 'wayback', name: 'Wayback Machine', shelf: 'OCR Cabinet', era: 'BOTH', region: 'Global', description: 'Recover vanished publisher pages and born-digital news.', features: ['WEB ARCHIVE', 'BROWSE'], homeOnly: true, template: 'https://web.archive.org/', hosts: ['web.archive.org'] }),

  source({ id: 'philadelphia-inquirer-archive', name: 'Philadelphia Inquirer Archive', shelf: 'Library Card', era: 'BOTH', region: 'Philadelphia, Pennsylvania', access: 'PAID', description: "The Inquirer's official archive page lists full-page image coverage from 1860 to today; image access requires a paid archive subscription.", features: ['EXACT ISSUE', 'PAGE IMAGE', '1860–TODAY'], aliases: ['philadelphia inquirer', 'the philadelphia inquirer', 'inquirer'], issueBrowse: true, coverageStart: '1860-01-01', homeOnly: true, template: 'https://www.inquirer.com/archives/', hosts: ['www.inquirer.com'] }),
  source({ id: 'free-library-inquirer', name: 'Free Library · Inquirer Digital Archive', shelf: 'Library Card', region: 'Philadelphia, Pennsylvania', access: 'LIBRARY', description: 'The Free Library lists full-page Philadelphia Inquirer scans for 1860–2001; online access requires a Free Library card.', features: ['EXACT ISSUE', 'PAGE IMAGE', '1860–2001'], aliases: ['philadelphia inquirer', 'the philadelphia inquirer', 'inquirer'], issueBrowse: true, coverageStart: '1860-01-01', coverageEnd: '2001-12-31', homeOnly: true, template: 'https://libwww.freelibrary.org/elecres/inquirerarchive.cfm', hosts: ['libwww.freelibrary.org'] }),
  source({ id: 'newspapers-com', name: 'Newspapers.com', shelf: 'Library Card', region: 'Global', access: 'PAID', providerView: 'authenticated', description: 'Large subscription newspaper archive that supports normal sign-in inside a browser-managed Microfiche view.', features: ['OCR', 'PAGE IMAGE', 'AUTHENTICATED VIEW'], template: 'https://www.newspapers.com/search/results/?keyword={query}', hosts: ['www.newspapers.com'] }),
  source({ id: 'newspaperarchive', name: 'NewspaperArchive', shelf: 'Library Card', region: 'Global', access: 'PAID', description: 'Membership newspaper archive with genealogy-oriented coverage.', features: ['OCR', 'PAGE IMAGE'], homeOnly: true, template: 'https://newspaperarchive.com/search/', hosts: ['newspaperarchive.com'] }),
  source({ id: 'genealogybank', name: 'GenealogyBank', shelf: 'Library Card', region: 'United States', access: 'PAID', description: 'Newspapers and obituaries with personal-subscription access.', features: ['OCR', 'OBITUARIES'], homeOnly: true, template: 'https://www.genealogybank.com/explore/newspapers/all', hosts: ['www.genealogybank.com'] }),
  source({ id: 'proquest-historical', name: 'ProQuest Historical Newspapers', shelf: 'Library Card', region: 'Global', access: 'LIBRARY', description: 'Institutional access to major historic newspaper collections.', features: ['OCR', 'PAGE IMAGE'], homeOnly: true, template: 'https://about.proquest.com/en/products-services/pq-hist-news/', hosts: ['about.proquest.com'] }),
  source({ id: 'newsbank', name: 'NewsBank Access World News', shelf: 'Library Card', era: 'BOTH', region: 'Global', access: 'LIBRARY', description: 'Library and institutional access to current, local, and historic reporting.', features: ['FULL TEXT', 'NEWS'], homeOnly: true, template: 'https://www.newsbank.com/', hosts: ['www.newsbank.com'] }),
  source({ id: 'readex', name: 'Readex Historical Newspapers', shelf: 'Library Card', region: 'United States', access: 'LIBRARY', description: 'Institutional American historical newspaper and periodical collections.', features: ['OCR', 'PAGE IMAGE'], homeOnly: true, template: 'https://www.readex.com/products/americas-historical-newspapers-periodicals', hosts: ['www.readex.com'] }),
  source({ id: 'gale-primary', name: 'Gale Primary Sources', shelf: 'Library Card', region: 'Global', access: 'LIBRARY', description: 'Institutional historic newspaper and primary-source collections.', features: ['OCR', 'PAGE IMAGE'], homeOnly: true, template: 'https://www.gale.com/intl/primary-sources/standalone-collections', hosts: ['www.gale.com'] }),
  source({ id: 'pressreader', name: 'PressReader', shelf: 'Library Card', era: 'CURRENT', region: 'Global', access: 'MIXED', description: 'Current replica editions through personal, hotel, or library access.', features: ['PAGE IMAGE', 'NEWS'], template: 'https://www.pressreader.com/search?query={query}', hosts: ['www.pressreader.com'] }),
  source({ id: 'retronews', name: 'RetroNews', shelf: 'Library Card', region: 'France', access: 'MIXED', description: 'BnF French press platform with mixed free and premium access.', features: ['OCR', 'PAGE IMAGE'], homeOnly: true, template: 'https://www.retronews.fr/', hosts: ['www.retronews.fr'] }),
  source({ id: 'timesmachine', name: 'TimesMachine', shelf: 'Library Card', region: 'United States', access: 'PAID', description: 'New York Times replica archive with subscription access.', features: ['PAGE IMAGE', 'PUBLISHER'], homeOnly: true, template: 'https://timesmachine.nytimes.com/browser', hosts: ['timesmachine.nytimes.com'] }),
]);

const SOURCE_BY_ID = new Map(NEWSPAPER_SOURCES.map((item) => [item.id, item]));
const PHILADELPHIA_INQUIRER_ALIASES = new Set([
  'philadelphia inquirer',
  'inquirer',
]);
const CREDENTIAL_QUERY_KEYS = new Set([
  'accesstoken',
  'apikey',
  'auth',
  'authorization',
  'code',
  'credential',
  'idtoken',
  'iat',
  'jwt',
  'key',
  'nonce',
  'password',
  'refreshtoken',
  'secret',
  'session',
  'sessionid',
  'sig',
  'signature',
  'sso',
  'state',
  'subscriptionkey',
  'ticket',
  'token',
  'xamzcredential',
  'xamzsecuritytoken',
  'xamzsignature',
]);
const JWT_LIKE_VALUE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/u;

function cleanQuery(value, allowEmpty = false) {
  if (typeof value !== 'string') throw new Error('Enter a newspaper research query first.');
  const query = value.trim().replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!query && !allowEmpty) throw new Error('Enter a newspaper research query first.');
  if (query.length > 500) throw new Error('Newspaper queries are limited to 500 characters.');
  return query;
}

function cleanPublication(value) {
  if (typeof value !== 'string') throw new Error('Enter a publication title for an exact-issue lookup.');
  const publication = value.trim().replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ');
  if (!publication) throw new Error('Enter a publication title for an exact-issue lookup.');
  if (publication.length > 300) throw new Error('Publication titles are limited to 300 characters.');
  return publication;
}

function cleanIssueDate(value) {
  if (typeof value !== 'string') throw new Error('Choose a valid issue date.');
  const issueDate = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(issueDate);
  if (!match) throw new Error('Choose a valid issue date.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new Error('Choose a valid issue date.');
  }
  return issueDate;
}

function normalizedPublication(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function formatIssueDate(issueDate) {
  const [year, month, day] = issueDate.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function normalizeHandoffContext(value, { allowEmptyQuery = false } = {}) {
  if (typeof value === 'string') {
    const query = cleanQuery(value, allowEmptyQuery);
    return { mode: 'articles', query, clipboardText: query, publication: '', issueDate: '', optionalQuery: '' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Microfiche received an invalid handoff request.');
  }
  const context = value;
  if (context.mode === 'exact') {
    const publication = cleanPublication(context.publication);
    const issueDate = cleanIssueDate(context.issueDate);
    if (context.query != null && typeof context.query !== 'string') {
      throw new Error('Newspaper queries must be text.');
    }
    let optionalQuery = (context.query || '').trim().replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ');
    if (optionalQuery.length > 500) throw new Error('Newspaper queries are limited to 500 characters.');
    if (normalizedPublication(optionalQuery) === normalizedPublication(publication)) optionalQuery = '';
    const formattedDate = formatIssueDate(issueDate);
    const query = [publication, formattedDate, optionalQuery].filter(Boolean).join(' · ');
    const clipboardText = [
      `Publication: ${publication}`,
      `Issue date: ${formattedDate}`,
      optionalQuery ? `Optional keywords: ${optionalQuery}` : '',
    ].filter(Boolean).join('\n');
    return { mode: 'exact', query, clipboardText, publication, issueDate, optionalQuery };
  }
  if (context.mode !== 'articles') throw new Error('Unknown newspaper research mode.');
  const query = cleanQuery(context.query, allowEmptyQuery);
  return { mode: 'articles', query, clipboardText: query, publication: '', issueDate: '', optionalQuery: '' };
}

function publicSource(item, additions = {}) {
  const { template: _template, hosts: _hosts, ...safe } = item;
  return { ...safe, ...additions, features: [...item.features], aliases: [...item.aliases] };
}

function listNewspaperSources() {
  return { shelves: [...SHELVES], sources: NEWSPAPER_SOURCES.map(publicSource) };
}

function buildNewspaperSourceUrl(sourceId, contextValue) {
  const item = SOURCE_BY_ID.get(String(sourceId || ''));
  if (!item) throw new Error('Unknown newspaper source.');
  const context = normalizeHandoffContext(contextValue, { allowEmptyQuery: item.id === 'newspapers-com' });
  const query = context.query;
  let url;
  if (item.id === 'newspapers-com' && context.mode === 'articles' && !query) {
    url = new URL('https://www.newspapers.com/');
  } else if (item.id === 'newspapers-com' && context.mode === 'exact') {
    url = new URL('https://www.newspapers.com/search/results/');
    url.searchParams.set('date', context.issueDate);
    if (PHILADELPHIA_INQUIRER_ALIASES.has(normalizedPublication(context.publication))) {
      url.searchParams.set('publication-ids', '4352');
      if (context.optionalQuery) url.searchParams.set('keyword', context.optionalQuery);
    } else {
      url.searchParams.set(
        'keyword',
        [context.publication, context.optionalQuery].filter(Boolean).join(' '),
      );
    }
  } else {
    url = new URL(item.template.replaceAll('{query}', encodeURIComponent(item.homeOnly ? '' : query)));
  }
  if (url.protocol !== 'https:' || url.username || url.password || !item.hosts.includes(url.hostname)) {
    throw new Error('Microfiche blocked an unsafe newspaper-source URL.');
  }
  return {
    sourceId: item.id,
    sourceName: item.name,
    access: item.access,
    providerView: item.providerView,
    allowedHosts: [...item.hosts],
    url: url.href,
    displayUrl: `${url.origin}${url.pathname}`,
    copiedQuery: item.homeOnly,
    copiedContext: item.homeOnly && context.mode === 'exact',
    query,
    clipboardText: context.clipboardText,
    mode: context.mode,
  };
}

function recommendIssueSources(publicationValue, issueDateValue) {
  const publication = cleanPublication(publicationValue);
  const issueDate = cleanIssueDate(issueDateValue);
  const needle = normalizedPublication(publication);
  const accessPriority = new Map([['FREE', 0], ['LIBRARY', 1], ['MIXED', 2], ['PAID', 3], ['LEGACY', 4]]);
  const exact = NEWSPAPER_SOURCES.filter((item) => {
    if (!item.issueBrowse) return false;
    const aliases = [item.name, ...item.aliases].map(normalizedPublication);
    if (!aliases.includes(needle)) return false;
    if (item.coverageStart && issueDate < item.coverageStart) return false;
    if (item.coverageEnd && issueDate > item.coverageEnd) return false;
    return true;
  }).sort((left, right) => (accessPriority.get(left.access) ?? 9) - (accessPriority.get(right.access) ?? 9));
  const newspapersLead = SOURCE_BY_ID.get('newspapers-com');
  const fallbackIds = ['newspapers-com', 'proquest-historical', 'worldcat', 'loc-newspaper-directory'];
  const fallback = fallbackIds.map((id) => SOURCE_BY_ID.get(id)).filter(Boolean);
  const routes = exact.length
    ? [
      ...exact.map((item) => publicSource(item, { routeKind: 'coverage' })),
      publicSource(newspapersLead, { routeKind: 'lead' }),
    ]
    : fallback.map((item) => publicSource(item, { routeKind: 'lead' }));
  return {
    publication,
    issueDate,
    formattedDate: formatIssueDate(issueDate),
    match: exact.length ? 'exact' : 'fallback',
    routes,
  };
}

function isAllowedNewspaperSourceUrl(sourceId, value) {
  const item = SOURCE_BY_ID.get(String(sourceId || ''));
  if (!item) return false;
  try {
    const url = new URL(String(value || ''));
    return (
      url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.port
      && item.hosts.includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function buildSafeExternalNewspaperUrl(sourceId, value) {
  if (!isAllowedNewspaperSourceUrl(sourceId, value)) {
    throw new Error('The Newsstand page is not safe to open externally.');
  }

  const url = new URL(String(value));
  for (const key of [...new Set(url.searchParams.keys())]) {
    const normalizedKey = key.toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/gu, '');
    const values = url.searchParams.getAll(key);
    if (
      CREDENTIAL_QUERY_KEYS.has(normalizedKey)
      || values.some((candidate) => JWT_LIKE_VALUE.test(candidate))
    ) {
      url.searchParams.delete(key);
    }
  }
  url.hash = '';
  return url.href;
}

function isAllowedResearchUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const hosts = new Set(['www.loc.gov', 'archive.org', 'paperspast.natlib.govt.nz', 'digitalnz.org', 'www.digitalnz.org']);
    return url.protocol === 'https:' && !url.username && !url.password && hosts.has(url.hostname);
  } catch {
    return false;
  }
}

function isAllowedNewspaperUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    return NEWSPAPER_SOURCES.some((sourceItem) => sourceItem.hosts.includes(url.hostname));
  } catch {
    return false;
  }
}

module.exports = {
  NEWSPAPER_SOURCES,
  SHELVES,
  buildSafeExternalNewspaperUrl,
  buildNewspaperSourceUrl,
  isAllowedNewspaperSourceUrl,
  isAllowedNewspaperUrl,
  isAllowedResearchUrl,
  listNewspaperSources,
  normalizeHandoffContext,
  recommendIssueSources,
};
