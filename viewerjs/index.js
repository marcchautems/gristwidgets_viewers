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

const DEFAULTZOOM_ALLOWED_VALUES = ["auto", "page-actual", "page-width"];
let gristAccessToken = null;
let previousUrl = null;

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
  // Get a Grist access token if we don't already have one.
  if (!gristAccessToken) {
    console.log(`viewerjs: Getting new Grist access token.`);
    gristAccessToken = await grist.docApi.getAccessToken({ readOnly: true });
  }
  // Use the token to get a URL to the attachment.
  let url = `${gristAccessToken.baseUrl}/attachments/${attachmentId}/download?auth=${gristAccessToken.token}`;
  console.log(`viewerjs: Obtained Grist attachment URL: '${url}'`);
  return url;
}

async function detectFileType(url) {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    const contentType = response.headers.get('Content-Type') || '';
    if (contentType.includes('pdf')) return 'pdf';
    if (contentType.startsWith('image/')) return 'image';
    if (contentType.startsWith('text/')) return 'text';
    return 'unknown';
  } catch (e) {
    console.warn('viewerjs: Could not detect file type, defaulting to PDF viewer.', e);
    return 'pdf';
  }
}

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
    // If the attachment ID is empty/null, show a clear empty state.
    let attachmentId = mappedRecord[ATTACHMENTID_COL_NAME];
    if (!attachmentId) {
      previousUrl = null;
      document.querySelector("#viewer").innerHTML = "";
      setStatus("No attachment for this row.");
      setVisible("#viewer", false);
      return;
    }
    // Get the URL and detect the file type.
    let documentUrl = await gristGetAttachmentURL(attachmentId);
    let fileType = await detectFileType(documentUrl);
    let viewerElem = document.querySelector("#viewer");

    if (fileType === 'pdf') {
      let viewerBaseUrl = `${window.location.origin + window.location.pathname.slice(0, window.location.pathname.lastIndexOf('/'))}/ViewerJS/`;
      let viewerParams = [];
      if (DEFAULTZOOM_COL_NAME in mappedRecord) {
        let defaultZoomSetting = mappedRecord[DEFAULTZOOM_COL_NAME];
        if (!DEFAULTZOOM_ALLOWED_VALUES.includes(defaultZoomSetting)) {
          console.warn(`viewerjs: Supplied default zoom setting '${defaultZoomSetting}' is not valid. Valid values are:`, DEFAULTZOOM_ALLOWED_VALUES);
        } else {
          viewerParams.push(`zoom=${encodeURIComponent(defaultZoomSetting)}`);
        }
      }
      if (DOCTITLE_COL_NAME in mappedRecord) {
        viewerParams.push(`title=${encodeURIComponent(mappedRecord[DOCTITLE_COL_NAME])}`);
      }
      let viewerFullUrl = `${viewerBaseUrl}?${viewerParams.join("&")}#${documentUrl}`;
      if (viewerFullUrl !== previousUrl) {
        previousUrl = viewerFullUrl;
        console.log(`viewerjs: Setting PDF viewer URL to '${viewerFullUrl}'.`);
        viewerElem.innerHTML = "";
        let iframeElem = document.createElement("iframe");
        iframeElem.src = viewerFullUrl;
        iframeElem.className = "viewer-frame";
        iframeElem.setAttribute('allowFullScreen', '');
        viewerElem.appendChild(iframeElem);
      } else {
        console.log(`viewerjs: Not reloading the viewer as its URL hasn't changed.`);
      }
    } else if (fileType === 'image') {
      if (documentUrl !== previousUrl) {
        previousUrl = documentUrl;
        console.log(`viewerjs: Displaying image '${documentUrl}'.`);
        viewerElem.innerHTML = "";
        let wrapper = document.createElement("div");
        wrapper.className = "image-wrapper";
        let imgElem = document.createElement("img");
        imgElem.src = documentUrl;
        imgElem.className = "viewer-image";
        wrapper.appendChild(imgElem);
        viewerElem.appendChild(wrapper);
      }
    } else if (fileType === 'text') {
      if (documentUrl !== previousUrl) {
        previousUrl = documentUrl;
        console.log(`viewerjs: Displaying text file '${documentUrl}'.`);
        viewerElem.innerHTML = "";
        const response = await fetch(documentUrl);
        const text = await response.text();
        let preElem = document.createElement("pre");
        preElem.className = "viewer-text";
        preElem.textContent = text;
        viewerElem.appendChild(preElem);
      }
    } else {
      previousUrl = documentUrl;
      viewerElem.innerHTML = "";
      setStatus(`Unsupported file type. <a href="${documentUrl}" target="_blank">Download attachment</a>`);
      setVisible("#viewer", false);
      return;
    }
    setVisible("#viewer", true);
    setVisible("#status", false);
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
      { name: ATTACHMENTID_COL_NAME, type: "Int", title: "Attachment ID", description: "ID number of a Grist attachment." },
      { name: DEFAULTZOOM_COL_NAME, type: "Text,Choice", optional: true, title: "Default Zoom", description: `Default zoom mode. Valid values are ${DEFAULTZOOM_ALLOWED_VALUES.map((x) => "'" + x + "'").join(", ")}. The default is 'auto'.` },
      { name: DOCTITLE_COL_NAME, type: "Text,Choice", optional: true, title: "Document Title", description: "Document title to display in the header. If not provided, the URL will be shown instead." },
    ],
  });
  // Register callback for when the user selects a record in Grist.
  grist.onRecord(gristRecordSelected);
  // When the linked set of records becomes empty (no matching rows), clear the viewer.
  grist.onRecords(function(records) {
    if (records.length === 0) {
      previousUrl = null;
      document.querySelector("#viewer").innerHTML = "";
      setStatus("No attachment for this row.");
      setVisible("#viewer", false);
    }
  });
  console.log("viewerjs: Ready.");
});
