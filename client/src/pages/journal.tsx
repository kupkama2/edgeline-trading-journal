import { useLayout } from "@/lib/layout";
import JournalV1 from "@/pages/journal-v1";
import JournalV2 from "@/pages/journal-v2";

/**
 * One address, two designs.
 *
 * The journal is the page you land on, so it keeps its URL whichever layout is
 * on — a bookmark, a link out of a trade and the back button all go to "the
 * journal", not to a version of it. Which one draws is a preference, switched
 * from the header, and both read the same data through the same hooks: no
 * trade is stored, filtered or computed differently between them.
 *
 * Both are loaded up front rather than split, because the switch is meant to
 * be flipped back and forth while you decide, and a spinner every time you
 * compare two layouts would be the thing you end up judging.
 */
export default function Journal() {
  const { version } = useLayout();
  return version === "v1" ? <JournalV1 /> : <JournalV2 />;
}
