/**
 * session-video-intake — Client half.
 *
 * The Desktop bridge gives native non-image Files a host path, which makes the
 * core insert a reference. A new File wrapping the original Blob keeps its
 * bytes and metadata, but has no Electron host path, so core uploads it as a
 * generic file attachment. No decoding, byte reads, or upload API are needed.
 *
 * Compatibility seam: the core document drop listener accepts synthetic events
 * with a DataTransfer containing "Files" (no isTrusted check). The picker has
 * no identifying data attribute and CSS Module class names change between DSH
 * builds, so it is located by stable structure only: a hidden multiple
 * `input[type=file][accept=""]` inside `[data-composer-card]`, sitting between
 * the composer's commands button and its modes container. A picker change then
 * takes the same pathless-upload path as a drop, so Desktop `+` selections no
 * longer become `@path` text references. Any changed structure is left to the
 * original core flow.
 */
window.__ModuleLoader__.load({
  id: '@redheartsecretman/session-video-intake',
  factory() {
    // Browser bundle cannot import lib/media-input.js; keep this list in sync.
    const VIDEO_EXT = /\.(mp4|webm|mov|mkv|m4v|avi|ts|mts|m2ts|flv|3gp|ogv)$/i;
    const NON_VIDEO_MIME = /^(image|audio|text)\//i;
    // Prefer the browser's declared MIME type; fall back to the extension list
    // for files whose type is empty or generic (common for .ts/.mts/.m2ts).
    const isVideo = (file) => file instanceof File
      && !NON_VIDEO_MIME.test(file.type)
      && (file.type.startsWith('video/') || VIDEO_EXT.test(file.name));

    function composerPicker(input) {
      if (!(input instanceof HTMLInputElement) || input.type !== 'file'
        || !input.hidden || !input.multiple || input.disabled || input.accept !== '') return false;
      const tools = input.parentElement;
      const row = tools?.parentElement;
      const card = row?.parentElement;
      if (tools === null || row === null || card === null) return false;
      // Core puts its input between the commands button and the modes
      // container, before the conversation.input.left slot. Never match other
      // inputs in that slot, inside an overlay, or deeper in a wrapper.
      return card.matches('[data-composer-card]') === true
        && input.closest('[data-composer-overlay]') === null
        && tools.children[1] === input
        && input.previousElementSibling?.matches('button') === true
        && input.nextElementSibling?.tagName === 'DIV';
    }

    function composerPasteTarget(target) {
      if (!(target instanceof Element)) return false;
      const editor = target.closest('[data-composer-input][data-lexical-editor="true"]');
      return editor !== null && editor.closest('[data-composer-card]') !== null
        && target.closest('[data-composer-overlay]') === null;
    }

    function replacementTransfer(files, source) {
      const transfer = new DataTransfer();
      const originals = Array.from(source?.items || []).filter((item) => item.kind === 'file');
      for (const [index, original] of files.entries()) {
        const entry = originals[index]?.webkitGetAsEntry?.();
        // A directory named e.g. movies.mp4 must retain its directory identity.
        const file = entry?.isDirectory === true || !isVideo(original) ? original
          : new File([original], original.name, {
            type: original.type,
            lastModified: original.lastModified,
          });
        const item = transfer.items.add(file);
        if (item === null) throw new Error(`Could not transfer file: ${original.name}`);
        if (entry?.isDirectory === true) {
          // Core's droppedDirectories reads this entry API from the transfer.
          // DataTransfer.items.add alone would erase the directory flag.
          Object.defineProperty(item, 'webkitGetAsEntry', { value: () => entry });
        }
      }
      for (const type of source?.types || []) {
        if (type !== 'Files') transfer.setData(type, source.getData(type));
      }
      return transfer;
    }

    return {
      apply(ctx) {
        ctx.effect(() => {
          const forwarded = new WeakSet();

          function forward(event, files, source, paste = false) {
            if (forwarded.has(event) || event.defaultPrevented
              || (!event.cancelable && event.type !== 'change') || !files.some(isVideo)) return;
            try {
              const transfer = replacementTransfer(files, source);
              // Preserve clipboard text/HTML and let the composer's existing
              // paste command consume files and text together, in one event.
              const replacement = paste
                ? new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })
                : new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer });
              forwarded.add(replacement);
              const target = paste || event.type === 'drop' ? event.target : document;
              target.dispatchEvent(replacement);
              // Core drop and file-paste consumers both preventDefault. If no
              // consumer exists, keep the original event and report the seam.
              if (!replacement.defaultPrevented) {
                throw new Error('DSH composer did not consume the forwarded video event');
              }
            } catch (error) {
              console.error('[session-video-intake] Could not forward video; original input remains available:', error);
              return;
            }
            // All fallible preparation and dispatch finish before suppressing
            // the original, so a failure cannot silently discard its files.
            event.preventDefault();
            event.stopImmediatePropagation();
            if (event.type === 'change') event.target.value = '';
          }

          const onDrop = (event) => {
            if (forwarded.has(event) || !composerPasteTarget(event.target)) return;
            const transfer = event.dataTransfer;
            if (transfer === null || transfer === undefined || !transfer.types.includes('Files')) return;
            forward(event, Array.from(transfer.files), transfer);
          };
          const onPaste = (event) => {
            if (forwarded.has(event) || !composerPasteTarget(event.target)) return;
            const transfer = event.clipboardData;
            if (transfer !== null && transfer !== undefined) {
              forward(event, Array.from(transfer.files), transfer, true);
            }
          };
          const onChange = (event) => {
            if (!composerPicker(event.target)) return;
            forward(event, Array.from(event.target.files || []));
          };

          window.addEventListener('drop', onDrop, true);
          window.addEventListener('paste', onPaste, true);
          window.addEventListener('change', onChange, true);
          return () => {
            window.removeEventListener('drop', onDrop, true);
            window.removeEventListener('paste', onPaste, true);
            window.removeEventListener('change', onChange, true);
          };
        }, 'session-video-intake: original-byte attachment intake');
      },
    };
  },
});
