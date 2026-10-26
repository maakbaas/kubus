import sansRegular from "@ibm/plex-sans/fonts/complete/woff2/IBMPlexSans-Regular.woff2?url";
import sansItalic from "@ibm/plex-sans/fonts/complete/woff2/IBMPlexSans-Italic.woff2?url";
import sansSemiBold from "@ibm/plex-sans/fonts/complete/woff2/IBMPlexSans-SemiBold.woff2?url";
import sansSemiBoldItalic from "@ibm/plex-sans/fonts/complete/woff2/IBMPlexSans-SemiBoldItalic.woff2?url";
import monoRegular from "@ibm/plex-mono/fonts/complete/woff2/IBMPlexMono-Regular.woff2?url";
import monoItalic from "@ibm/plex-mono/fonts/complete/woff2/IBMPlexMono-Italic.woff2?url";
import monoSemiBold from "@ibm/plex-mono/fonts/complete/woff2/IBMPlexMono-SemiBold.woff2?url";

/** One font face for a frame: its descriptors and the font file's bytes. */
export interface FrameFont {
  family: string;
  style: "normal" | "italic";
  weight: string;
  data: ArrayBuffer;
}

/**
 * The faces rendered Markdown uses (body text, bold, italic, bold italic, code), the same files
 * as fonts.css. A sandboxed HTML frame is a document of its own in an opaque origin: the page's
 * @font-face rules don't reach it and it can't load the app's font files, so the page hands it
 * the bytes (HtmlFrame) and the frame registers them (FontFace). Bytes, not data URLs in the
 * frame's HTML: no base64 to build, parse and keep per frame.
 */
const FACES = [
  { family: "IBM Plex Sans", style: "normal", weight: "400", url: sansRegular },
  { family: "IBM Plex Sans", style: "italic", weight: "400", url: sansItalic },
  { family: "IBM Plex Sans", style: "normal", weight: "600", url: sansSemiBold },
  { family: "IBM Plex Sans", style: "italic", weight: "600", url: sansSemiBoldItalic },
  { family: "IBM Plex Mono", style: "normal", weight: "400", url: monoRegular },
  { family: "IBM Plex Mono", style: "italic", weight: "400", url: monoItalic },
  { family: "IBM Plex Mono", style: "normal", weight: "600", url: monoSemiBold },
] as const;

let loading: Promise<FrameFont[]> | null = null;

/** The frame fonts, fetched once per session (the page has these files already: a cache hit). */
export function frameFonts(): Promise<FrameFont[]> {
  loading ??= Promise.all(
    FACES.map(async ({ url, ...face }) => ({ ...face, data: await (await fetch(url)).arrayBuffer() })),
  ).catch((e) => {
    // Without them a frame shows the system's fonts; tried again by the next frame.
    loading = null;
    console.error("Loading the fonts for HTML frames failed", e);
    return [];
  });
  return loading;
}
