import { useEffect, useRef, useState, type ReactNode } from "react";
import { FileUploaderDropContainer, FormGroup, IconButton, InlineLoading, InlineNotification } from "@carbon/react";
import { ImageReference, Renew, TrashCan } from "@carbon/icons-react";
import { useStore } from "../app/store";
import type { Repository } from "../data";
import { fileIdFromSrc } from "../domain/files";
import { errorMessage } from "./useConfirm";

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml"];
const MAX_BYTES = 20 * 1024 * 1024;

/** Validates and stores an image file; returns its file id. Throws a user-facing error. */
export async function storeImageFile(repo: Repository, file: File): Promise<string> {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error(`Unsupported image type: ${file.name}`);
  if (file.size > MAX_BYTES) throw new Error(`Images can be at most 20 MB: ${file.name}`);
  return repo.putFile(new Uint8Array(await file.arrayBuffer()), file.type);
}

// Item URLs per file id, shared by every component and the markdown editor for the
// whole session. Files are immutable (content-addressed), so a URL never goes stale,
// and reusing it means switching between view and edit never makes an image blink.
const loadedUrls = new Map<string, string>();
const pendingUrls = new Map<string, Promise<string | null>>();

/** Synchronous lookup: the URL if this file was already loaded. */
export const cachedFileUrl = (fileId: string) => loadedUrls.get(fileId);

/** Loads a stored file once per session and returns its item URL. */
export function fileUrl(repo: Repository, fileId: string): Promise<string | null> {
  const loaded = loadedUrls.get(fileId);
  if (loaded) return Promise.resolve(loaded);
  let pending = pendingUrls.get(fileId);
  if (!pending) {
    pending = repo.getFile(fileId).then((file) => {
      pendingUrls.delete(fileId);
      if (!file) return null;
      const url = URL.createObjectURL(new Blob([file.data as Uint8Array<ArrayBuffer>], { type: file.mime }));
      loadedUrls.set(fileId, url);
      return url;
    });
    pendingUrls.set(fileId, pending);
  }
  return pending;
}

// Data URLs per file id, for HTML frames: a sandboxed frame (its own, opaque origin) can't load
// the app's item URLs, so the images it refers to are embedded.
const dataUrls = new Map<string, Promise<string | null>>();

/** A stored file as a data URL (once per session). */
export function fileDataUrl(repo: Repository, fileId: string): Promise<string | null> {
  let pending = dataUrls.get(fileId);
  if (!pending) {
    pending = repo.getFile(fileId).then(
      (file) =>
        file &&
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(new Blob([file.data as Uint8Array<ArrayBuffer>], { type: file.mime }));
        }),
    );
    // A failed read isn't kept: a later use tries again.
    pending.catch(() => dataUrls.delete(fileId));
    dataUrls.set(fileId, pending);
  }
  return pending;
}

/** Item URL for a stored file (from the session cache when possible). */
export function useFileUrl(fileId: string | null): string | undefined {
  const { repo } = useStore();
  const [url, setUrl] = useState<string | undefined>(() => (fileId ? cachedFileUrl(fileId) : undefined));

  useEffect(() => {
    if (!fileId) return setUrl(undefined);
    const cached = cachedFileUrl(fileId);
    if (cached) return setUrl(cached);
    let cancelled = false;
    fileUrl(repo, fileId).then(
      (u) => !cancelled && setUrl(u ?? undefined),
      (e) => console.error("Loading file failed", e),
    );
    return () => {
      cancelled = true;
    };
  }, [repo, fileId]);

  return url;
}

export function ImageThumb({ fileId, alt }: { fileId: string; alt: string }) {
  const url = useFileUrl(fileId);
  // Its box while it loads, so the row and column don't change size when it arrives.
  return url ? <img className="image-thumb" src={url} alt={alt} data-lightbox /> : <span className="image-thumb" aria-hidden />;
}

interface Props {
  id: string;
  label: ReactNode;
  value: string;
  error?: string;
  onChange(fileId: string): void;
  /** Called for every stored file, so the editor can release unsaved ones. */
  onFileStored?(fileId: string): void;
}

export function ImageInput({ id, label, value, error, onChange, onFileStored }: Props) {
  const { repo } = useStore();
  const url = useFileUrl(value || null);
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string>();
  const replaceInput = useRef<HTMLInputElement>(null);

  async function add(file: File) {
    setUploadError(undefined);
    setBusy(true);
    try {
      const fileId = await storeImageFile(repo, file);
      onFileStored?.(fileId);
      onChange(fileId);
    } catch (e) {
      setUploadError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const message = uploadError ?? error;
  return (
    <FormGroup legendText={label} className="image-input">
      {value ? (
        // Replace / remove appear on the image's corner on hover (always on touch screens),
        // so they add no height and act in a single step.
        <div className="image-input__preview">
          {url && <img src={url} alt={typeof label === "string" ? label : ""} data-lightbox />}
          <div className="image-input__actions">
            <IconButton autoAlign kind="secondary" size="sm" align="bottom" label="Replace image" onClick={() => replaceInput.current?.click()}>
              <Renew />
            </IconButton>
            <IconButton autoAlign kind="secondary" size="sm" align="bottom" label="Remove image" onClick={() => onChange("")}>
              <TrashCan />
            </IconButton>
          </div>
          {/* Hidden native picker behind the Replace button. */}
          <input
            ref={replaceInput}
            type="file"
            accept={IMAGE_TYPES.join(",")}
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) add(file);
            }}
          />
        </div>
      ) : (
        <FileUploaderDropContainer
          id={id}
          accept={IMAGE_TYPES}
          labelText="Drag and drop an image here or click to upload"
          onAddFiles={(_, { addedFiles }) => {
            if (addedFiles[0]) add(addedFiles[0]);
          }}
        />
      )}
      {busy && <InlineLoading description="Storing image" />}
      {message && <InlineNotification kind="error" lowContrast hideCloseButton title={message} />}
    </FormGroup>
  );
}

/**
 * An image from a URL (a component's result). One that can't be loaded shows a placeholder the
 * size of the image upload box saying so (`compact`: a short note, for table cells and cards).
 */
export function UrlImage({ url, className, compact = false }: { url: string; className?: string; compact?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  // A stored image (`files/<sha256>`, e.g. an image field passed through a component).
  const fileId = fileIdFromSrc(url);
  const stored = useFileUrl(fileId);
  // In a cell: its box while it loads (as ImageThumb).
  if (fileId && !stored) return compact ? <span className={className} aria-hidden /> : null;
  if (failed) {
    return compact ? (
      <span className="image-missing image-missing--compact">Image not found</span>
    ) : (
      // A span (styled as a box): it may sit inside a Markdown paragraph.
      <span className="image-missing" title={url}>
        <ImageReference />
        <span>Image not found</span>
      </span>
    );
  }
  return <img className={className} src={stored ?? url} alt="" onError={() => setFailed(true)} data-lightbox />;
}
