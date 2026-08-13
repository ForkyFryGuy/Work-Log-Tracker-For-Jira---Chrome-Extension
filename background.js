// Service worker. Its only job is turning a toolbar click or the keyboard
// shortcut into a "toggle" message for the content script running in the Jira
// tab. All real work happens in the content script, because that is the only
// place with the user's Jira session cookie.

const HOST_ID = "jira-worklog-status-reporter-host";

// Must match manifest.content_scripts[0].js, in the same order.
const FILES = ["src/util.js", "src/query.js", "src/api.js", "src/reports.js", "src/panel.js"];

async function toggleInTab(tab) {
  if (!tab || !tab.id) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "JR_TOGGLE" });
    return;
  } catch (_) {
    // No live content script. Either the tab predates this install, or the
    // extension was reloaded while the tab was open — which orphans the old
    // content script and leaves a dead panel in the page.
  }

  try {
    // Clear any orphaned panel first, or we'd just re-reveal the dead one.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (id) => {
        const el = document.getElementById(id);
        if (el) el.remove();
      },
      args: [HOST_ID],
    });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: FILES });
    await chrome.tabs.sendMessage(tab.id, { type: "JR_TOGGLE" });
  } catch (err) {
    // Almost always means this isn't a Jira Cloud tab.
    console.debug("[jira-reporter] could not inject:", err.message);
  }
}

chrome.action.onClicked.addListener(toggleInTab);

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-panel") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  toggleInTab(tab);
});
