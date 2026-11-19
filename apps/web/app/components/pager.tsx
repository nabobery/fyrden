import { Link } from "react-router";
import type { PageLinks } from "../lib/pages.js";

export function Pager({ links, label }: { links: PageLinks; label: string }) {
  if (!links.next && !links.first) return null;
  return (
    <nav className="pager" aria-label={`${label} pages`}>
      {links.first && <Link to={links.first}>First page</Link>}{" "}
      {links.next && <Link to={links.next}>Next page</Link>}
    </nav>
  );
}
