const form = document.querySelector("#crawl-form");
const startButton = document.querySelector("#start-button");
const modeInput = document.querySelector("#mode");
const concurrencyInput = document.querySelector("#concurrency");
const navigationTimeoutRow = document.querySelector("#navigation-timeout-row");
const statePill = document.querySelector("#state-pill");
const stateLabel = document.querySelector("#state-label");
const sessionTitle = document.querySelector("#session-title");
const progressFill = document.querySelector("#progress-fill");
const progressTrack = document.querySelector(".progress-track");
const progressSummary = document.querySelector("#progress-summary");
const progressPercent = document.querySelector("#progress-percent");
const errorMessage = document.querySelector("#error-message");
const resultsBody = document.querySelector("#results-body");
const searchInput = document.querySelector("#search");
const sortInput = document.querySelector("#sort-by");
const resultCount = document.querySelector("#result-count");
const downloadCsv = document.querySelector("#download-csv");
const downloadJson = document.querySelector("#download-json");
const dialog = document.querySelector("#detail-dialog");
const crawlPasswordRow = document.querySelector("#crawl-password-row");
const crawlPasswordInput = document.querySelector("#crawl-password");
const startUrlInput = document.querySelector("#start-url");
let pages = [];
let currentState = "idle";
let pollTimer;

const numberFormat = new Intl.NumberFormat();

function setError(message) {
  errorMessage.textContent = message;
  errorMessage.classList.toggle("hidden", !message);
}

function setState(state) {
  currentState = state;
  statePill.className = `state-pill state-${state}`;
  stateLabel.textContent = state.toUpperCase();
  startButton.disabled = state === "running";
  startButton.querySelector("span:nth-child(2)").textContent =
    state === "running" ? "Crawl in progress…" : "Start crawling";

  if (state === "running") {
    sessionTitle.textContent = "Crawling in progress";
  } else if (state === "completed") {
    sessionTitle.textContent = "Crawl complete";
  } else if (state === "failed") {
    sessionTitle.textContent = "Crawl needs attention";
  } else {
    sessionTitle.textContent = "Ready when you are";
  }
}

function renderProgress(progress, stats) {
  if (!progress && !stats) {
    document.querySelector("#stat-scraped").textContent = "—";
    document.querySelector("#stat-discovered").textContent = "—";
    document.querySelector("#stat-outstanding").textContent = "—";
    document.querySelector("#stat-outcomes").textContent = "—";
    document.querySelector("#stat-max-workers").textContent = "Max workers: —";
    progressSummary.textContent = "Enter a URL and start your first crawl.";
    progressPercent.textContent = "0 / 1,000";
    progressFill.style.width = "0%";
    progressTrack.setAttribute("aria-valuenow", "0");
    return;
  }

  const values = stats ?? progress;
  const completed = progress?.completedPages ??
    values.scrapedPages + values.failedPages + values.skippedPages;
  const limit = Number(document.querySelector("#max-pages").value) || 1000;
  const percent = Math.min(100, (completed / limit) * 100);
  document.querySelector("#stat-scraped").textContent = numberFormat.format(values.scrapedPages);
  document.querySelector("#stat-discovered").textContent = numberFormat.format(values.discoveredUrls);
  document.querySelector("#stat-outstanding").textContent = numberFormat.format(values.outstandingTasks);
  document.querySelector("#stat-outcomes").textContent =
    `${numberFormat.format(values.failedPages)} / ${numberFormat.format(values.skippedPages)}`;
  document.querySelector("#stat-max-workers").textContent =
    `Max workers: ${numberFormat.format(values.maxObservedConcurrency)}`;
  progressSummary.textContent = `${numberFormat.format(completed)} pages completed · ${numberFormat.format(values.queuedUrls)} unique URLs queued`;
  progressPercent.textContent = `${numberFormat.format(completed)} / ${numberFormat.format(limit)}`;
  progressFill.style.width = `${percent}%`;
  progressTrack.setAttribute("aria-valuemax", String(limit));
  progressTrack.setAttribute("aria-valuenow", String(Math.min(completed, limit)));
}

function makeCell(className, text) {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  cell.textContent = text;
  return cell;
}

function visiblePages() {
  const query = searchInput.value.trim().toLowerCase();
  const filtered = pages.filter((page) => {
    const text = [
      page.title,
      page.url,
      page.description,
      ...page.headings,
    ].join(" ").toLowerCase();
    return text.includes(query);
  });

  const sortBy = sortInput.value;
  filtered.sort((left, right) => {
    if (sortBy === "links") return right.linksCount - left.linksCount;
    if (sortBy === "url") return left.url.localeCompare(right.url);
    return left.title.localeCompare(right.title);
  });
  return filtered;
}

function showDetails(page) {
  document.querySelector("#detail-title").textContent = page.title || "Untitled page";
  const url = document.querySelector("#detail-url");
  url.textContent = page.url;
  url.href = page.url;
  document.querySelector("#detail-description").textContent =
    page.description || "No meta description was found.";
  document.querySelector("#detail-links").textContent =
    `${numberFormat.format(page.linksCount)} links`;
  try {
    document.querySelector("#detail-host").textContent = new URL(page.url).hostname;
  } catch {
    document.querySelector("#detail-host").textContent = "";
  }

  const headingList = document.querySelector("#detail-headings");
  headingList.replaceChildren();
  if (page.headings.length === 0) {
    const item = document.createElement("li");
    item.textContent = "No headings were found.";
    headingList.append(item);
  } else {
    for (const heading of page.headings) {
      const item = document.createElement("li");
      item.textContent = heading;
      headingList.append(item);
    }
  }
  dialog.showModal();
}

function renderPages() {
  const visible = visiblePages();
  resultsBody.replaceChildren();

  if (visible.length === 0) {
    const row = document.createElement("tr");
    row.className = "empty-row";
    const cell = document.createElement("td");
    cell.colSpan = 5;
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const title = document.createElement("strong");
    const detail = document.createElement("span");
    if (pages.length === 0) {
      title.textContent = currentState === "running" ? "Collecting pages…" : "No pages yet";
      detail.textContent = currentState === "running"
        ? "Results will appear here when the crawl finishes."
        : "Your extracted pages will appear here when the crawl completes.";
    } else {
      title.textContent = "No matching pages";
      detail.textContent = "Try a different search term.";
    }
    empty.append(title, detail);
    cell.append(empty);
    row.append(cell);
    resultsBody.append(row);
  } else {
    for (const page of visible) {
      const row = document.createElement("tr");
      row.className = "data-row";
      row.addEventListener("click", () => showDetails(page));

      const pageCell = document.createElement("td");
      const title = document.createElement("span");
      title.className = "page-title";
      title.textContent = page.title || "Untitled page";
      title.title = title.textContent;
      const url = document.createElement("span");
      url.className = "page-url";
      url.textContent = page.url;
      url.title = page.url;
      pageCell.append(title, url);

      const description = makeCell(
        "description-cell",
        page.description || "—"
      );
      const headings = makeCell("", numberFormat.format(page.headings.length));
      const links = document.createElement("td");
      const chip = document.createElement("span");
      chip.className = "count-chip";
      chip.textContent = numberFormat.format(page.linksCount);
      links.append(chip);

      const detailCell = document.createElement("td");
      const detailButton = document.createElement("button");
      detailButton.type = "button";
      detailButton.className = "details-button";
      detailButton.setAttribute("aria-label", `View details for ${page.title || page.url}`);
      detailButton.textContent = "↗";
      detailButton.addEventListener("click", (event) => {
        event.stopPropagation();
        showDetails(page);
      });
      detailCell.append(detailButton);
      row.append(pageCell, description, headings, links, detailCell);
      resultsBody.append(row);
    }
  }

  resultCount.textContent = pages.length === 0
    ? "Waiting for results"
    : `${numberFormat.format(visible.length)} of ${numberFormat.format(pages.length)} pages`;
}

function setDownloadsEnabled(enabled) {
  for (const link of [downloadCsv, downloadJson]) {
    link.classList.toggle("disabled", !enabled);
    link.setAttribute("aria-disabled", String(!enabled));
    if (enabled) link.removeAttribute("tabindex");
    else link.setAttribute("tabindex", "-1");
  }
  searchInput.disabled = !enabled;
  sortInput.disabled = !enabled;
}

async function loadResults() {
  const response = await fetch("/api/results", { cache: "no-store" });
  if (!response.ok) throw new Error("The crawl completed, but its results could not be loaded.");
  pages = await response.json();
  setDownloadsEnabled(true);
  searchInput.disabled = false;
  sortInput.disabled = false;
  renderPages();
}

async function refreshStatus() {
  const response = await fetch("/api/status", { cache: "no-store" });
  if (!response.ok) throw new Error("Could not read crawl status from the dashboard server.");
  const status = await response.json();
  setState(status.state);
  renderProgress(status.progress, status.stats);
  setError(status.error);
  if (status.state === "completed" && pages.length === 0) {
    await loadResults();
  }
  renderPages();

  if (status.state === "running") {
    pollTimer = window.setTimeout(pollStatus, 900);
  } else {
    pollTimer = undefined;
  }
}

async function pollStatus() {
  try {
    await refreshStatus();
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
    pollTimer = window.setTimeout(pollStatus, 2000);
  }
}

modeInput.addEventListener("change", () => {
  const browserMode = modeInput.value === "browser";
  concurrencyInput.max = browserMode ? "3" : "10";
  if (browserMode && Number(concurrencyInput.value) > 3) {
    concurrencyInput.value = "3";
  }
  navigationTimeoutRow.classList.toggle("hidden", !browserMode);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (currentState === "running") return;
  if (!form.reportValidity()) return;

  if (pollTimer !== undefined) window.clearTimeout(pollTimer);
  setError("");
  pages = [];
  renderPages();
  renderProgress(null, null);
  setDownloadsEnabled(false);

  const payload = {
    startUrl: document.querySelector("#start-url").value.trim(),
    maxDepth: Number(document.querySelector("#max-depth").value),
    maxPages: Number(document.querySelector("#max-pages").value),
    concurrency: Number(document.querySelector("#concurrency").value),
    requestDelayMs: Number(document.querySelector("#delay").value),
    mode: modeInput.value,
    navigationTimeoutMs: Number(document.querySelector("#navigation-timeout").value),
  };

  startButton.disabled = true;
  try {
    const response = await fetch("/api/crawl", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(crawlPasswordInput.value
          ? { "x-dashboard-password": crawlPasswordInput.value }
          : {}),
      },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not start the crawl.");
    crawlPasswordInput.value = "";
    setState("running");
    pollTimer = window.setTimeout(pollStatus, 300);
  } catch (error) {
    setState("idle");
    setError(error instanceof Error ? error.message : String(error));
  }
});

searchInput.addEventListener("input", renderPages);
sortInput.addEventListener("change", renderPages);
setDownloadsEnabled(false);
modeInput.dispatchEvent(new Event("change"));

async function initializeDashboard() {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) throw new Error("Could not load dashboard configuration.");
    const config = await response.json();
    if (config.crawlPasswordRequired) {
      document.querySelector("#workspace-indicator").lastChild.textContent =
        " Public workspace";
      crawlPasswordRow.classList.remove("hidden");
      crawlPasswordInput.required = true;
      modeInput.value = "http";
      modeInput.querySelector('option[value="browser"]').remove();
      document.querySelector("#navigation-timeout-row").classList.add("hidden");
      document.querySelector("#mode").disabled = true;

      const limits = config.crawlLimits;
      const depthInput = document.querySelector("#max-depth");
      const pagesInput = document.querySelector("#max-pages");
      depthInput.max = String(limits.maxDepth);
      pagesInput.max = String(limits.maxPages);
      pagesInput.value = String(Math.min(Number(pagesInput.value), limits.maxPages));
      concurrencyInput.max = String(limits.maxConcurrency);
      concurrencyInput.value = String(
        Math.min(Number(concurrencyInput.value), limits.maxConcurrency)
      );
      document.querySelector("#delay").min = String(limits.minRequestDelayMs);
      document.querySelector("#delay").value = String(limits.minRequestDelayMs);
      document.querySelector(".policy-note p").textContent =
        `Crawl is restricted to approved domains (${config.crawlHosts.join(", ")}). Check robots.txt and crawl responsibly.`;
      if (config.crawlHosts.length > 0) {
        startUrlInput.value = `https://${config.crawlHosts[0]}/`;
      }
      modeInput.dispatchEvent(new Event("change"));
    }
    await refreshStatus();
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
}

initializeDashboard();
