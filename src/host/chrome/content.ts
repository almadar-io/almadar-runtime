/** The page-side half of the tab port: the one script an extension injects into pages. */
export { runPageContentScript } from './tabs/content.js';
export type { ChromeRuntimeApi, PageMessage } from './tabs/messages.js';
export { createPageExecutor, type PageExecutor } from './tabs/executor.js';
