/// <reference types="vite/client" />

interface Window {
  foxtail?: {
    apiBaseUrl: string;
    platform: string;
    getNewspaperSources: () => Promise<import('./types').EngineCatalog>;
    getIssueRoutes: (publication: string, issueDate: string) => Promise<import('./types').IssueRoutePlan>;
    activateNewsstandSource: (
      sourceId: string,
      context: import('./types').HandoffContext,
    ) => Promise<import('./types').NewsstandViewerSession>;
    showNewsstandSource: (
      bounds: { x: number; y: number; width: number; height: number },
    ) => Promise<import('./types').NewsstandViewerState>;
    hideNewsstandSource: () => Promise<import('./types').NewsstandViewerState>;
    deactivateNewsstandSource: () => Promise<import('./types').NewsstandViewerState>;
    controlNewsstandSource: (
      action: import('./types').NewsstandViewerAction,
    ) => Promise<import('./types').NewsstandViewerControlResult>;
    onNewsstandViewState: (
      listener: (state: import('./types').NewsstandViewerState) => void,
    ) => () => void;
    openResearchUrl: (url: string) => Promise<{ opened: boolean }>;
    copyText: (value: string) => Promise<{ copied: boolean }>;
    listIssueReels: () => Promise<import('./types').IssueReelSummary[]>;
    getIssueReel: (id: string) => Promise<import('./types').IssueReel>;
    importIssueReel: (metadata: import('./types').IssueReelImportInput) => Promise<import('./types').IssueReelImportResult>;
    onIssueReelProgress: (listener: (progress: import('./types').IssueReelProgress) => void) => () => void;
  };
}
