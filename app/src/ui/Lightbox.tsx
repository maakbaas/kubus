import { useEffect, useState } from "react";
import { Modal } from "@carbon/react";
import { useStore } from "../app/store";
import { fileUrl } from "./images";

/**
 * The image lightbox: a click on any image marked `data-lightbox` (field images, images in
 * Markdown, component images, table and card thumbnails) shows it as large as the window allows,
 * in a Carbon modal (Escape, the close button or a click outside closes it). One for the app,
 * listening at the document: the click goes no further, so it doesn't also start editing the
 * field or open the item the image belongs to. Card covers and excerpts aren't marked or are
 * left out: there a click opens the item. A thumbnail (`data-file`: the stored file it shows
 * small) is replaced by the full-size image once that is loaded.
 */
export function Lightbox() {
  const { repo } = useStore();
  const [image, setImage] = useState<{ src: string; alt: string } | null>(null);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const img = (e.target as Element | null)?.closest?.<HTMLImageElement>("img[data-lightbox]");
      if (!img || img.closest(".item-card__cover, .md-view--excerpt") || !img.currentSrc) return;
      e.preventDefault();
      e.stopPropagation();
      setImage({ src: img.currentSrc, alt: img.alt });
      const fileId = img.dataset.file;
      if (fileId) {
        void fileUrl(repo, fileId).then((src) => src && setImage((shown) => (shown?.src === img.currentSrc ? { ...shown, src } : shown)));
      }
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [repo]);
  return (
    <Modal
      open={image !== null}
      passiveModal
      size="lg"
      className="lightbox"
      modalLabel={image?.alt || undefined}
      aria-label={image?.alt || "Image"}
      onRequestClose={() => setImage(null)}
      // Focus on the image, not the close button: its tooltip would take the first Escape.
      selectorPrimaryFocus=".lightbox__image"
    >
      {image && <img className="lightbox__image" src={image.src} alt={image.alt} tabIndex={-1} />}
    </Modal>
  );
}
