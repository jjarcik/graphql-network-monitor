// Isolated-world content script: forwards reports from hook.js to the background worker.
// It can be injected more than once (registered script + executeScript), so guard against double listeners.
if (!globalThis.__gqlInspectorRelay) {
  globalThis.__gqlInspectorRelay = true;
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.__gqlInspector !== 1) return;
    try {
      chrome.runtime.sendMessage({ type: 'gql-page', payload: event.data }).catch(() => {});
    } catch {
      // Extension was reloaded – this content script is orphaned.
    }
  });
}
