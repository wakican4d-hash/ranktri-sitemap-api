// Download XML string as a local file in the browser.
export function downloadXML(xmlString: string, filename = 'sitemap.xml'): void {
  const blob = new Blob([xmlString], { type: 'application/xml;charset=utf-8' });
  const blobUrl = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  URL.revokeObjectURL(blobUrl);
}

// Copy XML string to clipboard with fallback for older browsers.
export async function copyXML(xmlString: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(xmlString);
    return;
  }

  // Fallback approach when Clipboard API is unavailable.
  const textarea = document.createElement('textarea');
  textarea.value = xmlString;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';

  document.body.appendChild(textarea);
  textarea.select();

  try {
    const success = document.execCommand('copy');
    if (!success) {
      throw new Error('Failed to copy XML to clipboard');
    }
  } finally {
    document.body.removeChild(textarea);
  }
}
