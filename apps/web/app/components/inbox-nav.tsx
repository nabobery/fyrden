import { Link } from "react-router";

/** The inbox's tabs, and the digests of watched repositories beside them. */
const INBOX_TABS = [
  { tab: "unread", label: "Unread", to: "/notifications" },
  { tab: "all", label: "All", to: "/notifications?tab=all" },
  { tab: "participating", label: "Participating", to: "/notifications?tab=participating" },
  { tab: "digests", label: "Digests", to: "/notifications/digests" },
] as const;

export type InboxTab = (typeof INBOX_TABS)[number]["tab"];

/** Shown while the deployment's allowance for watched activity ran out within the last week. */
export function DegradedNote() {
  return (
    <p className="muted" role="note">
      Activity in watched repositories may be missing: the deployment's allowance for it ran out
      within the last week.
    </p>
  );
}

export function InboxNav({ current }: { current: InboxTab }) {
  return (
    <nav aria-label="Inbox" className="row">
      {INBOX_TABS.map((t) => (
        <Link key={t.tab} to={t.to} aria-current={current === t.tab ? "page" : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
