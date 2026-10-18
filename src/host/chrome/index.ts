/** The raw ports a Chrome-extension host answers the kernel's asks with: the browser's tabs, its credential rows, its on-device prompt model and embedder, and its Google sign-in. */
export { createPageExecutor, PageCommandError, type PageExecutor, type TabElement } from './tabs/executor.js';
export { chromeTabPort } from './tabs/port.js';
export { runPageContentScript } from './tabs/content.js';
export type { ChromeRuntimeApi, ChromeTabsApi, PageMessage, PageReply } from './tabs/messages.js';
export { CHROME_CREDENTIAL_MASTER_KEY, CHROME_CREDENTIAL_ROWS_KEY, chromeCredentialRows, createChromeCredentialStore, type ChromeStorageArea } from './credentials.js';
export { ChromePortError, type ChromePortErrorCode } from './errors.js';
export { chromePromptModel, PROMPT_TIMEOUT_MS, type ChromeLanguageModel, type ChromeModelSession, type ChromePromptModelOptions } from './prompt.js';
export { transformersEmbedder, type FeatureExtractor, type OnDeviceEmbedderPort, type TransformersEmbedderOptions } from './embedder.js';
export { firebaseKeyedFetch, googleSignIn, type ChromeIdentityApi, type GoogleSignInOptions, type KeptCredential } from './signIn.js';
