# ViewerJS Grist Widget
A simple [Grist](https://www.getgrist.com/) widget to view attachments directly in your browser:

| File type | Viewer | Search |
|---|---|---|
| PDF | [pdf.js](https://mozilla.github.io/pdf.js/) (Mozilla, Apache 2.0), bundled in `pdfjs/` | Built-in search bar (magnifier icon or Ctrl+F) |
| ODT / ODS / ODP | [viewerJS](https://viewerjs.org/), bundled in `ViewerJS/` | – |
| HTML | Sandboxed frame: scripts in the file never run, links open in a new tab | Search bar on top (Ctrl+F, Enter / Shift+Enter, Esc) |
| Text | Plain text | Search bar on top |
| Images | Image | – |

HTML attachments should be self-contained: images or stylesheets referenced by a *relative* path won't load (absolute `https://` URLs and inline/embedded content work).
PDF search only works on PDFs that contain text; scanned PDFs need OCR first.

To update pdf.js, download the latest `pdfjs-<version>-dist.zip` from https://github.com/mozilla/pdf.js/releases and replace the contents of `pdfjs/` (the `.map` files, the `debugger.*` files and the sample PDF can be deleted). Currently bundled: v6.5.438.


To use, create a custom widget in your Grist document and set its URL to `https://tomnitschke.github.io/gristwidgets/viewerjs`.  
You'll need to map an 'Integer' type column to it that provides the Grist attachment ID of the file to be displayed.  

How do you obtain an attachment ID? Supposing you have your attachments in a column 'documents', you could just add a formula column with type 'Integer' and put this into it:
```python
# Get the attachment ID of the first file in the 'documents' column.
# Use $documents.id[-1] if you want the last file instead.
return $documents.id[0]

# You could also consider all files added in the 'documents' column and filter them by filename:
for attachment in $documents:
  if attachment.fileName == "whichever_file_name_youre_looking_for.png":
    return attachment.id
# If we couldn't find the attachment we were looking for, raise an error.
raise ValueError("Requested attachment not found.")
```
Alternatively, you could look for a file by filename across *all* of your document's attachment columns. In that case, make a formula column like above but use this formula:
```python
def get_attachment_by_filename(filename)
  return _grist_Attachments.lookupOne(fileName=filename) or None

return get_attachment_by_filename("whichever_image_youre_looking_to_insert.jpg").id
```
