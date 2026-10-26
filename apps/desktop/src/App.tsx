import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { getArchiveSources, getHealth, searchArchive } from './api';
import type {
  ArchiveSource,
  EngineCatalog,
  EngineSource,
  HandoffContext,
  IssueReel,
  IssueReelImportInput,
  IssueReelProgress,
  IssueReelSummary,
  IssueRoutePlan,
  NewsstandViewerAction,
  NewsstandViewerSession,
  NewsstandViewerState,
  SearchMode,
  SearchResult,
  SourceRun,
} from './types';

const fallback: SearchResult[] = [
  {
    id: 'offline-demo', archive: 'offline-preview', external_id: 'offline-demo',
    publication: 'Foxtail Demonstration Gazette', date: null, location: 'Local preview',
    page: 1, frame: 1, headline: 'Reader preview — not an archive result',
    snippet: 'This clearly labeled demonstration page keeps the reader visible while the local archive service is offline.',
    ocr_text: 'DEMONSTRATION PAGE\n\nNOT AN ARCHIVE RESULT\n\nStart the local Microfiche service to search live public newspaper collections.',
    thumbnail_url: null, image_url: null, source_url: null,
    rights: 'Foxtail demonstration content', score: 0, metadata: { provider: 'OFFLINE DEMO', live_api: false },
  },
];

const emptySelection: SearchResult = {
  id: 'empty-live-search', archive: 'search-complete', external_id: 'empty-live-search',
  publication: 'No matching newspaper page', date: null, location: null, page: null, frame: null,
  headline: 'No pages matched this bounded live pass.',
  snippet: 'Adjust the query, dates, publication, location, or live source selection. Filters refine the provider results returned in this pass; they are not an exhaustive holdings check.',
  ocr_text: 'NO MATCHING OCR TEXT\n\nBroaden the current search or open the Newsstand for a specialist collection.',
  thumbnail_url: null, image_url: null, source_url: null, rights: null, score: null,
  metadata: { provider: 'SEARCH COMPLETE', live_api: true },
};

const emptyCatalog: EngineCatalog = {
  shelves: ["Today's Wire", 'The Morgue', 'Local Desk', 'World Desk', 'OCR Cabinet', 'Library Card'],
  sources: [],
};

type WorkspaceView = 'reader' | 'newsstand' | 'reels';
type ReelLibraryState = 'loading' | 'ready' | 'error';

const emptyReelDraft: IssueReelImportInput = {
  publication: '',
  issueDate: '',
  location: '',
  edition: '',
  sourceLabel: '',
  sourceUrl: '',
  rights: '',
};

const emptyNewsstandViewerState: NewsstandViewerState = {
  active: false,
  visible: false,
  loading: false,
  canGoBack: false,
  canGoForward: false,
};

function App() {
  const [query, setQuery] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [publication, setPublication] = useState('');
  const [location, setLocation] = useState('');
  const [archiveSources, setArchiveSources] = useState<ArchiveSource[]>([]);
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [sourceRuns, setSourceRuns] = useState<SourceRun[]>([]);
  const [catalog, setCatalog] = useState<EngineCatalog>(emptyCatalog);
  const [activeShelf, setActiveShelf] = useState('All shelves');
  const [engineFilter, setEngineFilter] = useState('');
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('reader');
  const [searchMode, setSearchMode] = useState<SearchMode>('articles');
  const [issuePlan, setIssuePlan] = useState<IssueRoutePlan | null>(null);
  const [results, setResults] = useState<SearchResult[]>(fallback);
  const [reels, setReels] = useState<IssueReelSummary[]>([]);
  const [reelLibraryState, setReelLibraryState] = useState<ReelLibraryState>('loading');
  const [activeReel, setActiveReel] = useState<IssueReel | null>(null);
  const [reelDraft, setReelDraft] = useState<IssueReelImportInput>(emptyReelDraft);
  const [reelBusy, setReelBusy] = useState(false);
  const [reelProgress, setReelProgress] = useState<IssueReelProgress | null>(null);
  const [newsstandSession, setNewsstandSession] = useState<NewsstandViewerSession | null>(null);
  const [newsstandViewerState, setNewsstandViewerState] = useState<NewsstandViewerState>(emptyNewsstandViewerState);
  const [newsstandControlBusy, setNewsstandControlBusy] = useState<NewsstandViewerAction | 'activate' | null>(null);
  const [selectedId, setSelectedId] = useState(fallback[0].id);
  const [status, setStatus] = useState('Connecting to the research room…');
  const [busy, setBusy] = useState(false);
  const [invert, setInvert] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [contrast, setContrast] = useState(1.04);
  const [brightness, setBrightness] = useState(1.02);
  const [inspectorTab, setInspectorTab] = useState<'ocr' | 'metadata'>('ocr');
  const [ocrNeedle, setOcrNeedle] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const issueRequestRef = useRef(0);
  const filmstripRef = useRef<HTMLDivElement | null>(null);
  const newsstandViewportRef = useRef<HTMLDivElement | null>(null);

  const readerResults = useMemo(
    () => activeReel ? activeReel.pages.map((page) => reelPageToResult(activeReel, page)) : results,
    [activeReel, results],
  );

  const selected = useMemo(
    () => readerResults.find((result) => result.id === selectedId) ?? readerResults[0] ?? emptySelection,
    [readerResults, selectedId],
  );

  const selectedIndex = Math.max(0, readerResults.findIndex((result) => result.id === selected?.id));
  const newsstandViewerActive = Boolean(newsstandSession && !activeReel && workspaceView === 'reader');
  const liveBySlug = useMemo(() => new Map(archiveSources.map((source) => [source.slug, source])), [archiveSources]);
  const engineResults = useMemo(() => {
    const needle = engineFilter.trim().toLowerCase();
    const pool = activeShelf === 'Exact issue' && issuePlan ? issuePlan.routes : catalog.sources;
    return pool.filter((source) => {
      if (activeShelf !== 'All shelves' && activeShelf !== 'Exact issue' && source.shelf !== activeShelf) return false;
      if (!needle) return true;
      return `${source.name} ${source.description} ${source.region ?? ''} ${source.features.join(' ')} ${source.aliases.join(' ')}`.toLowerCase().includes(needle);
    });
  }, [activeShelf, catalog.sources, engineFilter, issuePlan]);
  const ocrDisplay = useMemo(() => {
    const text = selected?.ocr_text || selected?.snippet || 'No OCR text was supplied by this source.';
    const needle = ocrNeedle.trim().toLowerCase();
    if (!needle) return text;
    const matches = text.split(/\n+/).filter((line) => line.toLowerCase().includes(needle));
    return matches.length ? matches.join('\n\n') : `No OCR lines contain “${ocrNeedle.trim()}”.`;
  }, [ocrNeedle, selected]);
  const filmFrames = useMemo(() => {
    if (activeReel) return readerResults;
    const start = Math.max(0, Math.min(Math.max(0, readerResults.length - 8), selectedIndex - 3));
    return readerResults.slice(start, start + 8);
  }, [activeReel, readerResults, selectedIndex]);
  const leftPanelResults = useMemo(() => {
    if (!activeReel || readerResults.length <= 61) return readerResults;
    const start = Math.max(0, Math.min(readerResults.length - 61, selectedIndex - 30));
    return readerResults.slice(start, start + 61);
  }, [activeReel, readerResults, selectedIndex]);

  useEffect(() => {
    Promise.all([
      getHealth(),
      getArchiveSources(),
      window.foxtail?.getNewspaperSources?.() ?? Promise.resolve(emptyCatalog),
    ])
      .then(([health, sources, engineCatalog]) => {
        setArchiveSources(sources);
        setSelectedSources(sources.filter((source) => source.enabled).map((source) => source.slug));
        setCatalog(engineCatalog);
        setStatus(`${health.database !== 'ok' ? 'Database unavailable' : health.connectivity === 'degraded' ? 'Archive network lookup failed · check your connection' : 'Research room ready'} · ${health.adapters.length} archive connections checked when you search · ${engineCatalog.sources.length} engines`);
      })
      .catch(() => {
        window.foxtail?.getNewspaperSources?.().then(setCatalog).catch(() => {});
        setStatus('API offline · the Newsstand and reader preview remain available');
      });
  }, []);

  useEffect(() => {
    if (!window.foxtail?.listIssueReels) {
      setReelLibraryState('error');
      return;
    }
    window.foxtail.listIssueReels()
      .then((savedReels) => {
        setReels(savedReels);
        setReelLibraryState('ready');
      })
      .catch((error) => {
        setReelLibraryState('error');
        setStatus(`The local reel cabinet could not be opened: ${(error as Error)?.message || error}`);
      });
  }, []);

  useEffect(() => {
    if (!window.foxtail?.onIssueReelProgress) return undefined;
    return window.foxtail.onIssueReelProgress((progress) => {
      setReelProgress(progress);
      setStatus(progress.message);
    });
  }, []);

  useEffect(() => {
    function onReaderKeyDown(event: KeyboardEvent) {
      if (workspaceView !== 'reader' || !activeReel || readerResults.length < 2) return;
      const target = event.target as HTMLElement | null;
      const interactiveTarget = target?.closest('input, textarea, select, button, [contenteditable="true"]');
      if (interactiveTarget && !target?.closest('[data-reel-page-control="true"]')) return;
      let nextIndex: number | null = null;
      if (event.key === 'ArrowLeft' || event.key === 'PageUp') nextIndex = Math.max(0, selectedIndex - 1);
      if (event.key === 'ArrowRight' || event.key === 'PageDown') nextIndex = Math.min(readerResults.length - 1, selectedIndex + 1);
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = readerResults.length - 1;
      if (nextIndex == null) return;
      event.preventDefault();
      setSelectedId(readerResults[nextIndex].id);
    }
    window.addEventListener('keydown', onReaderKeyDown);
    return () => window.removeEventListener('keydown', onReaderKeyDown);
  }, [activeReel, readerResults, selectedIndex, workspaceView]);

  useEffect(() => {
    if (!activeReel || workspaceView !== 'reader') return;
    const frame = filmstripRef.current?.querySelector<HTMLElement>(`[data-frame-index="${selectedIndex}"]`);
    if (!frame) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    frame.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest', inline: 'center' });
  }, [activeReel, selectedIndex, workspaceView]);


  useEffect(() => {
    if (!window.foxtail?.onNewsstandViewState) return undefined;
    return window.foxtail.onNewsstandViewState((nextState) => {
      setNewsstandViewerState(nextState);
      if ((nextState.blocked || nextState.failed) && nextState.message) setStatus(`Newsstand viewer: ${nextState.message}`);
    });
  }, []);

  useEffect(() => {
    const api = window.foxtail;
    if (!newsstandViewerActive || !api?.showNewsstandSource || !api?.hideNewsstandSource) {
      api?.hideNewsstandSource?.().catch(() => {});
      return undefined;
    }

    const viewport = newsstandViewportRef.current;
    if (!viewport) return undefined;

    let disposed = false;
    let lastBounds = '';
    const syncViewer = () => {
      if (disposed) return;
      const rect = viewport.getBoundingClientRect();
      const bounds = {
        x: Math.max(0, Math.round(rect.left)),
        y: Math.max(0, Math.round(rect.top)),
        width: Math.max(160, Math.round(rect.width)),
        height: Math.max(160, Math.round(rect.height)),
      };
      const signature = JSON.stringify(bounds);
      if (signature === lastBounds) return;
      lastBounds = signature;
      api.showNewsstandSource(bounds)
        .then((nextState) => { if (!disposed) setNewsstandViewerState(nextState); })
        .catch((error) => {
          if (!disposed) setStatus(`Newsstand viewer error: ${(error as Error)?.message || error}`);
        });
    };

    const resizeObserver = new ResizeObserver(syncViewer);
    resizeObserver.observe(viewport);
    const animationFrame = requestAnimationFrame(syncViewer);
    window.addEventListener('resize', syncViewer);

    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      window.removeEventListener('resize', syncViewer);
      api.hideNewsstandSource().catch(() => {});
    };
  }, [newsstandSession?.sourceId, newsstandViewerActive]);

  function requestPayload(sourceOverride?: string[]) {
    return {
      query: query.trim(),
      date_from: dateFrom || null,
      date_to: dateTo || null,
      publication: publication.trim() || null,
      location: location.trim() || null,
      sources: sourceOverride ?? selectedSources,
      limit: 60,
    };
  }

  function closeNewsstandViewer(message?: string) {
    window.foxtail?.deactivateNewsstandSource?.().catch(() => {});
    setNewsstandSession(null);
    setNewsstandViewerState(emptyNewsstandViewerState);
    setNewsstandControlBusy(null);
    if (message) setStatus(message);
  }

  function invalidateExactIssueRoute() {
    if (searchMode !== 'exact') return;
    const hadExactContext = Boolean(issuePlan || activeShelf === 'Exact issue' || newsstandSession?.mode === 'exact');
    issueRequestRef.current += 1;
    setIssuePlan(null);
    if (activeShelf === 'Exact issue') setActiveShelf('All shelves');
    if (newsstandSession?.mode === 'exact') closeNewsstandViewer();
    if (hadExactContext) setStatus('Exact issue details changed · choose Find issue to refresh archive coverage.');
  }

  function updateIssueDate(value: string) {
    if (value !== dateFrom) invalidateExactIssueRoute();
    setDateFrom(value);
    if (searchMode === 'exact') setDateTo(value);
  }

  function updatePublication(value: string) {
    if (value !== publication) invalidateExactIssueRoute();
    setPublication(value);
  }

  function chooseSearchMode(mode: SearchMode) {
    if (mode === searchMode) return;
    closeNewsstandViewer();
    abortRef.current?.abort();
    abortRef.current = null;
    issueRequestRef.current += 1;
    setBusy(false);
    setSearchMode(mode);
    if (mode === 'exact') {
      if (dateFrom) setDateTo(dateFrom);
      setStatus('Exact issue · enter a publication and one issue date. A keyword is optional.');
    } else {
      setIssuePlan(null);
      if (activeShelf === 'Exact issue') setActiveShelf('All shelves');
      setStatus('Article search · enter a person, event, phrase, place, or publication.');
    }
  }

  async function routeExactIssue() {
    const title = publication.trim();
    const issueDate = dateFrom;
    if (!title) {
      setStatus('Enter the newspaper title in Publication to find an exact issue.');
      return;
    }
    if (!issueDate) {
      setStatus('Choose the issue date in the From field.');
      return;
    }
    if (dateTo && dateTo !== issueDate) {
      setStatus('Exact issue uses one date. Make From and To the same day, or switch to Articles.');
      return;
    }
    if (!window.foxtail?.getIssueRoutes) {
      setStatus('Exact-issue routing is available in the Electron desktop app.');
      return;
    }

    closeNewsstandViewer();
    abortRef.current?.abort();
    abortRef.current = null;
    const requestId = issueRequestRef.current + 1;
    issueRequestRef.current = requestId;
    setSearchMode('exact');
    setDateTo(issueDate);
    setBusy(true);
    setStatus(`Matching ${title} on ${formatDate(issueDate)} to reviewed archive coverage…`);
    try {
      const plan = await window.foxtail.getIssueRoutes(title, issueDate);
      if (issueRequestRef.current !== requestId) return;
      setIssuePlan(plan);
      setActiveShelf('Exact issue');
      setEngineFilter('');
      setWorkspaceView('newsstand');
      const coverageCount = plan.routes.filter((source) => source.routeKind === 'coverage').length;
      const leadCount = plan.routes.filter((source) => source.routeKind === 'lead').length;
      setStatus(plan.match === 'exact'
        ? `${coverageCount} catalog coverage match${coverageCount === 1 ? '' : 'es'} and ${leadCount} additional research lead${leadCount === 1 ? '' : 's'} for ${plan.publication} · ${plan.formattedDate}.`
        : `No title-specific route is cataloged for that date · showing ${leadCount} careful holdings lead${leadCount === 1 ? '' : 's'}.`);
    } catch (error) {
      if (issueRequestRef.current !== requestId) return;
      setIssuePlan(null);
      setStatus(`Could not route that issue: ${(error as Error)?.message || error}`);
    } finally {
      if (issueRequestRef.current === requestId) setBusy(false);
    }
  }

  async function runSearch(event?: FormEvent, sourceOverride?: string[]) {
    event?.preventDefault();
    const sameDay = Boolean(dateFrom && dateTo && dateFrom === dateTo);
    const repeatedTitle = Boolean(query.trim() && normalizedPublication(query) === normalizedPublication(publication));
    if (searchMode === 'exact' || (sameDay && publication.trim() && (!query.trim() || repeatedTitle))) {
      await routeExactIssue();
      return;
    }
    if (!query.trim()) {
      setStatus('Enter a person, event, phrase, place, or publication to investigate.');
      return;
    }
    if (dateFrom && dateTo && dateFrom > dateTo) {
      setStatus('The From date must be on or before the To date.');
      return;
    }
    const chosen = sourceOverride ?? selectedSources;
    if (!chosen.length) {
      setStatus('Choose at least one live archive engine. Every other catalog source remains ready in the Newsstand viewer.');
      return;
    }
    closeNewsstandViewer();
    issueRequestRef.current += 1;
    setIssuePlan(null);
    setActiveReel(null);
    if (activeShelf === 'Exact issue') setActiveShelf('All shelves');
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setWorkspaceView('reader');
    setStatus(`Searching ${chosen.length} live archive${chosen.length === 1 ? '' : 's'}…`);
    let receivedResults = false;
    setResults([]);
    setSourceRuns([]);
    setSelectedId('');
    try {
      const data = await searchArchive(requestPayload(chosen), controller.signal, (partial) => {
        if (abortRef.current !== controller) return;
        receivedResults = receivedResults || partial.results.length > 0;
        setResults(partial.results);
        setSelectedId((current) => partial.results.some((item) => item.id === current) ? current : partial.results[0]?.id ?? '');
        setSourceRuns(partial.source_runs);
        setStatus(`${partial.results.length} results so far · ${partial.source_runs.length}/${chosen.length} archives finished · still searching…`);
      });
      if (abortRef.current !== controller) return;
      setResults(data.results);
      setSelectedId((current) => data.results.some((item) => item.id === current) ? current : data.results[0]?.id ?? '');
      setSourceRuns(data.source_runs);
      const ok = data.source_runs.filter((run) => run.ok).length;
      const failures = data.source_runs.length - ok;
      const cacheNote = data.cache_hit
        ? ' · served from the short metadata cache'
        : data.cache_ttl_seconds > 0 ? ` · metadata cached for ${Math.ceil(data.cache_ttl_seconds / 60)} min` : '';
      setStatus(`${data.results.length} public API result${data.results.length === 1 ? '' : 's'} in this bounded pass · ${ok}/${data.source_runs.length} selected API archives responded${failures ? ` · ${failures} isolated failure${failures === 1 ? '' : 's'}` : ''}${cacheNote} · ${catalog.sources.length} Newsstand source doors ready`);
    } catch (error) {
      if (abortRef.current !== controller) return;
      if ((error as Error)?.name === 'AbortError') setStatus('Search canceled.');
      else setStatus(receivedResults ? 'Search connection interrupted · keeping the results already received; retry to check remaining archives.' : 'Live search unavailable · showing the local reader preview');
      if ((error as Error)?.name !== 'AbortError' && !receivedResults) {
        setSourceRuns([]);
        setResults(fallback);
        setSelectedId(fallback[0].id);
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setBusy(false);
      }
    }
  }

  function toggleSource(slug: string) {
    setSelectedSources((current) => current.includes(slug)
      ? current.filter((item) => item !== slug)
      : [...current, slug]);
  }

  async function activateEngine(source: EngineSource) {
    const exactContext = Boolean(issuePlan && activeShelf === 'Exact issue');
    if (!exactContext && source.mode === 'federated' && source.adapterSlug) {
      setSelectedSources([source.adapterSlug]);
      await runSearch(undefined, [source.adapterSlug]);
      return;
    }
    if (!window.foxtail?.activateNewsstandSource) {
      setStatus('The private Newsstand viewer is available in the Electron desktop app.');
      return;
    }
    if (!exactContext && !query.trim() && source.id !== 'newspapers-com') {
      setStatus(`Enter a search above before opening ${source.name} in the viewer.`);
      return;
    }

    const context: HandoffContext = exactContext && issuePlan ? {
      mode: 'exact',
      query: query.trim(),
      publication: issuePlan.publication,
      issueDate: issuePlan.issueDate,
    } : { mode: 'articles', query: query.trim() };

    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(true);
    setNewsstandControlBusy('activate');
    setStatus(`Preparing ${source.name} inside the private Newsstand viewer…`);
    try {
      const session = await window.foxtail.activateNewsstandSource(source.id, context);
      setActiveReel(null);
      setNewsstandSession(session);
      setNewsstandViewerState({
        active: true,
        visible: false,
        sourceId: session.sourceId,
        sourceName: session.sourceName,
        access: session.access,
        displayUrl: session.displayUrl,
        mode: session.mode,
        cacheMode: session.cacheMode,
        loading: true,
        canGoBack: false,
        canGoForward: false,
      });
      setOcrNeedle('');
      setInspectorTab('metadata');
      setWorkspaceView('reader');
      const routingNote = exactContext && source.routeKind === 'lead' ? ' · labeled holdings lead' : '';
      const clipboardNote = session.copiedContext
        ? ' · issue details copied for the source form'
        : session.copiedQuery ? ' · query copied for the source form' : '';
      setStatus(`${session.sourceName} opened in Microfiche · ${session.access} access${routingNote}${clipboardNote} · browser-managed persistent cache ready`);
    } catch (error) {
      setNewsstandSession(null);
      setNewsstandViewerState(emptyNewsstandViewerState);
      setStatus(`Could not open ${source.name} in the Newsstand viewer: ${(error as Error)?.message || error}`);
    } finally {
      setNewsstandControlBusy(null);
      setBusy(false);
    }
  }

  async function controlNewsstandViewer(action: NewsstandViewerAction) {
    if (!newsstandSession || !window.foxtail?.controlNewsstandSource) return;
    setNewsstandControlBusy(action);
    try {
      const outcome = await window.foxtail.controlNewsstandSource(action);
      setNewsstandViewerState(outcome.state);
      if (action === 'external') setStatus(`Opened ${newsstandSession.sourceName} in your default browser.`);
    } catch (error) {
      setStatus(`Could not control the Newsstand viewer: ${(error as Error)?.message || error}`);
    } finally {
      setNewsstandControlBusy(null);
    }
  }

  async function openOriginal() {
    if (!selected?.source_url || !window.foxtail?.openResearchUrl) {
      setStatus('This preview has no original source page.');
      return;
    }
    try {
      await window.foxtail.openResearchUrl(selected.source_url);
      setStatus(`Opened the authoritative ${providerName(selected)} record.`);
    } catch (error) {
      setStatus(`Could not open the source: ${(error as Error)?.message || error}`);
    }
  }

  async function copyCitation() {
    const citation = activeReel
      ? [activeReel.publication, activeReel.issueDate, `Page ${selected.page ?? '—'}`, activeReel.edition, activeReel.sourceLabel || 'Local Issue Reel', activeReel.sourceUrl].filter(Boolean).join(' · ')
      : [selected.publication, selected.date, selected.headline, selected.source_url].filter(Boolean).join(' · ');
    try {
      if (window.foxtail?.copyText) await window.foxtail.copyText(citation);
      else await navigator.clipboard.writeText(citation);
      setStatus('Citation copied to the clipboard.');
    } catch {
      setStatus('Clipboard access was unavailable.');
    }
  }

  function selectAdjacent(delta: number) {
    if (!readerResults.length) return;
    const next = Math.max(0, Math.min(readerResults.length - 1, selectedIndex + delta));
    setSelectedId(readerResults[next].id);
  }

  function openReelImporter() {
    closeNewsstandViewer();
    setReelDraft({
      publication: issuePlan?.publication || publication.trim(),
      issueDate: issuePlan?.issueDate || dateFrom,
      location: location.trim(),
      edition: '',
      sourceLabel: issuePlan ? 'Downloaded archive copy' : '',
      sourceUrl: '',
      rights: '',
    });
    setReelProgress(null);
    setWorkspaceView('reels');
    setStatus('Add the issue details, then choose one PDF or an ordered set of JPEG or PNG page images.');
  }

  async function refreshReels() {
    if (!window.foxtail?.listIssueReels) throw new Error('The local reel cabinet is available in the Electron desktop app.');
    const savedReels = await window.foxtail.listIssueReels();
    setReels(savedReels);
    setReelLibraryState('ready');
  }

  async function retryReelLibrary() {
    setReelLibraryState('loading');
    try {
      await refreshReels();
      setStatus('The local reel cabinet is ready.');
    } catch (error) {
      setReelLibraryState('error');
      setStatus(`The local reel cabinet could not be opened: ${(error as Error)?.message || error}`);
    }
  }

  async function importIssueReel(event: FormEvent) {
    event.preventDefault();
    if (!reelDraft.publication.trim()) {
      setStatus('Enter the newspaper title before choosing the issue file.');
      return;
    }
    if (!reelDraft.issueDate) {
      setStatus('Choose the issue date before choosing the issue file.');
      return;
    }
    if (!window.foxtail?.importIssueReel) {
      setStatus('Issue Reel import is available in the Electron desktop app.');
      return;
    }
    setReelBusy(true);
    setReelProgress({ stage: 'selecting', message: 'Choose one PDF or an ordered set of JPEG or PNG page images.' });
    try {
      const outcome = await window.foxtail.importIssueReel({
        publication: reelDraft.publication.trim(),
        issueDate: reelDraft.issueDate,
        location: reelDraft.location?.trim() || undefined,
        edition: reelDraft.edition?.trim() || undefined,
        sourceLabel: reelDraft.sourceLabel?.trim() || undefined,
        sourceUrl: reelDraft.sourceUrl?.trim() || undefined,
        rights: reelDraft.rights?.trim() || undefined,
      });
      if (outcome.canceled) {
        setReelProgress(null);
        setStatus('Issue import canceled · no files were changed.');
        return;
      }
      setActiveReel(outcome.reel);
      setReels((current) => [outcome.reel, ...current.filter((reel) => reel.id !== outcome.reel.id)]);
      setReelLibraryState('ready');
      setSelectedId(reelResultId(outcome.reel.id, outcome.reel.pages[0]?.number ?? 1));
      setSourceRuns([]);
      setOcrNeedle('');
      setInspectorTab('ocr');
      setWorkspaceView('reader');
      setReelProgress(null);
      const readyMessage = `${outcome.reel.publication} · ${outcome.reel.pageCount} page${outcome.reel.pageCount === 1 ? '' : 's'} loaded into the reader.`;
      try {
        await refreshReels();
        setStatus(readyMessage);
      } catch {
        setReelLibraryState('error');
        setStatus(`${readyMessage} The cabinet list could not refresh; use Retry cabinet in Reels.`);
      }
    } catch (error) {
      setReelProgress(null);
      setStatus(`The issue could not be imported: ${(error as Error)?.message || error}`);
    } finally {
      setReelBusy(false);
    }
  }

  async function openReel(reel: IssueReelSummary) {
    if (!window.foxtail?.getIssueReel) {
      setStatus('The local reel cabinet is available in the Electron desktop app.');
      return;
    }
    closeNewsstandViewer();
    setReelBusy(true);
    setStatus(`Loading ${reel.publication}…`);
    try {
      const fullReel = await window.foxtail.getIssueReel(reel.id);
      setActiveReel(fullReel);
      setSelectedId(reelResultId(fullReel.id, 1));
      setSourceRuns([]);
      setOcrNeedle('');
      setInspectorTab('ocr');
      setWorkspaceView('reader');
      setStatus(`${fullReel.publication} · ${fullReel.pageCount} page${fullReel.pageCount === 1 ? '' : 's'} ready.`);
    } catch (error) {
      setStatus(`The reel could not be opened: ${(error as Error)?.message || error}`);
    } finally {
      setReelBusy(false);
    }
  }

  function returnToSearchResults() {
    closeNewsstandViewer();
    setActiveReel(null);
    setSelectedId(results[0]?.id ?? '');
    setStatus('Live archive results restored.');
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <strong>Foxtail Microfiche</strong>
          <span>NEWSPAPER RESEARCH ROOM · v0.3.0</span>
        </div>
        <form className="searchbar" onSubmit={(event) => runSearch(event)}>
          <div className="search-mode-toggle" role="group" aria-label="Newspaper search type">
            <button type="button" className={searchMode === 'articles' ? 'active' : ''} aria-pressed={searchMode === 'articles'} onClick={() => chooseSearchMode('articles')}>Articles</button>
            <button type="button" className={searchMode === 'exact' ? 'active' : ''} aria-pressed={searchMode === 'exact'} onClick={() => chooseSearchMode('exact')}>Exact issue</button>
          </div>
          <span className="search-icon">⌕</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={searchMode === 'exact' ? 'Optional exact-issue keyword' : 'Search newspaper archives'} placeholder={searchMode === 'exact' ? 'Optional person, headline, or event' : 'Person, event, phrase, place, or publication'} />
          {busy && searchMode === 'articles' && <button type="button" className="cancel-search" onClick={() => abortRef.current?.abort()}>Cancel</button>}
          <button type="submit" disabled={busy}>{busy ? (searchMode === 'exact' ? 'Routing…' : 'Searching…') : (searchMode === 'exact' ? 'Find issue' : 'Search live')}</button>
        </form>
        <button className={`mode-button ${workspaceView === 'reader' ? 'active' : ''}`} aria-pressed={workspaceView === 'reader'} onClick={() => setWorkspaceView('reader')}>Reader</button>
        <button className={`mode-button ${workspaceView === 'newsstand' ? 'active' : ''}`} aria-pressed={workspaceView === 'newsstand'} onClick={() => setWorkspaceView('newsstand')}>Newsstand <b>{catalog.sources.length || '—'}</b></button>
        <button className={`mode-button ${workspaceView === 'reels' ? 'active' : ''}`} aria-pressed={workspaceView === 'reels'} onClick={() => setWorkspaceView('reels')}>Reels <b>{reels.length}</b></button>
      </header>

      <section className="filter-deck">
        <label className="date-filter"><span>{searchMode === 'exact' ? 'Issue date' : 'From'}</span><input type="date" value={dateFrom} onChange={(event) => updateIssueDate(event.target.value)} disabled={searchMode === 'exact' && busy} /></label>
        <label className="date-filter" data-locked={searchMode === 'exact'}><span>{searchMode === 'exact' ? 'Same day' : 'To'}</span><input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} disabled={searchMode === 'exact'} /></label>
        <label className="wide-filter"><span>Publication</span><input value={publication} onChange={(event) => updatePublication(event.target.value)} placeholder={searchMode === 'exact' ? 'Required newspaper title' : 'Any newspaper'} disabled={searchMode === 'exact' && busy} /></label>
        <label className="wide-filter" data-locked={searchMode === 'exact'}><span>Location</span><input value={location} onChange={(event) => setLocation(event.target.value)} placeholder={searchMode === 'exact' ? 'Not used for issue routing' : 'Any city, state, or country'} disabled={searchMode === 'exact'} /></label>
        {searchMode === 'exact' ? (
          <div className="issue-route-chip"><i />Coverage-aware routing · one archive opens per click</div>
        ) : (
          <div className="live-source-toggles">
            {archiveSources.map((source) => (
              <button type="button" key={source.slug} className={selectedSources.includes(source.slug) ? 'selected' : ''} onClick={() => toggleSource(source.slug)} title={source.description}>
                <i />{shortSourceName(source.name)}
              </button>
            ))}
          </div>
        )}
        <div className="global-status" data-busy={busy || reelBusy} role="status" aria-live="polite">{status}</div>
      </section>

      {workspaceView === 'newsstand' ? (
        <Newsstand catalog={catalog} sources={engineResults} activeShelf={activeShelf} setActiveShelf={setActiveShelf} engineFilter={engineFilter} setEngineFilter={setEngineFilter} query={query} issuePlan={issuePlan} activateEngine={activateEngine} openReelImporter={openReelImporter} busy={busy} />
      ) : workspaceView === 'reels' ? (
        <ReelRoom reels={reels} libraryState={reelLibraryState} retryLibrary={retryReelLibrary} draft={reelDraft} setDraft={setReelDraft} importIssueReel={importIssueReel} openReel={openReel} busy={reelBusy} progress={reelProgress} />
      ) : (
        <section className="workspace">
          <aside className={`left-panel panel ${newsstandViewerActive ? 'newsstand-open' : ''}`}>
            <div className="panel-title">
              <span>{newsstandViewerActive ? 'NEWSSTAND VIEWER' : activeReel ? 'REEL PAGES' : 'SEARCH RESULTS'}</span>
              <small>{newsstandViewerActive ? '1 SOURCE' : readerResults.length}</small>
            </div>
            {newsstandViewerActive && newsstandSession ? (
              <div className="newsstand-session-rail">
                <span className={`access-badge access-${newsstandSession.access.toLowerCase()}`}>{newsstandSession.access}</span>
                <h2>{newsstandSession.sourceName}</h2>
                <small>{newsstandSession.mode === 'exact' ? 'EXACT ISSUE WORKSPACE' : 'SOURCE SEARCH WORKSPACE'}</small>
                <p>{newsstandSession.preparedQuery}</p>
                <div className="session-cache-stamp"><i />Provider session cache</div>
                <button type="button" onClick={() => setWorkspaceView('newsstand')}>← Back to Newsstand</button>
              </div>
            ) : activeReel ? (
              <div className="reel-source-strip"><span><i />LOCAL ISSUE REEL</span><button type="button" onClick={returnToSearchResults}>Live results</button></div>
            ) : <SourceRunStrip runs={sourceRuns} sources={liveBySlug} />}
            {!newsstandViewerActive && <div className="results">
              {leftPanelResults.map((result) => (
                <button type="button" key={result.id} className={`result-card ${selected?.id === result.id ? 'selected' : ''}`} aria-current={selected?.id === result.id ? 'page' : undefined} data-reel-page-control={activeReel ? 'true' : undefined} onClick={() => setSelectedId(result.id)}>
                    <div className="paper-icon">{result.thumbnail_url ? <img src={result.thumbnail_url} alt="" loading="lazy" referrerPolicy="no-referrer" /> : '▤'}</div>
                  <div>
                    <strong>{result.publication}</strong>
                    <small>{formatDate(result.date)} · Page {result.page ?? '—'} · {providerName(result)}</small>
                    <span className="headline">{result.headline ?? 'Untitled result'}</span>
                    <p>{result.snippet}</p>
                  </div>
                </button>
              ))}
              {!readerResults.length && <div className="empty"><b>No matching pages.</b><span>Broaden the dates or source selection, or open the Newsstand for a specialist archive.</span></div>}
            </div>}
          </aside>

          <section className="center-stage">
            {newsstandViewerActive && newsstandSession ? (
              <>
                <div className="viewer-meta newsstand-viewer-meta">
                  <span>{newsstandSession.sourceName}</span><b>•</b><span>{newsstandSession.mode === 'exact' ? 'EXACT ISSUE' : 'SOURCE SEARCH'}</span><b>•</b><em>{newsstandViewerState.loading ? 'LOADING' : newsstandViewerState.failed || newsstandViewerState.blocked ? 'SOURCE NOTICE' : 'LIVE SOURCE'}</em>
                </div>
                <div className="provider-reader-body">
                  <nav className="provider-viewer-toolbar" aria-label={`${newsstandSession.sourceName} viewer controls`}>
                    <button type="button" onClick={() => controlNewsstandViewer('back')} disabled={Boolean(newsstandControlBusy) || !newsstandViewerState.canGoBack}>← Back</button>
                    <button type="button" onClick={() => controlNewsstandViewer('forward')} disabled={Boolean(newsstandControlBusy) || !newsstandViewerState.canGoForward}>Forward →</button>
                    <button type="button" onClick={() => controlNewsstandViewer('reload')} disabled={Boolean(newsstandControlBusy)}>↻ Reload</button>
                    <div className="provider-location" title={newsstandViewerState.displayUrl || newsstandSession.displayUrl}><i data-loading={newsstandViewerState.loading} />{newsstandViewerState.displayUrl || newsstandSession.displayUrl}</div>
                    <button type="button" onClick={() => controlNewsstandViewer('external')} disabled={Boolean(newsstandControlBusy)}>Open externally ↗</button>
                    <button type="button" className="provider-close" onClick={() => closeNewsstandViewer(`${newsstandSession.sourceName} viewer closed · public API results restored.`)}>Close</button>
                  </nav>
                  <div className="newsstand-provider-frame">
                    <div ref={newsstandViewportRef} className="newsstand-provider-viewport" data-loading={newsstandViewerState.loading}>
                      <div className="provider-loading-card" aria-hidden="true"><span>NEWSSTAND SOURCE</span><strong>{newsstandSession.sourceName}</strong><small>{newsstandViewerState.message || 'The source is loading inside this frame.'}</small></div>
                    </div>
                  </div>
                  <div className="provider-session-note"><i />Sign-in and ordinary website cache stay inside this private {newsstandSession.sourceName} session on this computer. The source owns its pages, search results, downloads, and page-by-page navigation.</div>
                </div>
              </>
            ) : (
              <>
                <div className="viewer-meta">
                  <span>{selected.publication}</span><b>•</b><span>{formatDate(selected.date).toUpperCase()}</span><b>•</b><span>PAGE {selected.page ?? '—'}</span><b>•</b><em>{providerName(selected)}</em>
                </div>
                <div className="reader-body">
                  <div className={`reader-screen ${selected.image_url ? 'has-page-image' : ''}`} style={{ filter: `${invert ? 'invert(1) ' : ''}brightness(${brightness}) contrast(${contrast})` }}>
                    {selected.image_url ? (
                      <img className="archive-page-image" src={selected.image_url} alt={`${activeReel ? `Page ${selected.page} of ${activeReel.pageCount}` : 'Archived page'} from ${selected.publication}`} style={{ transform: `scale(${zoom})` }} referrerPolicy="no-referrer" />
                    ) : (
                      <article className="newspaper" style={{ transform: `scale(${zoom})` }}>
                        <div className="newspaper-kicker">DIGITIZED EDITION · ARCHIVE RESEARCH COPY</div>
                        <h1>{selected.publication}</h1><div className="rule" />
                        <div className="newspaper-meta">{formatDate(selected.date).toUpperCase()} · {selected.location ?? 'ARCHIVE LOCATION'} · {providerName(selected).toUpperCase()}</div>
                        <h2>{selected.headline ?? 'Historical Newspaper Result'}</h2>
                        <div className="columns">
                          <div><h3>ARCHIVE TRANSCRIPT</h3><p>{selected.snippet || 'No summary supplied.'}</p></div>
                          <div className="photo"><div className="archive-mark">MICROFICHE</div><small>PAGE IMAGE NOT SUPPLIED</small></div>
                          <div><h3>RESEARCH NOTE</h3><p>This source supplied metadata or OCR without a directly embeddable page image. Open the original record for the authoritative scan and complete context.</p></div>
                        </div>
                      </article>
                    )}
                  </div>
                  <div className="machine-controls">
                    <div className="nav-control"><button type="button" onClick={() => selectAdjacent(-1)} disabled={selectedIndex <= 0} aria-label="Previous page">◀◀</button><div className="frame-display"><strong>{String(selected.frame ?? selectedIndex + 1).padStart(3, '0')}</strong>{activeReel && <small>OF {String(readerResults.length).padStart(3, '0')}</small>}</div><button type="button" onClick={() => selectAdjacent(1)} disabled={selectedIndex >= readerResults.length - 1} aria-label="Next page">▶▶</button></div>
                    <Knob label="ZOOM" value={zoom} min={0.72} max={1.6} step={0.03} onChange={setZoom} />
                    <Knob label="BRIGHTNESS" value={brightness} min={0.65} max={1.5} step={0.05} onChange={setBrightness} />
                    <Knob label="CONTRAST" value={contrast} min={0.65} max={1.6} step={0.05} onChange={setContrast} />
                    <button className={`machine-button ${invert ? 'active' : ''}`} onClick={() => setInvert((value) => !value)}>◐<span>INVERT</span></button>
                    <button className="machine-button" onClick={() => setZoom(1)}>⌗<span>FIT PAGE</span></button>
                  </div>
                  <div className={`filmstrip ${activeReel ? 'issue-filmstrip' : ''}`} ref={filmstripRef} aria-label={activeReel ? `All ${readerResults.length} pages in this issue` : 'Nearby search result pages'}>
                    {filmFrames.map((result) => {
                      const absoluteIndex = readerResults.findIndex((candidate) => candidate.id === result.id);
                      return (
                      <button type="button" className={`film-frame ${result.id === selected.id ? 'active' : ''}`} key={result.id} aria-label={`Page ${result.page ?? absoluteIndex + 1} of ${readerResults.length}`} aria-current={result.id === selected.id ? 'page' : undefined} tabIndex={activeReel && result.id !== selected.id ? -1 : 0} data-frame-index={absoluteIndex} data-reel-page-control={activeReel ? 'true' : undefined} onClick={() => setSelectedId(result.id)}>
                        {result.thumbnail_url ? <img src={result.thumbnail_url} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <div className="tiny-paper"><b>NEWS</b><span>▥ ▥</span><span>▥ ▥</span></div>}
                        <small>{result.page ?? absoluteIndex + 1}{activeReel ? ` / ${readerResults.length}` : ''}</small>
                      </button>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </section>

          <aside className="right-panel panel">
            {newsstandViewerActive && newsstandSession ? (
              <NewsstandSessionInspector session={newsstandSession} state={newsstandViewerState} />
            ) : (
              <>
                <div className="tabs"><button className={inspectorTab === 'ocr' ? 'active' : ''} onClick={() => setInspectorTab('ocr')}>OCR TEXT</button><button className={inspectorTab === 'metadata' ? 'active' : ''} onClick={() => setInspectorTab('metadata')}>PROVENANCE</button></div>
                {inspectorTab === 'ocr' ? <><input className="ocr-search" value={ocrNeedle} onChange={(event) => setOcrNeedle(event.target.value)} placeholder="Find within supplied OCR" /><pre className="ocr-text">{ocrDisplay}</pre></> : <MetadataPanel result={selected} />}
                <div className="action-row"><button type="button" onClick={openOriginal} disabled={!selected.source_url}>{activeReel ? (selected.source_url ? '↗ Open Source Record' : 'Stored locally') : '↗ Open Original'}</button><button type="button" onClick={copyCitation}>⧉ Copy Citation</button></div>
                {inspectorTab === 'ocr' && <MetadataPanel result={selected} compact />}
              </>
            )}
          </aside>
        </section>
      )}
    </main>
  );
}

function ReelRoom({ reels, libraryState, retryLibrary, draft, setDraft, importIssueReel, openReel, busy, progress }: {
  reels: IssueReelSummary[];
  libraryState: ReelLibraryState;
  retryLibrary: () => void;
  draft: IssueReelImportInput;
  setDraft: (value: IssueReelImportInput | ((current: IssueReelImportInput) => IssueReelImportInput)) => void;
  importIssueReel: (event: FormEvent) => void;
  openReel: (reel: IssueReelSummary) => void;
  busy: boolean;
  progress: IssueReelProgress | null;
}) {
  const progressMaximum = progress?.total && progress.total > 0 ? progress.total : undefined;
  const progressValue = progressMaximum && progress?.current != null ? Math.min(progress.current, progressMaximum) : undefined;
  function updateField(field: keyof IssueReelImportInput, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
  }
  return (
    <section className="reel-room">
      <div className="reel-hero">
        <div>
          <span className="eyebrow">YOUR LOCAL ISSUE CABINET</span>
          <h1>Turn an issue into a reel.</h1>
          <p>Choose a downloaded newspaper PDF or an ordered set of page images. Microfiche makes a private local reading copy, arranges every page as a frame, and keeps its provenance beside the scan.</p>
        </div>
        <div className="reel-format-note" aria-label="Supported issue files"><strong>PDF</strong><span>or ordered</span><strong>JPEG · PNG</strong><small>Stored only in the local Microfiche library</small></div>
      </div>

      <div className="reel-room-grid">
        <form className="reel-import-card" onSubmit={importIssueReel}>
          <div className="reel-card-heading"><span>NEW ISSUE REEL</span><small>Details travel with every page</small></div>
          <div className="reel-form-grid">
            <label className="reel-field reel-field-wide"><span>Publication <b>required</b></span><input required value={draft.publication} onChange={(event) => updateField('publication', event.target.value)} placeholder="The Philadelphia Inquirer" autoComplete="off" /></label>
            <label className="reel-field"><span>Issue date <b>required</b></span><input required type="date" value={draft.issueDate} onChange={(event) => updateField('issueDate', event.target.value)} /></label>
            <label className="reel-field"><span>Edition</span><input value={draft.edition || ''} onChange={(event) => updateField('edition', event.target.value)} placeholder="Morning, final, city…" autoComplete="off" /></label>
            <label className="reel-field"><span>Location</span><input value={draft.location || ''} onChange={(event) => updateField('location', event.target.value)} placeholder="Philadelphia, Pennsylvania" autoComplete="off" /></label>
            <label className="reel-field"><span>Source / collection</span><input value={draft.sourceLabel || ''} onChange={(event) => updateField('sourceLabel', event.target.value)} placeholder="Archive or library name" autoComplete="off" /></label>
            <label className="reel-field reel-field-wide"><span>Source record URL</span><input type="url" value={draft.sourceUrl || ''} onChange={(event) => updateField('sourceUrl', event.target.value)} placeholder="Optional reviewed newspaper archive link" autoComplete="off" /></label>
            <label className="reel-field reel-field-wide"><span>Rights or use note</span><input value={draft.rights || ''} onChange={(event) => updateField('rights', event.target.value)} placeholder="Optional note from the archive record" autoComplete="off" /></label>
          </div>
          <div className="reel-picker">
            <div><strong>Choose the issue copy</strong><span>One PDF, or numbered JPEG/PNG pages selected together. Microfiche orders images naturally by filename, and the originals are never changed.</span></div>
            <button type="submit" disabled={busy}>{busy ? 'Building reel…' : 'Choose issue file…'}</button>
          </div>
          {progress && (
            <div className="reel-progress" role="status" aria-live="polite">
              <div><span>{progress.message}</span>{progressMaximum && progressValue != null && <small>{progressValue} / {progressMaximum}</small>}</div>
              <progress max={progressMaximum || 1} value={progressValue} aria-label={progress.message} />
            </div>
          )}
          <p className="reel-privacy-note">Private by design · the issue stays on this computer and is not uploaded by Microfiche. Searchable text appears only when the document actually supplies it.</p>
        </form>

        <section className="reel-library" aria-labelledby="reel-library-title">
          <div className="reel-card-heading"><span id="reel-library-title">ISSUE REELS</span><small>{libraryState === 'ready' ? `${reels.length} saved locally` : libraryState === 'loading' ? 'opening local cabinet' : 'cabinet unavailable'}</small></div>
          <div className="reel-library-list">
            {reels.map((reel) => (
              <article className="reel-card" key={reel.id}>
                <div className="reel-card-spool" aria-hidden="true"><i /><b>{reel.pageCount}</b><i /></div>
                <div className="reel-card-copy">
                  <span className="reel-card-date">{formatDate(reel.issueDate)}{reel.edition ? ` · ${reel.edition}` : ''}</span>
                  <h2>{reel.publication}</h2>
                  <p>{[reel.location, reel.sourceLabel].filter(Boolean).join(' · ') || 'Local research copy'}</p>
                  <small>{reel.pageCount} page{reel.pageCount === 1 ? '' : 's'} · imported {formatTimestamp(reel.importedAt)}</small>
                </div>
                <button type="button" onClick={() => openReel(reel)} disabled={busy}>Load reel <span>▶</span></button>
              </article>
            ))}
            {libraryState === 'loading' && (
              <div className="reel-library-empty"><div className="empty-reel-spool" aria-hidden="true"><i /><i /></div><strong>Opening the reel cabinet…</strong><span>Checking the private local library on this computer.</span></div>
            )}
            {libraryState === 'error' && (
              <div className="reel-library-empty"><div className="empty-reel-spool" aria-hidden="true"><i /><i /></div><strong>The reel cabinet did not open.</strong><span>Your saved reels were not reported as empty. Retry the local cabinet without re-importing the issue.</span><button type="button" className="reel-retry" onClick={retryLibrary} disabled={busy}>Retry cabinet</button></div>
            )}
            {libraryState === 'ready' && !reels.length && (
              <div className="reel-library-empty"><div className="empty-reel-spool" aria-hidden="true"><i /><i /></div><strong>No issue reels yet.</strong><span>Your first imported issue will wait here, ready to load back into the reader.</span></div>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}

function Newsstand({ catalog, sources, activeShelf, setActiveShelf, engineFilter, setEngineFilter, query, issuePlan, activateEngine, openReelImporter, busy }: {
  catalog: EngineCatalog; sources: EngineSource[]; activeShelf: string; setActiveShelf: (value: string) => void;
  engineFilter: string; setEngineFilter: (value: string) => void; query: string; issuePlan: IssueRoutePlan | null;
  activateEngine: (source: EngineSource) => void; openReelImporter: () => void; busy: boolean;
}) {
  const liveCount = catalog.sources.filter((source) => source.mode === 'federated').length;
  const routeIds = new Set(issuePlan?.routes.map((source) => source.id) ?? []);
  const exactView = Boolean(issuePlan && activeShelf === 'Exact issue');
  const coverageCount = issuePlan?.routes.filter((source) => source.routeKind === 'coverage').length ?? 0;
  const leadCount = issuePlan?.routes.filter((source) => source.routeKind === 'lead').length ?? 0;
  const shelves = issuePlan ? ['Exact issue', 'All shelves', ...catalog.shelves] : ['All shelves', ...catalog.shelves];
  return (
    <section className="newsstand">
      <div className={`newsstand-hero ${exactView ? 'issue-route' : ''}`}>
        {exactView && issuePlan ? (
          <>
            <div><span className="eyebrow">EXACT ISSUE ROUTER</span><h1>{issuePlan.publication}</h1><p>{issuePlan.match === 'exact'
              ? `Coverage matches for ${issuePlan.formattedDate} appear first. Additional source leads are labeled honestly; each opens inside the private viewer with its own access rules.`
              : `Microfiche has no title-specific coverage record for ${issuePlan.formattedDate}. These are careful holdings leads, not claims that the issue is present.`}</p><button className="issue-import-cta" type="button" onClick={openReelImporter}>Import downloaded issue <span>＋</span></button></div>
            <div className="newsstand-stats"><article><strong>{coverageCount}</strong><span>coverage matches</span></article><article><strong>{leadCount}</strong><span>research leads</span></article><article><strong>1×</strong><span>private viewer</span></article></div>
          </>
        ) : (
          <>
            <div><span className="eyebrow">THE RESEARCH ROOM</span><h1>Every newspaper has a door.</h1><p>Search supported public APIs together, then open every specialist collection, library, publisher vault, and paid archive inside Microfiche's private Newsstand viewer.</p></div>
            <div className="newsstand-stats"><article><strong>{catalog.sources.length}</strong><span>curated source doors</span></article><article><strong>{liveCount}</strong><span>public API search</span></article><article><strong>{Math.max(0, catalog.sources.length - liveCount)}</strong><span>in-app viewer doors</span></article></div>
          </>
        )}
      </div>
      <div className="newsstand-toolbar">
        <div className="shelf-tabs">{shelves.map((shelf) => <button key={shelf} className={activeShelf === shelf ? 'active' : ''} onClick={() => setActiveShelf(shelf)}>{shelf}</button>)}</div>
        <input value={engineFilter} onChange={(event) => setEngineFilter(event.target.value)} placeholder="Filter archives, regions, or capabilities…" />
      </div>
      <div className="engine-grid">
        {sources.map((source) => {
          const routeCard = exactView && routeIds.has(source.id);
          const routeKind = source.routeKind ?? (issuePlan?.match === 'exact' ? 'coverage' : 'lead');
          const apiSearch = !routeCard && source.mode === 'federated' && Boolean(source.adapterSlug);
          return (
          <article className={`engine-card ${routeCard ? `route-card route-${routeKind}` : ''}`} key={source.id}>
            <div className="engine-card-top"><span className={`access-badge access-${source.access.toLowerCase()}`}>{source.access}</span><span>{source.era}</span></div>
            <h2>{source.name}</h2><p>{source.description}</p>
            <div className="engine-tags">{source.region && <span>{source.region}</span>}{source.features.slice(0, 3).map((feature) => <span key={feature}>{feature}</span>)}</div>
            <div className="engine-footer"><small>{routeCard
              ? (routeKind === 'coverage' ? 'CATALOG COVERAGE MATCH · ACCESS MAY BE REQUIRED' : 'RESEARCH LEAD · ISSUE PRESENCE UNVERIFIED')
              : apiSearch ? 'SEARCHES THE PUBLIC API INSIDE MICROFICHE' : source.id === 'newspapers-com' && !query.trim() ? 'OPEN NEWSPAPERS.COM TO BROWSE' : source.homeOnly ? 'OPENS IN VIEWER · QUERY COPIED FOR ITS FORM' : 'OPENS IN VIEWER WITH A PREPARED QUERY'}</small><button type="button" onClick={() => activateEngine(source)} disabled={busy}>{apiSearch ? 'Search live' : 'Open in viewer'} {apiSearch ? '⌕' : '▣'}</button></div>
          </article>
          );
        })}
        {!sources.length && <div className="empty engine-empty">No Newsstand engines match that filter.</div>}
      </div>
      <footer className="newsstand-note">{exactView && issuePlan
        ? <>Issue context: <b>{issuePlan.publication} · {issuePlan.formattedDate}</b> · Coverage labels come from the catalog; source leads remain unverified until you inspect them. Each source owns its sign-in, downloads, and page navigation.</>
        : <>Prepared query: <b>{query || 'Enter a search above'}</b> · The live buttons query only their supported public APIs. Every catalog source door is ready in the private viewer, but Microfiche does not claim that all {catalog.sources.length} sources were queried.</>}</footer>
    </section>
  );
}

function SourceRunStrip({ runs, sources }: { runs: SourceRun[]; sources: Map<string, ArchiveSource> }) {
  if (!runs.length) return <div className="source-run-strip"><span>Run a live search to see archive health.</span></div>;
  return <div className="source-run-strip">{runs.map((run) => <span key={run.source} data-ok={run.ok} title={run.error || `${run.count} results in ${run.duration_ms} ms`}><i />{shortSourceName(sources.get(run.source)?.name || run.source)} · {run.ok ? run.count : run.error?.split(';')[0] || 'Unavailable'}</span>)}</div>;
}

function NewsstandSessionInspector({ session, state }: { session: NewsstandViewerSession; state: NewsstandViewerState }) {
  const sessionStatus = state.failed ? 'Source failed to load' : state.blocked ? 'Unsafe navigation blocked' : state.loading ? 'Loading from source' : 'Source ready';
  return (
    <section className="newsstand-session-inspector">
      <div className="tabs"><button className="active" type="button">SOURCE SESSION</button></div>
      <div className="provider-seal" aria-hidden="true"><i /><strong>PRIVATE<br />VIEWER</strong><i /></div>
      <h2>{session.sourceName}</h2>
      <p>The source controls its own search results, scans, OCR, page navigation, and permitted downloads. Microfiche contains any sign-in state and ordinary site cache inside this private viewer session.</p>
      <dl>
        <dt>Access</dt><dd>{session.access}</dd>
        <dt>Research mode</dt><dd>{session.mode === 'exact' ? 'Exact issue' : 'Article search'}</dd>
        <dt>Prepared query</dt><dd>{session.preparedQuery}</dd>
        <dt>Source address</dt><dd>{state.displayUrl || session.displayUrl}</dd>
        <dt>Status</dt><dd>{sessionStatus}</dd>
        <dt>Cache</dt><dd>Browser-managed and persistent on this computer</dd>
      </dl>
      {(state.failed || state.blocked) && state.message && <div className="provider-error" role="alert">{state.message}</div>}
      <div className="provider-control-note"><strong>Viewer-owned controls</strong><span>Image adjustment and the local filmstrip are paused here because the remote source owns page rendering and page-by-page movement.</span></div>
    </section>
  );
}

function MetadataPanel({ result, compact = false }: { result: SearchResult; compact?: boolean }) {
  const metadata = Object.entries(result.metadata || {}).filter(([, value]) => value !== '' && value != null && value !== false);
  return (
    <section className={`metadata ${compact ? 'compact' : ''}`}><h3>ISSUE PROVENANCE</h3><dl>
      <dt>Publication</dt><dd>{result.publication}</dd><dt>Date</dt><dd>{formatDate(result.date)}</dd><dt>Location</dt><dd>{result.location ?? 'Unknown'}</dd><dt>Page</dt><dd>{result.page ?? '—'}</dd><dt>Archive</dt><dd>{providerName(result)}</dd><dt>Rights</dt><dd>{result.rights ?? 'Unknown'}</dd>
      {!compact && metadata.map(([key, value]) => <div className="metadata-row" key={key}><dt>{key.replaceAll('_', ' ')}</dt><dd>{formatMetadata(value)}</dd></div>)}
    </dl></section>
  );
}

function reelResultId(reelId: string, pageNumber: number) { return `issue-reel:${reelId}:${pageNumber}`; }

function reelPageToResult(reel: IssueReel, page: IssueReel['pages'][number]): SearchResult {
  const suppliedText = page.ocrText?.trim() || null;
  const textSource = page.textSource || (suppliedText ? 'embedded' : 'none');
  return {
    id: reelResultId(reel.id, page.number),
    archive: 'local-issue-reel',
    external_id: `${reel.id}:${page.number}`,
    publication: reel.publication,
    date: reel.issueDate,
    location: reel.location || null,
    page: page.number,
    frame: page.number,
    headline: `Page ${page.number} of ${reel.pageCount}`,
    snippet: suppliedText
      ? `${textSource === 'ocr' ? 'Recognized' : 'Embedded'} searchable text is available for this page.`
      : 'No searchable text was found for this page. The scan remains available for visual reading.',
    ocr_text: suppliedText,
    thumbnail_url: page.thumbnailUrl,
    image_url: page.imageUrl,
    source_url: reel.sourceUrl || null,
    rights: reel.rights || null,
    score: null,
    metadata: {
      provider: 'LOCAL ISSUE REEL',
      edition: reel.edition || undefined,
      source_label: reel.sourceLabel || 'Local research copy',
      imported_at: reel.importedAt,
      text_source: textSource === 'none' ? 'No searchable text supplied' : textSource,
      image_dimensions: page.width && page.height ? `${page.width} × ${page.height}` : undefined,
      page_sha256: page.sha256,
    },
  };
}

function providerName(result: SearchResult) { return typeof result.metadata?.provider === 'string' ? result.metadata.provider : result.archive; }
function shortSourceName(name: string) { return name.replace('Library of Congress · ', 'LOC ').replace('Internet Archive · ', 'IA ').replace('DigitalNZ · ', ''); }
function normalizedPublication(value: string) { return value.toLocaleLowerCase('en-US').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
function formatDate(value: string | null) { if (!value) return 'Unknown date'; const parsed = new Date(`${value}T00:00:00`); return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
function formatTimestamp(value: string) { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
function formatMetadata(value: unknown) { if (Array.isArray(value)) return value.join(', '); if (typeof value === 'object' && value) return JSON.stringify(value); return String(value); }

function Knob({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  const percentage = (value - min) / (max - min);
  return <label className="knob-wrap"><span>{label}</span><input className="knob-range" type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /><div className="knob" style={{ transform: `rotate(${-130 + percentage * 260}deg)` }}><i /></div></label>;
}

export default App;
