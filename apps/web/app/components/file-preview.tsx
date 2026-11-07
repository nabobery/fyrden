import { useEffect, useRef, useState } from "react";

interface Image {
  src: string;
  alt: string;
  width: number | null;
  height: number | null;
}

/**
 * A file as an image. Failing shows a message in its place; Raw stays on the
 * page around it. Without JavaScript a failed image shows its `alt`. Keyed by
 * `src`, so a navigation to a file, even one that failed before, tries afresh.
 */
export function FilePreview(image: Image) {
  return <Attempt key={image.src} {...image} />;
}

function Attempt({ src, alt, width, height }: Image) {
  const shown = useRef<HTMLImageElement>(null);
  const [failed, setFailed] = useState(false);
  // An image that failed before the page hydrated: React neither replays its
  // `error` event nor checks the image when it hydrates.
  useEffect(() => {
    if (shown.current?.complete && shown.current.naturalWidth === 0) setFailed(true);
  }, []);
  if (failed) return <p className="muted">This image can't be previewed.</p>;
  return (
    <div className="panel file-preview">
      <img
        ref={shown}
        src={src}
        alt={alt}
        {...(width !== null && { width })}
        {...(height !== null && { height })}
        onError={() => setFailed(true)}
      />
    </div>
  );
}
