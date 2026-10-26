export type SearchResult = {
  id: string;
  archive: string;
  external_id: string;
  publication: string;
  date: string | null;
  location: string | null;
  page: number | null;
  frame: number | null;
  headline: string | null;
  snippet: string | null;
  ocr_text: string | null;
  thumbnail_url: string | null;
  image_url: string | null;
  source_url: string | null;
  rights: string | null;
  score: number | null;
  metadata: Record<string, unknown>;
};

export type SourceRun = {
  source: string;
  ok: boolean;
  count: number;
  error?: string | null;
  duration_ms: number;
};

export type SearchRequest = {
  query: string;
  date_from?: string | null;
  date_to?: string | null;
  publication?: string | null;
  location?: string | null;
  sources?: string[] | null;
  limit?: number;
};

export type SearchResponse = {
  query: SearchRequest;
  results: SearchResult[];
  source_runs: SourceRun[];
  cache_hit: boolean;
  cache_ttl_seconds: number;
};

export type ArchiveSource = {
  slug: string;
  name: string;
  description: string;
  region: string;
  access: string;
  homepage: string;
  mode: 'federated';
  enabled: boolean;
};

export type EngineSource = {
  id: string;
  adapterSlug?: string;
  name: string;
  shelf: string;
  mode: 'federated' | 'handoff';
  access: string;
  era: string;
  region?: string;
  description: string;
  features: string[];
  aliases: string[];
  homeOnly: boolean;
  issueBrowse: boolean;
  coverageStart: string | null;
  coverageEnd: string | null;
  routeKind?: 'coverage' | 'lead';
};

export type EngineCatalog = {
  shelves: string[];
  sources: EngineSource[];
};

export type SearchMode = 'articles' | 'exact';

export type HandoffContext = {
  mode: SearchMode;
  query?: string;
  publication?: string;
  issueDate?: string;
};

export type NewsstandCacheMode = 'browser-managed-persistent' | 'browser-managed-ephemeral';

export type NewsstandViewerSession = {
  sourceId: string;
  sourceName: string;
  access: string;
  preparedQuery: string;
  copiedQuery: boolean;
  copiedContext: boolean;
  displayUrl: string;
  mode: SearchMode;
  cacheMode: NewsstandCacheMode;
};

export type NewsstandViewerState = {
  active: boolean;
  visible: boolean;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  sourceId?: string;
  sourceName?: string;
  access?: string;
  displayUrl?: string;
  mode?: SearchMode;
  cacheMode?: NewsstandCacheMode;
  blocked?: boolean;
  failed?: boolean;
  message?: string;
};

export type NewsstandViewerAction = 'back' | 'forward' | 'reload' | 'home' | 'external';

export type NewsstandViewerControlResult = {
  action: NewsstandViewerAction;
  state: NewsstandViewerState;
};

export type IssueRoutePlan = {
  publication: string;
  issueDate: string;
  formattedDate: string;
  match: 'exact' | 'fallback';
  routes: EngineSource[];
};

export type IssueReelImportInput = {
  publication: string;
  issueDate: string;
  location?: string;
  edition?: string;
  sourceLabel?: string;
  sourceUrl?: string;
  rights?: string;
};

export type IssueReelPage = {
  number: number;
  imageUrl: string;
  thumbnailUrl: string;
  ocrText?: string | null;
  textSource?: 'embedded' | 'ocr' | 'none' | null;
  sha256?: string;
  width?: number | null;
  height?: number | null;
};

export type IssueReelSummary = {
  id: string;
  publication: string;
  issueDate: string;
  pageCount: number;
  location?: string | null;
  edition?: string | null;
  sourceLabel?: string | null;
  sourceUrl?: string | null;
  rights?: string | null;
  importedAt: string;
};

export type IssueReel = IssueReelSummary & {
  pages: IssueReelPage[];
};

export type IssueReelProgress = {
  stage: string;
  message: string;
  current?: number;
  total?: number;
};

export type IssueReelImportResult =
  | { canceled: true }
  | { canceled: false; reel: IssueReel };
