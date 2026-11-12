function ready(fn) {
  if (document.readyState !== "loading") {
    fn();
  } else {
    document.addEventListener("DOMContentLoaded", fn);
  }
}

const ATTACHMENTID_COL_NAME = "attachment_id";
const DEFAULTZOOM_COL_NAME = "default_zoom";
const DOCTITLE_COL_NAME = "doc_title";

const DEFAULTZOOM_ALLOWED_VALUES = ["auto", "page-actual", "page-width", "page-fit"];
// The legacy ViewerJS viewer (still used for ODF documents) doesn't know 'page-fit'.
const VIEWERJS_ZOOM_VALUES = ["auto", "page-actual", "page-width"];

let gristAccessToken = null;
// Time (ms since epoch) after which the token must be renewed. Grist access tokens are
// short-lived, so a cached token eventually stops working.
let gristAccessTokenRenewAt = 0;
const TOKEN_DEFAULT_TTL_MS = 5 * 60 * 1000;  // Used if Grist doesn't say how long the token lives.
const TOKEN_RENEW_MARGIN_MS = 60 * 1000;     // Renew this long before actual expiry.
// Key describing what is currently displayed, so we don't reload needlessly.
let previousUrl = null;

// State for navigating between multiple attachments on the current row.
let currentAttachmentIds = [];
let currentAttachmentIndex = 0;
let currentMappedRecord = null;

// pdf.js viewer (persistent iframe, reused across PDFs).
let pdfFrame = null;
let pdfAppPromise = null;

// Search state for text and HTML attachments.
let searchRoot = null;
let searchHits = [];
let searchIndex = -1;

function setStatus(msg) {
  let statusElem = document.querySelector("#status");
  if (!statusElem) return false;
  statusElem.innerHTML = msg;
  setVisible("#status", true);
  return true;
}

function setVisible(querySelector, isVisible) {
  let elem = document.querySelector(querySelector);
  if (!elem) return false;
  elem.style.display = isVisible ? "block" : "none";
  return true;
}

function handleError(err) {
  previousUrl = null;
  if (!setStatus(err)) {
    console.error("viewerjs: FATAL: ", err);
    document.body.innerHTML = String(err);
    return;
  }
  console.error("viewerjs: ", err);
}

async function gristGetAttachmentURL(attachmentId) {
  if (!(/^\d+$/.test(attachmentId))) {
    let msg = `Invalid Grist attachment id '${attachmentId}'. It should be an integer but is of type '${typeof attachmentId}'.`;
    console.error(`viewerjs: ${msg}`);
    throw new Error(msg);
  }
  attachmentId = Number(attachmentId);
  // Get a Grist access token if we don't have one yet, or if ours is about to expire.
  if (!gristAccessToken || Date.now() >= gristAccessTokenRenewAt) {
    console.log(`viewerjs: Getting new Grist access token.`);
    let requestedAt = Date.now();
    gristAccessToken = await grist.docApi.getAccessToken({ readOnly: true });
    let ttl = Number(gristAccessToken.ttlMsecs) || TOKEN_DEFAULT_TTL_MS;
    gristAccessTokenRenewAt = requestedAt + Math.max(ttl - TOKEN_RENEW_MARGIN_MS, ttl / 2);
  }
  // Use the token to get a URL to the attachment.
  let url = `${gristAccessToken.baseUrl}/attachments/${attachmentId}/download?auth=${gristAccessToken.token}`;
  console.log(`viewerjs: Obtained Grist attachment URL: '${url}'`);
  return url;
}

async function detectFileType(url) {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    const contentType = (response.headers.get('Content-Type') || '').toLowerCase();
    if (contentType.includes('pdf')) return 'pdf';
    if (contentType.includes('application/vnd.oasis.opendocument')) return 'odf';
    if (contentType.startsWith('image/')) return 'image';
    if (contentType.startsWith('text/html') || contentType.includes('xhtml')) return 'html';
    if (contentType.startsWith('text/')) return 'text';
    return 'unknown';
  } catch (e) {
    console.warn('viewerjs: Could not detect file type, defaulting to PDF viewer.', e);
    return 'pdf';
  }
}

// Normalizes the mapped attachment column's value into an array of attachment IDs.
// Handles a native Grist Attachments column (array, possibly with a leading 'L' list-cell
// marker), as well as a single integer for backward compatibility with formula-column setups.
function parseAttachmentIds(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    let items = (value[0] === 'L') ? value.slice(1) : value;
    return items.filter((x) => /^\d+$/.test(String(x))).map(Number);
  }
  if (/^\d+$/.test(String(value))) return [Number(value)];
  return [];
}

function getZoomSetting(mappedRecord, allowedValues) {
  if (!mappedRecord || !(DEFAULTZOOM_COL_NAME in mappedRecord)) return null;
  let zoom = mappedRecord[DEFAULTZOOM_COL_NAME];
  if (!zoom) return null;
  if (!allowedValues.includes(zoom)) {
    console.warn(`viewerjs: Supplied default zoom setting '${zoom}' is not valid. Valid values are:`, allowedValues);
    return null;
  }
  return zoom;
}

function getDocTitle(mappedRecord) {
  if (!mappedRecord || !(DOCTITLE_COL_NAME in mappedRecord)) return "";
  let title = mappedRecord[DOCTITLE_COL_NAME];
  return title == null ? "" : String(title);
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

// Shows one of the two panes inside #viewer: 'pdf' (persistent pdf.js iframe)
// or 'content' (everything else, rebuilt for each attachment).
function showPane(name) {
  document.querySelector("#pdf-pane").style.display = (name === 'pdf') ? "block" : "none";
  document.querySelector("#content-pane").style.display = (name === 'content') ? "block" : "none";
}

// Shows the viewer and hides the status message.
function revealViewer() {
  setVisible("#viewer", true);
  setVisible("#status", false);
}

function setTitleBar(title) {
  let elem = document.querySelector("#doc-title");
  elem.textContent = title || "";
  elem.style.display = title ? "block" : "none";
}

function resetViewer(statusMsg) {
  previousUrl = null;
  currentAttachmentIds = [];
  currentAttachmentIndex = 0;
  currentMappedRecord = null;
  document.querySelector("#content-pane").innerHTML = "";
  showPane(null);
  setTitleBar("");
  setSearchTarget(null);
  updateNavBar();
  setStatus(statusMsg);
  setVisible("#viewer", false);
}

function updateNavBar() {
  let navElem = document.querySelector("#attachment-nav");
  if (!navElem) return;
  if (currentAttachmentIds.length <= 1) {
    navElem.style.display = "none";
    return;
  }
  navElem.style.display = "flex";
  document.querySelector("#attachment-counter").textContent = `📎 Attachment ${currentAttachmentIndex + 1} of ${currentAttachmentIds.length}`;
  document.querySelector("#prev-attachment").disabled = (currentAttachmentIndex <= 0);
  document.querySelector("#next-attachment").disabled = (currentAttachmentIndex >= currentAttachmentIds.length - 1);
}

function showAttachmentAt(index) {
  if (index < 0 || index >= currentAttachmentIds.length) return;
  currentAttachmentIndex = index;
  updateNavBar();
  displayAttachment(currentAttachmentIds[currentAttachmentIndex], currentMappedRecord).catch(handleError);
}

// ---------------------------------------------------------------------------
// PDF: Mozilla pdf.js viewer (includes its own search bar, Ctrl+F)
// ---------------------------------------------------------------------------

// Creates the pdf.js viewer iframe (once) and resolves with its PDFViewerApplication.
function getPdfApp() {
  if (pdfAppPromise) return pdfAppPromise;
  pdfAppPromise = new Promise((resolve, reject) => {
    // pdf.js dispatches 'webviewerloaded' on the parent document before it initializes,
    // which is the moment to set its options.
    const onViewerLoaded = (event) => {
      const win = event.detail && event.detail.source;
      if (!pdfFrame || win !== pdfFrame.contentWindow) return;
      document.removeEventListener("webviewerloaded", onViewerLoaded);
      try {
        const opts = win.PDFViewerApplicationOptions;
        opts.set("disablePreferences", true);  // Don't let stored preferences override ours.
        opts.set("defaultUrl", "");            // Don't open the bundled sample document.
        opts.set("enableScripting", false);    // Never run JavaScript embedded in PDFs.
        opts.set("disableHistory", true);      // Don't touch the browser history.
        win.PDFViewerApplication.initializedPromise.then(() => resolve(win.PDFViewerApplication), reject);
      } catch (e) {
        reject(e);
      }
    };
    document.addEventListener("webviewerloaded", onViewerLoaded);
    pdfFrame = document.createElement("iframe");
    pdfFrame.className = "viewer-frame";
    pdfFrame.setAttribute('allowFullScreen', '');
    pdfFrame.src = "pdfjs/web/viewer.html";
    document.querySelector("#pdf-pane").appendChild(pdfFrame);
  });
  pdfAppPromise.catch(() => { pdfAppPromise = null; });
  return pdfAppPromise;
}

async function displayPdf(documentUrl, mappedRecord) {
  const zoom = getZoomSetting(mappedRecord, DEFAULTZOOM_ALLOWED_VALUES) || "auto";
  const key = `pdf|${zoom}|${documentUrl}`;
  setTitleBar(getDocTitle(mappedRecord));
  setSearchTarget(null);
  if (key === previousUrl) {
    console.log(`viewerjs: Not reloading the PDF as its URL hasn't changed.`);
    showPane('pdf');
    return;
  }
  previousUrl = key;
  document.querySelector("#content-pane").innerHTML = "";
  showPane('pdf');
  // The viewer must be visible while it initializes so it can measure its layout.
  revealViewer();
  const app = await getPdfApp();
  pdfFrame.contentWindow.PDFViewerApplicationOptions.set("defaultZoomValue", zoom);
  console.log(`viewerjs: Opening PDF '${documentUrl}' in pdf.js.`);
  await app.open({ url: documentUrl });
}

// ---------------------------------------------------------------------------
// ODF (odt/ods/odp): legacy ViewerJS viewer
// ---------------------------------------------------------------------------

function displayOdf(documentUrl, mappedRecord) {
  let viewerBaseUrl = `${window.location.origin + window.location.pathname.slice(0, window.location.pathname.lastIndexOf('/'))}/ViewerJS/`;
  let viewerParams = [];
  let zoom = getZoomSetting(mappedRecord, VIEWERJS_ZOOM_VALUES);
  if (zoom) viewerParams.push(`zoom=${encodeURIComponent(zoom)}`);
  let title = getDocTitle(mappedRecord);
  if (title) viewerParams.push(`title=${encodeURIComponent(title)}`);
  let viewerFullUrl = `${viewerBaseUrl}?${viewerParams.join("&")}#${documentUrl}`;
  setTitleBar("");  // ViewerJS shows the title in its own header.
  setSearchTarget(null);
  showPane('content');
  if (viewerFullUrl === previousUrl) return;
  previousUrl = viewerFullUrl;
  console.log(`viewerjs: Setting ODF viewer URL to '${viewerFullUrl}'.`);
  let pane = document.querySelector("#content-pane");
  pane.innerHTML = "";
  let iframeElem = document.createElement("iframe");
  iframeElem.src = viewerFullUrl;
  iframeElem.className = "viewer-frame";
  iframeElem.setAttribute('allowFullScreen', '');
  pane.appendChild(iframeElem);
}

// ---------------------------------------------------------------------------
// Images, text and HTML
// ---------------------------------------------------------------------------

function displayImage(documentUrl, mappedRecord) {
  setTitleBar(getDocTitle(mappedRecord));
  setSearchTarget(null);
  showPane('content');
  if (documentUrl === previousUrl) return;
  previousUrl = documentUrl;
  console.log(`viewerjs: Displaying image '${documentUrl}'.`);
  let pane = document.querySelector("#content-pane");
  pane.innerHTML = "";
  let wrapper = document.createElement("div");
  wrapper.className = "image-wrapper";
  let imgElem = document.createElement("img");
  imgElem.src = documentUrl;
  imgElem.className = "viewer-image";
  wrapper.appendChild(imgElem);
  pane.appendChild(wrapper);
}

async function displayText(documentUrl, mappedRecord) {
  setTitleBar(getDocTitle(mappedRecord));
  showPane('content');
  if (documentUrl === previousUrl) return;
  previousUrl = documentUrl;
  console.log(`viewerjs: Displaying text file '${documentUrl}'.`);
  let pane = document.querySelector("#content-pane");
  pane.innerHTML = "";
  const response = await fetch(documentUrl);
  const text = await response.text();
  let preElem = document.createElement("pre");
  preElem.className = "viewer-text";
  preElem.textContent = text;
  pane.appendChild(preElem);
  revealViewer();  // Search skips invisible text, so show the viewer first.
  setSearchTarget(preElem);
}

// Renders an HTML attachment in a sandboxed iframe. The sandbox omits 'allow-scripts', so no
// script in the file can run (the widget holds a Grist access token). 'allow-same-origin' is
// kept so this widget can read the frame's DOM to search and highlight text in it.
async function displayHtml(documentUrl, mappedRecord) {
  setTitleBar(getDocTitle(mappedRecord));
  showPane('content');
  if (documentUrl === previousUrl) return;
  previousUrl = documentUrl;
  console.log(`viewerjs: Displaying HTML file '${documentUrl}'.`);
  let pane = document.querySelector("#content-pane");
  pane.innerHTML = "";
  setSearchTarget(null);
  const response = await fetch(documentUrl);
  const html = await response.text();
  if (previousUrl !== documentUrl) return;  // Another attachment was selected meanwhile.
  let frame = document.createElement("iframe");
  frame.className = "viewer-frame html-frame";
  frame.setAttribute("sandbox", "allow-same-origin allow-popups allow-popups-to-escape-sandbox");
  frame.setAttribute("referrerpolicy", "no-referrer");
  const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
  frame.srcdoc = html;
  pane.appendChild(frame);
  await loaded;
  if (previousUrl !== documentUrl) return;
  const doc = frame.contentDocument;
  if (!doc) return;
  // Highlight styles for search matches.
  let style = doc.createElement("style");
  style.textContent = HIGHLIGHT_CSS;
  (doc.head || doc.documentElement).appendChild(style);
  // Open links in a new tab instead of navigating inside the widget; keep in-page anchors.
  doc.addEventListener("click", (event) => {
    let link = event.target.closest && event.target.closest("a[href]");
    if (!link) return;
    let href = link.getAttribute("href");
    if (href.startsWith("#")) return;
    event.preventDefault();
    if (/^(https?:|mailto:)/i.test(link.href)) {
      window.open(link.href, "_blank", "noopener");
    }
  });
  doc.addEventListener("keydown", handleSearchShortcut);
  setSearchTarget(doc.body);
}

async function displayAttachment(attachmentId, mappedRecord) {
  setStatus("Loading...");
  setVisible("#viewer", false);
  // Get the URL and detect the file type.
  let documentUrl = await gristGetAttachmentURL(attachmentId);
  let fileType = await detectFileType(documentUrl);

  if (fileType === 'pdf') {
    await displayPdf(documentUrl, mappedRecord);
  } else if (fileType === 'odf') {
    displayOdf(documentUrl, mappedRecord);
  } else if (fileType === 'image') {
    displayImage(documentUrl, mappedRecord);
  } else if (fileType === 'html') {
    revealViewer();  // The frame must be visible to lay out (and search) its content.
    await displayHtml(documentUrl, mappedRecord);
  } else if (fileType === 'text') {
    await displayText(documentUrl, mappedRecord);
  } else {
    previousUrl = documentUrl;
    document.querySelector("#content-pane").innerHTML = "";
    showPane(null);
    setTitleBar("");
    setSearchTarget(null);
    setStatus(`Unsupported file type. <a href="${documentUrl}" target="_blank">Download attachment</a>`);
    setVisible("#viewer", false);
    return;
  }
  revealViewer();
}

// ---------------------------------------------------------------------------
// Search (text and HTML attachments; PDFs use pdf.js's own search bar)
// ---------------------------------------------------------------------------

const HIGHLIGHT_CSS = `
  mark.vj-hit { background: #ffe066; color: inherit; padding: 0; border-radius: 2px; }
  mark.vj-hit.vj-current { background: #ff9632; outline: 2px solid #ff9632; }
`;
const SEARCH_SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "MARK"]);

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Sets the element to search in (null hides the search bar).
function setSearchTarget(root) {
  clearHighlights();
  searchRoot = root;
  document.querySelector("#search-bar").style.display = root ? "flex" : "none";
  if (root) {
    let query = document.querySelector("#search-input").value;
    if (query) runSearch(query);
  }
  updateSearchCounter();
}

function clearHighlights() {
  let parents = new Set();
  for (const mark of searchHits) {
    let parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parents.add(parent);
  }
  for (const parent of parents) parent.normalize();
  searchHits = [];
  searchIndex = -1;
}

function runSearch(query) {
  clearHighlights();
  if (searchRoot && query) {
    const doc = searchRoot.ownerDocument;
    const re = new RegExp(escapeRegExp(query), "giu");
    const walker = doc.createTreeWalker(searchRoot, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        let parent = node.parentNode;
        if (!parent || SEARCH_SKIP_TAGS.has(parent.nodeName)) return NodeFilter.FILTER_REJECT;
        if (parent.checkVisibility && !parent.checkVisibility()) return NodeFilter.FILTER_REJECT;
        return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.nodeValue;
      let ranges = [];
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(text)) !== null) ranges.push([m.index, m[0].length]);
      let rest = node;
      let offset = 0;
      for (const [start, len] of ranges) {
        let matchNode = rest.splitText(start - offset);
        rest = matchNode.splitText(len);
        offset = start + len;
        let mark = doc.createElement("mark");
        mark.className = "vj-hit";
        matchNode.parentNode.replaceChild(mark, matchNode);
        mark.appendChild(matchNode);
        searchHits.push(mark);
      }
    }
  }
  if (searchHits.length > 0) {
    goToHit(0);
  } else {
    updateSearchCounter();
  }
}

function goToHit(index) {
  if (searchHits.length === 0) return;
  if (searchIndex >= 0 && searchHits[searchIndex]) searchHits[searchIndex].classList.remove("vj-current");
  searchIndex = (index + searchHits.length) % searchHits.length;
  let mark = searchHits[searchIndex];
  mark.classList.add("vj-current");
  mark.scrollIntoView({ block: "center", inline: "nearest" });
  updateSearchCounter();
}

function updateSearchCounter() {
  let query = document.querySelector("#search-input").value;
  let counter = document.querySelector("#search-count");
  if (!query) {
    counter.textContent = "";
  } else if (searchHits.length === 0) {
    counter.textContent = "No match";
  } else {
    counter.textContent = `${searchIndex + 1} / ${searchHits.length}`;
  }
  let noHits = searchHits.length === 0;
  document.querySelector("#search-prev").disabled = noHits;
  document.querySelector("#search-next").disabled = noHits;
}

// Ctrl+F / Cmd+F focuses the search box when a searchable document is shown.
function handleSearchShortcut(event) {
  if (!searchRoot) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
    event.preventDefault();
    let input = document.querySelector("#search-input");
    input.focus();
    input.select();
  }
}

function setupSearchBar() {
  let input = document.querySelector("#search-input");
  let debounceTimer = null;
  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runSearch(input.value), 200);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      clearTimeout(debounceTimer);
      if (searchHits.length === 0) {
        runSearch(input.value);
      } else {
        goToHit(searchIndex + (event.shiftKey ? -1 : 1));
      }
    } else if (event.key === "Escape") {
      input.value = "";
      clearTimeout(debounceTimer);
      runSearch("");
    }
  });
  document.querySelector("#search-prev").addEventListener("click", () => goToHit(searchIndex - 1));
  document.querySelector("#search-next").addEventListener("click", () => goToHit(searchIndex + 1));
  document.addEventListener("keydown", handleSearchShortcut);
  // Highlight styles for the text viewer (HTML frames get their own copy).
  let style = document.createElement("style");
  style.textContent = HIGHLIGHT_CSS;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Grist wiring
// ---------------------------------------------------------------------------

async function gristRecordSelected(record, mappedColNamesToRealColNames) {
  console.log("viewerjs: gristRecordSelected() with record, mappedColNamesToRealColNames:", record, mappedColNamesToRealColNames);
  setStatus("Loading...");
  setVisible("#viewer", false);
  try {
    // Unfortunately, Grist's mapColumnNames function doesn't handle optional column mappings
    // properly, so we need to map stuff ourselves.
    const mappedRecord = {}
    if (mappedColNamesToRealColNames) {
      for (const[mappedColName, realColName] of Object.entries(mappedColNamesToRealColNames)) {
        if (realColName in record) {
          mappedRecord[mappedColName] = record[realColName];
        }
      }
    }
    // Make sure all required columns have been mapped.
    if (!(ATTACHMENTID_COL_NAME in mappedRecord)) {
      let msg = "<b>Please map all columns first.</b>";
      console.error(`viewerjs: ${msg}`);
      throw new Error(msg);
    }
    // Parse the mapped attachment column into a list of attachment IDs (it may hold one or many).
    let attachmentIds = parseAttachmentIds(mappedRecord[ATTACHMENTID_COL_NAME]);
    if (attachmentIds.length === 0) {
      resetViewer("No attachment for this row.");
      return;
    }
    currentAttachmentIds = attachmentIds;
    currentAttachmentIndex = 0;
    currentMappedRecord = mappedRecord;
    updateNavBar();
    await displayAttachment(currentAttachmentIds[currentAttachmentIndex], mappedRecord);
  } catch(err) {
    return handleError(err);
  }
}

// Start once the DOM is ready.
ready(function(){
  // Set up a global error handler.
  window.addEventListener("error", function(err) {
    handleError(err);
  });
  // Let Grist know we're ready to talk.
  grist.ready({
    // We require "full" mode in order to be allowed access to attachments.
    requiredAccess: "full",
    columns: [
      { name: ATTACHMENTID_COL_NAME, type: "Any", title: "Attachment(s)", description: "A Grist Attachments column (holding one or more files), or a formula returning one or more attachment IDs." },
      { name: DEFAULTZOOM_COL_NAME, type: "Text,Choice", optional: true, title: "Default Zoom", description: `Default zoom mode for PDFs and ODF documents. Valid values are ${DEFAULTZOOM_ALLOWED_VALUES.map((x) => "'" + x + "'").join(", ")} ('page-fit' is PDF only). The default is 'auto'.` },
      { name: DOCTITLE_COL_NAME, type: "Text,Choice", optional: true, title: "Document Title", description: "Document title to display above the attachment." },
    ],
  });
  setupSearchBar();
  // Wire up the Prev/Next attachment navigation buttons.
  document.querySelector("#prev-attachment").addEventListener("click", function() {
    showAttachmentAt(currentAttachmentIndex - 1);
  });
  document.querySelector("#next-attachment").addEventListener("click", function() {
    showAttachmentAt(currentAttachmentIndex + 1);
  });
  // Register callback for when the user selects a record in Grist.
  grist.onRecord(gristRecordSelected);
  // When the linked set of records becomes empty (no matching rows), clear the viewer.
  grist.onRecords(function(records) {
    if (records.length === 0) {
      resetViewer("No attachment for this row.");
    }
  });
  console.log("viewerjs: Ready.");
});
