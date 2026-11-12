import { assetName } from "@fyrden/domain";
import { useEffect, useId, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import {
  abandonUpload,
  holdsSession,
  newUpload,
  runUpload,
  type Upload,
  type UploadDeps,
  type UploadResult,
} from "../lib/asset-upload.js";
import { assetDownload, formatBytes, type Release } from "../lib/releases.js";

/**
 * A release's assets, each linked to its download on this site: the web route by tag and
 * name, which a plain link can follow with the session, never the API's own URL.
 */
export function AssetsTable({
  owner,
  repo,
  release,
}: {
  owner: string;
  repo: string;
  release: Pick<Release, "tag_name" | "assets">;
}) {
  if (release.assets.length === 0) return <p className="muted">No assets.</p>;
  return (
    <table aria-label="Assets">
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Size</th>
        </tr>
      </thead>
      <tbody>
        {release.assets.map((asset) => (
          <tr key={asset.id}>
            <td>
              <a href={assetDownload(owner, repo, release.tag_name, asset.name)}>{asset.name}</a>
            </td>
            <td title={`${asset.size} bytes`}>{formatBytes(asset.size)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type Item = {
  readonly key: number;
  readonly upload: Upload;
  status: "confirm" | "sending" | "completing" | "cancelling" | "done" | "failed" | "cancelled";
  sent: number;
  message: string;
  /** Whether Retry goes on from where it stopped (else it must start again). */
  retryable: boolean;
  stop: AbortController | null;
  /** The ending asked for as the page was left while it ran: what its run then reports. */
  leaving: Promise<UploadResult> | null;
};

const BROWSER: UploadDeps = {
  fetch: (input, init) => globalThis.fetch(input, init),
  wait: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Cancelled", "AbortError"));
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new DOMException("Cancelled", "AbortError"));
        },
        { once: true },
      );
    }),
  newKey: () => crypto.randomUUID(),
};

/** How names compare: as the API compares them, else as given. */
const foldOf = (name: string) => {
  const checked = assetName(name);
  return checked.ok ? checked.fold : name.normalize("NFC").toLowerCase();
};

/**
 * Adds files to a release: each sent in parts from this page, two at a time, with its
 * progress, Retry when it stopped and Cancel. A file named as an asset already there asks
 * first, since the old file then stays on the account's quota. Needs the page's script: a
 * reload loses what was sent, and the upload starts again.
 */
export function AssetUploader({
  owner,
  repo,
  release,
}: {
  owner: string;
  repo: string;
  release: Pick<Release, "id" | "assets">;
}) {
  const inputId = useId();
  const [ready, setReady] = useState(false);
  // Each upload changes as it goes; the page draws them again on each change.
  const items = useRef(new Map<number, Item>());
  const [, setDrawn] = useState(0);
  const [said, setSaid] = useState("");
  const counter = useRef(0);
  const { revalidate } = useRevalidator();
  // biome-ignore lint/correctness/useExhaustiveDependencies: set up once for the page's life; `settle` uses only the items' refs, the state's setters and the router's revalidate, none of them tied to a render.
  useEffect(() => {
    setReady(true);
    const all = items.current;
    // Leaving the page, by a link within it or by a reload or another site, ends every session
    // still open, which would otherwise hold the file's size on the quota until it expires.
    // Each is ended here, at once (its request outlives the page), then a running upload stops
    // and reports what that ending came to. A page kept to come back to (the back-forward
    // cache) shows the others' outcomes too; one taken off by the app has no one to show.
    const endAll = (shown: boolean) => {
      for (const item of all.values()) {
        // A lost start's session (see `holdsSession`) is ended only by a page that stays: one
        // being unloaded would run nothing to end what asking the start again finds.
        const ending =
          item.status !== "done" &&
          (shown ? item.upload.session !== null : holdsSession(item.upload))
            ? abandonUpload(item.upload, BROWSER)
            : null;
        if (item.stop) {
          item.leaving = ending;
          // Until that ending is known, nothing else starts or ends this upload.
          item.status = "cancelling";
          item.stop.abort();
        } else if (ending && shown) void ending.then((result) => settle(item, result));
      }
      if (shown) changed();
    };
    // A page being unloaded runs no cleanup.
    const unloading = () => endAll(true);
    window.addEventListener("pagehide", unloading);
    return () => {
      window.removeEventListener("pagehide", unloading);
      endAll(false);
    };
  }, []);

  const changed = () => setDrawn((n) => n + 1);

  /** Shows how `item` ended, and draws the release's assets again if any may have changed. */
  const settle = (item: Item, result: UploadResult) => {
    if (result.ok) {
      item.status = "done";
      item.sent = item.upload.file.size;
      setSaid(`${item.upload.name} uploaded.`);
    } else {
      item.status = result.kind === "cancelled" ? "cancelled" : "failed";
      item.retryable = result.kind === "retryable";
      item.message = result.message;
      setSaid(
        result.kind === "cancelled"
          ? `${item.upload.name} cancelled.`
          : `${item.upload.name} stopped: ${result.message}`,
      );
    }
    // Only Retry goes on from a stop; anything else may have kept or replaced an asset.
    if (result.ok || result.kind !== "retryable") void revalidate();
    changed();
  };

  const run = async (item: Item) => {
    // Once at a time, and never while a Cancel is ending its session.
    if (item.stop !== null || item.status === "cancelling") return;
    const stop = new AbortController();
    item.stop = stop;
    item.status = "sending";
    item.message = "";
    changed();
    setSaid(`Uploading ${item.upload.name}.`);
    let result: UploadResult;
    try {
      result = await runUpload(item.upload, BROWSER, {
        signal: stop.signal,
        onProgress: (progress) => {
          item.sent = progress.sent;
          if (item.status !== "cancelling") item.status = progress.state;
          changed();
        },
      });
    } catch (error) {
      result = { ok: false, kind: "retryable", message: String(error) };
    } finally {
      item.stop = null;
    }
    // Stopped by leaving the page: what the ending came to, which may have kept the asset or
    // not be known, rather than merely cancelled.
    if (item.leaving && !result.ok) result = await item.leaving;
    item.leaving = null;
    settle(item, result);
  };

  const add = (files: FileList | null) => {
    const taken = new Set(release.assets.map((asset) => foldOf(asset.name)));
    const added: Item[] = [];
    for (const file of files ?? []) {
      const replace = taken.has(foldOf(file.name));
      added.push({
        key: ++counter.current,
        upload: newUpload({ owner, repo, releaseId: release.id }, file, { replace }),
        status: replace ? "confirm" : "sending",
        sent: 0,
        message: "",
        retryable: true,
        stop: null,
        leaving: null,
      });
    }
    for (const item of added) items.current.set(item.key, item);
    changed();
    for (const item of added) if (item.status !== "confirm") void run(item);
  };

  const remove = (item: Item) => {
    items.current.delete(item.key);
    changed();
  };

  /** Takes a stopped upload off the page; an ending not confirmed is asked once more first. */
  const dismiss = (item: Item) => {
    if (item.status === "failed" && holdsSession(item.upload))
      void abandonUpload(item.upload, BROWSER);
    remove(item);
  };

  const cancel = async (item: Item) => {
    if (item.status === "cancelling") return;
    item.status = "cancelling";
    changed();
    setSaid(`Cancelling ${item.upload.name}.`);
    // A running upload ends its own session as it stops (see `run`).
    if (item.stop) {
      item.stop.abort();
      return;
    }
    const result = await abandonUpload(item.upload, BROWSER);
    if (result.ok === false && result.kind === "cancelled") {
      remove(item);
      setSaid(`${item.upload.name} cancelled.`);
      void revalidate();
      return;
    }
    settle(item, result);
  };

  return (
    <section aria-labelledby={`${inputId}-heading`}>
      <h3 id={`${inputId}-heading`}>Upload assets</h3>
      <noscript>
        <p>
          Uploading from this page needs JavaScript. Without it, use the API: start a session with{" "}
          <code>{`POST /api/repos/${owner}/${repo}/releases/${release.id}/assets/uploads`}</code>,
          send each part to its <code>parts_url</code>, then complete it.
        </p>
      </noscript>
      <p className="row">
        <label htmlFor={inputId}>Add files</label>
        <input
          id={inputId}
          type="file"
          multiple
          disabled={!ready}
          onChange={(event) => {
            add(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
        />
      </p>
      <p className="muted">
        A reload while uploading stops the upload; it starts again from the beginning.
      </p>
      <p className="visually-hidden" role="status" aria-live="polite">
        {said}
      </p>
      {items.current.size > 0 && (
        <ul className="label-list" aria-label="Uploads">
          {[...items.current.values()].map((item) => (
            <li key={item.key} className="panel">
              <p>
                <strong>{item.upload.name}</strong>{" "}
                <span className="muted">{formatBytes(item.upload.file.size)}</span>
              </p>
              {item.status === "confirm" ? (
                <>
                  <p className="notice">
                    An asset named {item.upload.name} is already here. Replacing it keeps the old
                    file on the account's storage quota for 30 days, unless an admin purges it
                    sooner.
                  </p>
                  <p className="row">
                    <button type="button" className="primary" onClick={() => void run(item)}>
                      {`Replace ${item.upload.name}`}
                    </button>
                    <button type="button" onClick={() => remove(item)}>
                      Skip
                    </button>
                  </p>
                </>
              ) : (
                <>
                  <progress
                    value={item.sent}
                    max={item.upload.file.size}
                    aria-label={`${item.upload.name}, sent`}
                  />
                  <p className={item.status === "failed" ? "error" : "muted"}>{statusText(item)}</p>
                  <p className="row">
                    {item.status === "failed" && item.retryable && (
                      <button type="button" onClick={() => void run(item)}>
                        Retry
                      </button>
                    )}
                    {(item.status === "sending" ||
                      item.status === "completing" ||
                      // Stopped with its session open, or whose ending wasn't confirmed.
                      (item.status === "failed" &&
                        (item.retryable || holdsSession(item.upload)))) && (
                      <button type="button" onClick={() => void cancel(item)}>
                        Cancel
                      </button>
                    )}
                    {(item.status === "done" ||
                      item.status === "cancelled" ||
                      (item.status === "failed" && !item.retryable)) && (
                      <button type="button" onClick={() => dismiss(item)}>
                        Dismiss
                      </button>
                    )}
                  </p>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function statusText(item: Item): string {
  switch (item.status) {
    case "sending":
      return `Sending: ${formatBytes(item.sent)} of ${formatBytes(item.upload.file.size)}.`;
    case "completing":
      return "Putting it together…";
    case "cancelling":
      return "Cancelling…";
    case "done":
      return "Uploaded.";
    case "cancelled":
      return "Cancelled.";
    case "failed":
      return item.message;
    default:
      return "";
  }
}
