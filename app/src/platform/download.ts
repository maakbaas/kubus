// Platform adapter: handing the person a file. The web way (a blob link with `download`) also works
// in the Tauri window (WebView2 saves it to the Downloads folder), so no native plugin is needed.

/** Offers `bytes` as a file called `name` to save (the browser's download, or the desktop window's). */
export function downloadFile(name: string, bytes: Uint8Array<ArrayBuffer>, type = "application/octet-stream"): void {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  // The download has started by now; a browser that is slower to read the blob keeps it until the page closes.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
